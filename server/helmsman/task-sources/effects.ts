import type { PluginJson } from '../../../src/plugins/backend';
import { parseSourceEffectResultV1, parseSourceInstanceV1, parseSourceMutationPlanV1, type SourceAbortRequestV1, type SourceInstanceV1, type SourceMutationHttpV1, type SourceMutationPlanV1, type SourceReadHttpV1 } from '../../../src/plugins/tasks';
import type { ArtifactBinding, ProviderBinding } from '../execution-store';
import type { OperationAdapter, OperationContext, OperationResolver } from '../operation-dispatcher';
import type { DurableOperation, OperationOrigin, OperationStore } from '../operations';
import { persistedJson, persistenceHash, stableJson, PersistenceConflictError, PersistenceValidationError } from '../persistence';
import type { SourceOperationBridge } from './admission';
import type { TaskSourceRegistration, TaskSourceRegistry } from './registry';
import type { TaskSourceStore, WorkClaimRecord } from './store';

type RemotePlan = Extract<SourceMutationPlanV1, { kind: 'remote-effects' }>;
interface EffectPlanRecord {
  readonly version: 1;
  readonly id: string;
  readonly claimId: string;
  readonly purpose: 'claim' | 'completion' | 'abort';
  readonly requestHash: string;
  readonly taskSnapshotHash: string;
  readonly planHash: string;
  readonly definition: RemotePlan;
  readonly instance: SourceInstanceV1;
  readonly origin: OperationOrigin;
  readonly operations: readonly { localId: string; handler: string; operationId: string }[];
  readonly fenced: readonly string[];
}
type PlanIdentity = { claimId: string; purpose: EffectPlanRecord['purpose']; requestHash: string };
export interface SourceEffectCoordinator extends SourceOperationBridge {
  readonly resolve: OperationResolver;
  fenceUnsentClaim(claimId: string): SourceAbortRequestV1['claimSteps'];
  claimSteps(claimId: string): SourceAbortRequestV1['claimSteps'];
  hasClaimPlan(claimId: string): boolean;
  operationIds(input: PlanIdentity): readonly string[];
}
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
function operationBinding(instance: SourceInstanceV1): ProviderBinding {
  const binding = instance.binding;
  return { role: 'source', capability: 'helmsman/task-source', contributionId: binding.providerId, contractVersion: 1,
    pluginId: binding.pluginId, artifactHash: binding.artifactHash, connectionId: binding.connectionId, credentialHandle: binding.credentialHandle };
}
export function createSourceEffectCoordinator(options: {
  store: TaskSourceStore;
  registry: TaskSourceRegistry;
  operations: OperationStore;
  artifacts(claim: WorkClaimRecord): readonly ArtifactBinding[];
  authorize(operation: DurableOperation, context: OperationContext, claim: WorkClaimRecord): void;
  http(operation: DurableOperation, context: OperationContext, instance: SourceInstanceV1, mutation: boolean, authorize: () => void): SourceReadHttpV1 | SourceMutationHttpV1;
  now?: () => number;
}): SourceEffectCoordinator {
  const { store, registry, operations } = options;
  const sql = store.persistence.sql;
  const now = options.now ?? Date.now;
  const key = (claimId: string, purpose: string, requestHash: string) => persistenceHash({ claimId, purpose, requestHash });
  function decode(row: { id: string; json: string }): EffectPlanRecord {
    const record = persistedJson(JSON.parse(row.json)) as unknown as EffectPlanRecord;
    if (!record || record.version !== 1 || !label(record.claimId) || !label(record.requestHash) || !['claim', 'completion', 'abort'].includes(record.purpose)
      || !hash(record.id) || row.id !== record.id || record.id !== key(record.claimId, record.purpose, record.requestHash)
      || !hash(record.taskSnapshotHash) || !hash(record.planHash) || !Array.isArray(record.operations) || record.operations.length > 32
      || !Array.isArray(record.fenced) || record.fenced.length > 32 || new Set(record.fenced).size !== record.fenced.length) throw new PersistenceValidationError('Invalid source effect plan record');
    const instance = parseSourceInstanceV1(record.instance);
    const snapshot = store.taskSnapshot(record.taskSnapshotHash);
    const claim = store.claim(record.claimId);
    if (!snapshot || !claim || stableJson(snapshot.instance) !== stableJson(instance) || stableJson(claim.instance) !== stableJson(instance)
      || stableJson(snapshot.task.ref) !== stableJson(claim.ref) || !instance.allowedRepos.includes(snapshot.task.repo)) throw new PersistenceValidationError('Source effect plan owner changed');
    const definition = parseSourceMutationPlanV1(record.definition, { ref: claim.ref, repo: snapshot.task.repo, effectIds: record.operations.map(step => step?.handler) });
    if (definition.kind !== 'remote-effects' || persistenceHash(definition) !== record.planHash || record.operations.length !== definition.effects.length
      || new Set(record.operations.map(step => step?.localId)).size !== definition.effects.length || new Set(record.operations.map(step => step?.operationId)).size !== definition.effects.length
      || record.operations.some(step => !step || !definition.effects.some(effect => effect.localId === step.localId && effect.handler === step.handler)
        || step.operationId !== persistenceHash({ key: `source:${record.id}:${step.localId}` }))
      || record.fenced.some(id => !record.operations.some(step => step.operationId === id)) || !record.origin
      || record.origin.kind !== `source-${record.purpose}` || record.origin.id !== claim.id || record.origin.revision !== record.requestHash
      || (record.purpose === 'completion' ? record.origin.runId !== claim.runId || !Number.isSafeInteger(record.origin.attempt) || record.origin.attempt! < 1 : record.origin.runId !== null || record.origin.attempt !== null)) throw new PersistenceValidationError('Source effect plan integrity failed');
    return Object.freeze(record);
  }
  function plan(id: string): EffectPlanRecord | null {
    const row = sql.prepare('SELECT id,json FROM source_effect_plans WHERE id=?').get(id) as { id: string; json: string } | undefined;
    return row ? decode(row) : null;
  }
  function plans(claimId: string): EffectPlanRecord[] {
    return (sql.prepare('SELECT id,json FROM source_effect_plans ORDER BY rowid').all() as { id: string; json: string }[]).map(decode).filter(value => value.claimId === claimId);
  }
  function target(record: EffectPlanRecord, effect: RemotePlan['effects'][number]): PluginJson {
    const snapshot = store.taskSnapshot(record.taskSnapshotHash)!;
    return { version: 1, claimId: record.claimId, ref: { ...snapshot.task.ref }, instanceId: record.instance.id, repo: snapshot.task.repo, value: effect.target };
  }
  function checkedOperation(record: EffectPlanRecord, step: EffectPlanRecord['operations'][number]): DurableOperation {
    const operation = operations.get(step.operationId);
    const effect = record.definition.effects.find(candidate => candidate.localId === step.localId)!;
    const dependencies = effect.after.map(id => record.operations.find(candidate => candidate.localId === id)!.operationId).sort();
    if (!operation || operation.kind !== 'task-source.effect' || operation.key !== `source:${record.id}:${step.localId}` || stableJson(operation.binding) !== stableJson(operationBinding(record.instance))
      || stableJson(operation.target) !== stableJson(target(record, effect)) || stableJson(operation.origin) !== stableJson(record.origin)
      || stableJson(operation.payload) !== stableJson({ version: 1, planId: record.id, handler: effect.handler, value: effect.payload })
      || stableJson(operation.dependencies) !== stableJson(dependencies)) throw new PersistenceValidationError('Pinned source effect operation changed');
    return operation;
  }
  function assertSettlement(record: EffectPlanRecord, staged: boolean): void {
    if (record.purpose === 'claim') return;
    const rows = sql.prepare('SELECT json FROM source_settlements WHERE inputHash=?').all(record.requestHash) as { json: string }[];
    const matches = rows.map(row => persistedJson(JSON.parse(row.json)) as unknown as {
      claimId: string; purpose: string; state: string; request: { runId: string; admissionId?: string; attempt?: number; task: unknown };
    }).filter(value => value?.claimId === record.claimId && value.purpose === record.purpose);
    const settlement = matches[0];
    const claim = store.claim(record.claimId)!;
    const snapshot = store.taskSnapshot(record.taskSnapshotHash)!;
    if (matches.length !== 1 || !settlement?.request || staged && settlement.state !== 'staged'
      || settlement.request.runId !== claim.runId || stableJson(settlement.request.task) !== stableJson(snapshot.task)
      || (record.purpose === 'completion' ? settlement.request.attempt !== record.origin.attempt : settlement.request.admissionId !== claim.admissionId)) throw new PersistenceConflictError('Source effect settlement identity changed');
  }
  function provenNotApplied(operation: DurableOperation): boolean {
    if (operation.status === 'leased' || operation.status === 'completed' || operation.requiresReconciliation) return false;
    if (operation.deliveryAttempts === 0) return true;
    const latest = operations.attempts(operation.id).at(-1);
    if (!latest || latest.generation !== operation.generation || !latest.evidence || typeof latest.evidence !== 'object' || Array.isArray(latest.evidence)) return false;
    const evidence = latest.evidence as Record<string, PluginJson>;
    return latest.kind === 'operator-resolution' && evidence.outcome === 'definitely-not-applied'
      || latest.kind === 'definitely-not-applied' && evidence.status === 'definitely-not-applied';
  }
  function claimSteps(claimId: string): SourceAbortRequestV1['claimSteps'] {
    return plans(claimId).filter(item => item.purpose === 'claim').flatMap(item => item.operations.map(step => {
      const op = checkedOperation(item, step);
      const state = item.fenced.includes(op.id) ? 'unsent' : op.status === 'completed' ? 'acknowledged'
        : op.requiresReconciliation || op.status === 'leased' ? 'uncertain' : op.deliveryAttempts === 0 ? 'unsent' : 'blocked';
      return { operationId: op.id, state, evidence: { status: op.status, generation: op.generation, receipt: op.receipt } };
    }));
  }
  const bridge: SourceEffectCoordinator = {
    hasClaimPlan: claimId => plans(claimId).some(item => item.purpose === 'claim'),
    operationIds(input) { const record = plan(key(input.claimId, input.purpose, input.requestHash)); return record?.operations.map(step => checkedOperation(record, step).id) ?? []; },
    claimSteps,
    prepare(input) { store.persistence.transaction(() => {
      const current = store.claim(input.claim.id);
      if (!current || current.revision !== input.claim.revision || stableJson(current) !== stableJson(input.claim)
        || !label(input.requestHash) || input.purpose === 'claim' && input.requestHash !== current.admissionId
        || input.purpose === 'completion' && (!Number.isSafeInteger(input.attempt) || input.attempt! < 1) || (input.purpose === 'claim' ? current.state !== 'reserved' : current.state !== 'settling')) throw new PersistenceConflictError('Source effect claim changed');
      const snapshot = store.taskSnapshot(input.task.hash);
      if (!snapshot || stableJson(snapshot) !== stableJson(input.task) || stableJson(snapshot.instance) !== stableJson(current.instance)
        || stableJson(snapshot.task.ref) !== stableJson(current.ref) || current.taskSnapshotHash !== null && current.taskSnapshotHash !== snapshot.hash) throw new PersistenceConflictError('Source effect snapshot changed');
      const registration = registry.resolve(current.instance, 'obligation');
      const checked = parseSourceMutationPlanV1(input.plan, { ref: current.ref, repo: input.task.task.repo, effectIds: registration.declaration.effectIds });
      if (checked.kind !== 'remote-effects') throw new PersistenceConflictError('Remote source plan is required');
      const id = key(current.id, input.purpose, input.requestHash);
      const previous = plan(id);
      const planHash = persistenceHash(checked);
      const origin: OperationOrigin = { kind: `source-${input.purpose}`, id: current.id, revision: input.requestHash,
        runId: input.purpose === 'completion' ? current.runId : null, attempt: input.purpose === 'completion' ? input.attempt! : null };
      if (previous) {
        if (previous.planHash !== planHash || previous.taskSnapshotHash !== input.task.hash || stableJson(previous.origin) !== stableJson(origin)) throw new PersistenceConflictError('Source effect plan identity changed');
        for (const step of previous.operations) checkedOperation(previous, step);
        return;
      }
      if (input.purpose === 'claim' && plans(current.id).some(item => item.purpose === 'claim')) throw new PersistenceConflictError('Source claim already has a remote plan');
      const prepared = new Map<string, EffectPlanRecord['operations'][number]>();
      const skeleton: EffectPlanRecord = { version: 1, id, claimId: current.id, purpose: input.purpose, requestHash: input.requestHash,
        taskSnapshotHash: input.task.hash, planHash, definition: checked, instance: current.instance, origin, operations: [], fenced: [] };
      assertSettlement(skeleton, false);
      const artifacts = options.artifacts(current);
      const enqueue = (localId: string): string => {
        const prior = prepared.get(localId); if (prior) return prior.operationId;
        const effect = checked.effects.find(item => item.localId === localId)!;
        const dependencies = effect.after.map(enqueue);
        const operation = operations.enqueue({ version: 1, key: `source:${id}:${localId}`, kind: 'task-source.effect', origin,
          binding: operationBinding(current.instance), artifacts, target: target(skeleton, effect), payload: { version: 1, planId: id, handler: effect.handler, value: effect.payload }, dependencies });
        prepared.set(localId, { localId, handler: effect.handler, operationId: operation.id }); return operation.id;
      };
      for (const effect of checked.effects) enqueue(effect.localId);
      const value: EffectPlanRecord = { ...skeleton, operations: [...prepared.values()] };
      sql.prepare('INSERT INTO source_effect_plans VALUES (?,?)').run(id, stableJson(value));
    }); },
    acknowledged(input) {
      const record = plan(key(input.claimId, input.purpose, input.requestHash));
      if (!record) return { ready: false, operations: [], blocked: true };
      const found = record.operations.map(step => checkedOperation(record, step));
      const unresolvedClaim = input.purpose === 'abort' && claimSteps(input.claimId).some(step => step.state !== 'unsent' && step.state !== 'acknowledged');
      return { ready: !unresolvedClaim && found.every(op => op.status === 'completed') && record.fenced.length === 0,
        blocked: unresolvedClaim || record.fenced.length > 0 || found.some(op => op.status === 'blocked' || op.status === 'uncertain'),
        operations: found.filter(op => op.status === 'completed' && !record.fenced.includes(op.id)).map(op => ({ operationId: op.id, receipt: op.receipt })) };
    },
    fenceUnsentClaim(claimId) { return store.persistence.transaction(() => {
      const claim = store.claim(claimId); if (!claim || claim.state !== 'settling') throw new PersistenceConflictError('Source claim settlement must be durable before fencing');
      for (const record of plans(claimId).filter(item => item.purpose === 'claim')) {
        const fenced = new Set(record.fenced);
        for (const step of record.operations) {
          const operation = checkedOperation(record, step);
          if (provenNotApplied(operation)) fenced.add(operation.id);
        }
        sql.prepare('UPDATE source_effect_plans SET json=? WHERE id=?').run(stableJson({ ...record, fenced: [...fenced] }), record.id);
        for (const operationId of fenced) {
          if (operations.get(operationId)?.status !== 'completed') operations.resolve(operationId, { actor: 'core.source-settlement', reason: 'Operation fenced before any delivery', evidence: { claimId, unsent: true }, outcome: 'acknowledged' });
        }
      }
      return claimSteps(claimId);
    }); },
    resolve(operation): OperationAdapter | null {
      if (operation.kind !== 'task-source.effect') return null;
      const payload = operation.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload) ? operation.payload as Record<string, PluginJson> : null;
      if (!payload || payload.version !== 1 || typeof payload.planId !== 'string' || typeof payload.handler !== 'string' || !Object.hasOwn(payload, 'value')) return null;
      const recorded = plan(payload.planId);
      const step = recorded?.operations.find(candidate => candidate.operationId === operation.id && candidate.handler === payload.handler);
      if (!recorded || !step || checkedOperation(recorded, step).contentHash !== operation.contentHash) return null;
      const effect = recorded.definition.effects.find(candidate => candidate.localId === step.localId)!;
      let registration: TaskSourceRegistration;
      try { registration = registry.resolve(recorded.instance, 'obligation'); } catch { return null; }
      const handler = registration.provider.effects[step.handler]; if (!handler) return null;
      function assert(context: OperationContext, mutation: boolean): void {
        context.signal.throwIfAborted();
        const activePlan = plan(recorded!.id);
        const live = activePlan && checkedOperation(activePlan, step!);
        const claim = store.claim(recorded!.claimId);
        if (context.idempotencyKey !== operation.id || !live || live.status !== 'leased' || live.generation !== context.generation
          || !live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= now() || !activePlan || activePlan.fenced.includes(operation.id)
          || !claim || claim.state === 'settled' || mutation && (recorded!.purpose === 'claim' ? claim.state !== 'reserved' : claim.state !== 'settling')
          || registry.resolve(recorded!.instance, 'obligation') !== registration) throw new PersistenceConflictError('Source operation delivery is fenced');
        if (mutation) { assertSettlement(activePlan, true); options.authorize(live, context, claim); }
      }
      function http(context: OperationContext, mutation: boolean): SourceMutationHttpV1 | SourceReadHttpV1 {
        const broker = options.http(operation, context, recorded!.instance, mutation, () => assert(context, mutation));
        const get: SourceReadHttpV1['get'] = async input => { assert(context, false); const result = await broker.get(input); assert(context, false); return result; };
        return mutation ? Object.freeze({ get, send: async (input: Parameters<SourceMutationHttpV1['send']>[0]) => {
          assert(context, true);
          if (!('send' in broker) || typeof broker.send !== 'function') throw new PersistenceConflictError('Source mutation HTTP is unavailable');
          const result = await broker.send(input); assert(context, true); return result;
        } }) : Object.freeze({ get });
      }
      return { kind: operation.kind, binding: operationBinding(recorded.instance), delivery: handler.delivery,
        async authorize(_operation, context) { try { assert(context, true); return { allowed: true }; } catch { return { allowed: false, reason: 'Source claim or operation is fenced' }; } },
        async invoke(_operation, context) {
          assert(context, true);
          const result = await handler.invoke({ target: effect.target, payload: effect.payload }, { signal: context.signal, operationId: operation.id, generation: context.generation, instance: recorded.instance, http: http(context, true) as SourceMutationHttpV1 });
          assert(context, false); return parseSourceEffectResultV1(result);
        },
        async reconcile(_operation, context) {
          assert(context, false);
          const result = await handler.reconcile({ target: effect.target, payload: effect.payload }, { signal: context.signal, operationId: operation.id, generation: context.generation, instance: recorded.instance, http: http(context, false) });
          assert(context, false); return parseSourceEffectResultV1(result);
        },
      };
    },
  };
  return bridge;
}
