import { parseSourceMutationPlanV1, parseTaskRepo, parseTaskSnapshotV1, type SourceAbortRequestV1, type SourceCallContextV1, type SourceCompletionRequestV1, type SourceInstanceV1, type SourceMutationPlanV1, type TaskSnapshotV1 } from '../../../src/plugins/tasks';
import { persistedJson, persistenceHash, stableJson, PersistenceConflictError } from '../persistence';
import type { LocalSourceAdapter } from './local-records';
import type { SourceResolutionPurpose, TaskSourceRegistry } from './registry';
import { readTaskSource, type StoredTaskSnapshot, type TaskSourceStore, type WorkClaimRecord } from './store';

export type SourceContextFactory = (instance: SourceInstanceV1, repo: string, signal: AbortSignal, purpose: SourceResolutionPurpose) => SourceCallContextV1;
export interface PreparedSourceClaim { readonly claim: WorkClaimRecord; readonly task: TaskSnapshotV1; readonly plan: SourceMutationPlanV1; readonly repo: string }
export interface PreparedSourceSettlement { readonly claim: WorkClaimRecord; readonly plan: SourceMutationPlanV1; readonly purpose: 'completion' | 'abort'; readonly request: SourceCompletionRequestV1 | SourceAbortRequestV1; readonly repo: string; readonly requestHash: string; readonly settlementId: string }
export interface SourceOperationBridge {
  prepare(input: { claim: WorkClaimRecord; task: StoredTaskSnapshot; plan: Extract<SourceMutationPlanV1, { kind: 'remote-effects' }>; purpose: 'claim' | 'completion' | 'abort'; requestHash: string; attempt?: number }): void;
  hasClaimPlan?(claimId: string): boolean;
  claimSteps?(claimId: string): SourceAbortRequestV1['claimSteps'];
  fenceUnsentClaim?(claimId: string): SourceAbortRequestV1['claimSteps'];
  acknowledged(input: { claimId: string; purpose: 'claim' | 'completion' | 'abort'; requestHash: string }): { ready: boolean; operations: NonNullable<WorkClaimRecord['receipt']>['operations']; blocked: boolean };
}
export function createSourceAdmissionCoordinator(options: { store: TaskSourceStore; registry: TaskSourceRegistry; local: LocalSourceAdapter; context: SourceContextFactory; effects?: SourceOperationBridge; pins?: { retain(claim: WorkClaimRecord): void; release(claim: WorkClaimRecord): void } }) {
  const { store, registry, local } = options;
  const preparedClaims = new WeakSet<PreparedSourceClaim>(); const preparedSettlements = new WeakSet<PreparedSourceSettlement>();
  function required(id: string): WorkClaimRecord { const claim = store.claim(id); if (!claim) throw new PersistenceConflictError('Source claim is unavailable'); return claim; }
  function current(claim: WorkClaimRecord, repo: string, purpose: SourceResolutionPurpose): void {
    parseTaskRepo(repo); if (!claim.instance.allowedRepos.includes(repo)) throw new PersistenceConflictError('Source claim galleon is unauthorized');
    registry.resolve(claim.instance, purpose);
    if (purpose === 'admission') {
      const source = readTaskSource(store, claim.ref.sourceId); const instance = store.instance(claim.instance.id);
      if (!instance || !instance.desiredEnabled || instance.revision !== claim.instance.revision || source.revision !== claim.sourceRevision || !source.conversionReady) throw new PersistenceConflictError('Source admission configuration changed');
      store.assertUnquarantined(claim.ref);
    }
  }
  return {
    reserve(input: Parameters<TaskSourceStore['reserveWork']>[0] & { repo: string }, reserveAdmission: () => void): WorkClaimRecord {
      return store.persistence.transaction(() => {
        const instance = store.instance(input.instanceId); if (!instance || !instance.allowedRepos.includes(input.repo)) throw new PersistenceConflictError('Source admission scope is unavailable');
        registry.resolve(instance, 'admission'); reserveAdmission(); const claim = store.reserveWork(input); options.pins?.retain(claim); return claim;
      });
    },
    async prepare(input: { claimId: string; repo: string; signal: AbortSignal; retryOf?: string | null }): Promise<PreparedSourceClaim> {
      input.signal.throwIfAborted(); const claim = required(input.claimId); current(claim, input.repo, 'admission');
      if (input.retryOf !== undefined && input.retryOf !== (claim.retryOf ?? null)) throw new PersistenceConflictError('Source retry owner differs from its reservation');
      if (claim.state !== 'reserved') throw new PersistenceConflictError('Source claim is already prepared');
      const registration = registry.resolve(claim.instance, 'admission'); const context = options.context(claim.instance, input.repo, input.signal, 'admission');
      const loaded = await registration.provider.load(claim.ref, context); input.signal.throwIfAborted(); current(claim, input.repo, 'admission');
      const task = parseTaskSnapshotV1(loaded, { sourceId: claim.ref.sourceId, repo: input.repo });
      if (task.ref.externalId !== claim.ref.externalId) throw new PersistenceConflictError('Source returned another work item'); store.assertUnquarantined(claim.ref, task.displayKey);
      const plan = parseSourceMutationPlanV1(await registration.provider.planClaim({ admissionId: claim.admissionId, runId: claim.runId, task, expectedInstanceRevision: claim.instance.revision, retryOf: claim.retryOf ?? null }, context), { ref: claim.ref, repo: input.repo, effectIds: registration.declaration.effectIds });
      input.signal.throwIfAborted(); current(claim, input.repo, 'admission');
      const prepared = Object.freeze({ claim, task, plan, repo: input.repo }); preparedClaims.add(prepared); return prepared;
    },
    commit<T>(prepared: PreparedSourceClaim, commitAdmission: (claim: WorkClaimRecord, task: StoredTaskSnapshot) => T): T {
      if (!preparedClaims.has(prepared)) throw new PersistenceConflictError('Source claim was not prepared by this coordinator');
      return store.persistence.transaction(() => {
        const claim = required(prepared.claim.id); if (claim.revision !== prepared.claim.revision) throw new PersistenceConflictError('Source claim preparation is stale'); current(claim, prepared.repo, 'admission');
        const snapshot = store.retainTaskSnapshot(prepared.task, claim.instance);
        if (prepared.plan.kind === 'remote-effects') {
          if (!options.effects) throw new PersistenceConflictError('Remote source operation coordinator is unavailable');
          throw new PersistenceConflictError('Use stageRemoteClaim before awaiting remote acknowledgment');
        }
        const record = readTaskSource(store, claim.ref.sourceId).storageLayout === 'remote' && prepared.plan.kind === 'none' ? null : local.applyMutation({ claim, plan: prepared.plan, purpose: 'claim' });
        const acknowledged = store.acknowledgeClaim({ claimId: claim.id, expectedRevision: claim.revision, taskSnapshotHash: snapshot.hash, localRecordRevision: record?.revision ?? null, operations: [] });
        return commitAdmission(acknowledged, snapshot);
      });
    },
    stageRemoteClaim(prepared: PreparedSourceClaim): StoredTaskSnapshot {
      if (!preparedClaims.has(prepared) || prepared.plan.kind !== 'remote-effects' || !options.effects) throw new PersistenceConflictError('Remote source claim was not prepared');
      return store.persistence.transaction(() => {
        const claim = required(prepared.claim.id); if (claim.revision !== prepared.claim.revision) throw new PersistenceConflictError('Source claim preparation is stale'); current(claim, prepared.repo, 'admission');
        const snapshot = store.retainTaskSnapshot(prepared.task, claim.instance);
        options.effects!.prepare({ claim, task: snapshot, plan: prepared.plan as Extract<SourceMutationPlanV1, { kind: 'remote-effects' }>, purpose: 'claim', requestHash: claim.admissionId }); return snapshot;
      });
    },
    commitRemoteClaim<T>(input: { claimId: string; taskSnapshotHash: string }, commitAdmission: (claim: WorkClaimRecord, task: StoredTaskSnapshot) => T): T {
      return store.persistence.transaction(() => {
        const claim = required(input.claimId); const snapshot = store.taskSnapshot(input.taskSnapshotHash); if (!snapshot) throw new PersistenceConflictError('Source task snapshot unavailable'); current(claim, snapshot.task.repo, 'admission');
        const result = options.effects?.acknowledged({ claimId: claim.id, purpose: 'claim', requestHash: claim.admissionId });
        if (!result?.ready) throw new PersistenceConflictError('Remote source claim is not acknowledged');
        const acknowledged = store.acknowledgeClaim({ claimId: claim.id, expectedRevision: claim.revision, taskSnapshotHash: snapshot.hash, localRecordRevision: null, operations: result.operations }); return commitAdmission(acknowledged, snapshot);
      });
    },
    cancelReserved<T>(input: { claimId: string; reason: string }, finalize: (claim: WorkClaimRecord) => T): T {
      return store.persistence.transaction(() => {
        const claim = required(input.claimId);
        if (claim.state === 'settled' && claim.settlement?.disposition === 'released') return finalize(claim);
        if (claim.state !== 'reserved' || claim.receipt || options.effects?.hasClaimPlan?.(claim.id)) throw new PersistenceConflictError('Source claim requires explicit settlement');
        const settling = store.beginSettlement(claim.id, claim.revision);
        const settled = store.settleWork({ claimId: claim.id, expectedRevision: settling.revision, disposition: 'released', reason: input.reason, localRecordRevision: null, operations: [] });
        options.pins?.release(settled); return finalize(settled);
      });
    },
    stageRemoteSettlement(prepared: PreparedSourceSettlement): void {
      if (!preparedSettlements.has(prepared) || prepared.plan.kind !== 'remote-effects' || !options.effects) throw new PersistenceConflictError('Remote source settlement was not prepared');
      store.persistence.transaction(() => {
        const claim = required(prepared.claim.id); if (claim.revision !== prepared.claim.revision || claim.state !== 'settling') throw new PersistenceConflictError('Source settlement preparation changed');
        current(claim, prepared.repo, 'obligation');
        const snapshot = claim.taskSnapshotHash ? store.taskSnapshot(claim.taskSnapshotHash) : store.retainTaskSnapshot(prepared.request.task, claim.instance);
        if (!snapshot) throw new PersistenceConflictError('Source settlement task snapshot is missing');
        options.effects!.prepare({ claim, task: snapshot, plan: prepared.plan as Extract<SourceMutationPlanV1, { kind: 'remote-effects' }>, purpose: prepared.purpose, requestHash: prepared.requestHash, attempt: prepared.purpose === 'completion' ? (prepared.request as SourceCompletionRequestV1).attempt : 1 });
        store.persistence.sql.prepare('UPDATE source_settlements SET json=? WHERE id=?').run(stableJson({ claimId: claim.id, purpose: prepared.purpose, request: prepared.request, state: 'staged', requestHash: prepared.requestHash }), prepared.settlementId);
      });
    },
    commitRemoteSettlement<T>(input: { claimId: string; purpose: 'completion' | 'abort'; requestHash: string }, finalize: (claim: WorkClaimRecord) => T): T {
      return store.persistence.transaction(() => {
        const claim = required(input.claimId); if (claim.state === 'settled') return finalize(claim);
        if (claim.state !== 'settling') throw new PersistenceConflictError('Remote source settlement was not requested');
        const result = options.effects?.acknowledged(input);
        if (!result?.ready && !result?.blocked) throw new PersistenceConflictError('Remote source settlement is pending');
        const settled = store.settleWork({ claimId: claim.id, expectedRevision: claim.revision, disposition: result.ready ? input.purpose === 'abort' ? 'released' : 'completed' : 'retained-for-operator', reason: result.ready ? input.purpose : 'Source effect requires operator settlement', localRecordRevision: null, operations: result.operations });
        if (settled.state === 'settled') options.pins?.release(settled); return finalize(settled);
      });
    },
    async prepareSettlement(input: { claimId: string; repo: string; signal: AbortSignal; purpose: 'completion'; request: SourceCompletionRequestV1 } | { claimId: string; repo: string; signal: AbortSignal; purpose: 'abort'; request: SourceAbortRequestV1 }): Promise<PreparedSourceSettlement> {
      input.signal.throwIfAborted(); let claim = required(input.claimId);
      parseTaskRepo(input.repo); if (!claim.instance.allowedRepos.includes(input.repo)) throw new PersistenceConflictError('Source claim galleon is unauthorized');
      let request = persistedJson(input.request) as unknown as SourceCompletionRequestV1 | SourceAbortRequestV1;
      if (!request || request.runId !== claim.runId || request.task?.ref?.sourceId !== claim.ref.sourceId || request.task?.ref?.externalId !== claim.ref.externalId) throw new PersistenceConflictError('Source settlement owner changed');
      const retained = claim.taskSnapshotHash ? store.taskSnapshot(claim.taskSnapshotHash) : null;
      if (retained && stableJson(retained.task) !== stableJson(request.task)) throw new PersistenceConflictError('Source settlement task snapshot changed');
      if (input.purpose === 'completion' && (!claim.receipt || (request as SourceCompletionRequestV1).claimReceipt?.claimId !== claim.id)) throw new PersistenceConflictError('Source completion claim receipt is missing');
      const settlementId = persistenceHash({ claimId: claim.id, purpose: input.purpose, attempt: input.purpose === 'completion' ? (request as SourceCompletionRequestV1).attempt : null });
      const requestHash = persistenceHash({ purpose: input.purpose, request: input.purpose === 'abort' ? { admissionId: (request as SourceAbortRequestV1).admissionId, runId: request.runId, task: request.task, claimReceipt: request.claimReceipt } : request });
      const row = store.persistence.sql.prepare('SELECT inputHash,json FROM source_settlements WHERE id=?').get(settlementId) as { inputHash: string; json: string } | undefined;
      if (row && row.inputHash !== requestHash) throw new PersistenceConflictError('Source settlement request changed');
      if (row) request = (persistedJson(JSON.parse(row.json)) as unknown as { request: SourceCompletionRequestV1 | SourceAbortRequestV1 }).request;
      if (claim.state === 'settled') {
        if (!row) throw new PersistenceConflictError('Source claim already settled for another request');
        const prepared: PreparedSourceSettlement = Object.freeze({ claim, plan: { kind: 'none' as const, reason: 'Previously settled' }, purpose: input.purpose, request, repo: input.repo, requestHash, settlementId }); preparedSettlements.add(prepared); return prepared;
      }
      claim = store.persistence.transaction(() => {
        const changed = store.beginSettlement(claim.id, claim.revision);
        if (!row) store.persistence.sql.prepare('INSERT INTO source_settlements VALUES (?,?,?)').run(settlementId, requestHash, stableJson({ claimId: claim.id, purpose: input.purpose, request, state: 'requested' }));
        if (input.purpose === 'abort') options.effects?.fenceUnsentClaim?.(claim.id);
        return changed;
      });
      const registration = registry.resolve(claim.instance, 'obligation'); const context = options.context(claim.instance, input.repo, input.signal, 'obligation');
      const plannedRequest = input.purpose === 'abort' ? { ...request, claimSteps: options.effects?.claimSteps?.(claim.id) ?? (request as SourceAbortRequestV1).claimSteps } as SourceAbortRequestV1 : request;
      const raw = input.purpose === 'completion' ? await registration.provider.planCompletion(plannedRequest as SourceCompletionRequestV1, context) : await registration.provider.planAbort(plannedRequest as SourceAbortRequestV1, context);
      input.signal.throwIfAborted(); current(claim, input.repo, 'obligation');
      const plan = parseSourceMutationPlanV1(raw, { ref: claim.ref, repo: input.repo, effectIds: registration.declaration.effectIds });
      const prepared = Object.freeze({ claim, plan, purpose: input.purpose, request: plannedRequest, repo: input.repo, requestHash, settlementId }); preparedSettlements.add(prepared); return prepared;
    },
    commitSettlement<T>(prepared: PreparedSourceSettlement, finalize: (claim: WorkClaimRecord) => T): T {
      if (!preparedSettlements.has(prepared)) throw new PersistenceConflictError('Source settlement was not prepared by this coordinator');
      return store.persistence.transaction(() => {
        const claim = required(prepared.claim.id); if (claim.state === 'settled' && store.persistence.sql.prepare('SELECT id FROM source_settlements WHERE id=? AND inputHash=?').get(prepared.settlementId, prepared.requestHash)) return finalize(claim);
        if (claim.revision !== prepared.claim.revision) throw new PersistenceConflictError('Source settlement preparation is stale'); current(claim, prepared.repo, 'obligation');
        if (prepared.plan.kind === 'remote-effects') throw new PersistenceConflictError('Remote settlement requires operation acknowledgment');
        if (prepared.purpose === 'abort' && prepared.plan.kind === 'none' && (prepared.request as SourceAbortRequestV1).claimSteps.some(step => step.state !== 'unsent')) throw new PersistenceConflictError('Uncertain remote source claims require settlement');
        const settling = store.beginSettlement(claim.id, claim.revision);
        const record = readTaskSource(store, claim.ref.sourceId).storageLayout === 'remote' && prepared.plan.kind === 'none' ? null : local.applyMutation({ claim: settling, plan: prepared.plan, purpose: prepared.purpose });
        const settled = store.settleWork({ claimId: claim.id, expectedRevision: settling.revision, disposition: prepared.purpose === 'abort' ? 'released' : 'completed', reason: prepared.plan.kind === 'none' ? prepared.plan.reason : prepared.purpose, localRecordRevision: record?.revision ?? null, operations: [] });
        options.pins?.release(settled); return finalize(settled);
      });
    },
  };
}
export type SourceAdmissionCoordinator = ReturnType<typeof createSourceAdmissionCoordinator>;
