import type { AppConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import { isPrePrAdapter } from './agents/pre-pr';
import { createSourceConversionCoordinator } from './task-sources/conversion';
import type { Db, RunRow } from './db';
import type { AdmissionStore } from './admission-store';
import type { ArtifactBinding, ExecutionStore } from './execution-store';
import type { OperationStore } from './operations';
import { dispatchOperation } from './operation-dispatcher';
import type { LaunchIntent } from './retry';
import { parseSourceInstanceV1, parseWorkRefV1, type SourceAbortRequestV1, type SourceCompletionRequestV1, type SourceInstanceV1, type WorkRefV1 } from '../../src/plugins/tasks';
import { persistedJson, PersistenceConflictError } from './persistence';
import type { TaskSourceStore, WorkClaimRecord } from './task-sources/store';
import type { TaskSourceRegistry } from './task-sources/registry';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createSourceAdmissionCoordinator, type PreparedSourceSettlement } from './task-sources/admission';
import { createSourceEffectCoordinator } from './task-sources/effects';
import { createTaskSourceService } from './task-source-service';
import { createSourceTodoApi } from './task-source-todos';
import { openTaskSourceSchedule } from './task-source-schedule';
import { createJiraSourceHttp, type JiraSourceCredentialResolver } from './task-source-jira-connection';
import type { SourceConnectionStore } from './task-source-connections';
import type { SourceHttpRequest } from './task-source-http';
import { sourceExecutionTask } from './task-source-execution';

export interface SourceLaunchSelection { instance: SourceInstanceV1; ref: WorkRefV1 | null; displayKey: string | null; }
export function createTaskSourceRuntime(options: {
  store: TaskSourceStore; registry: TaskSourceRegistry; connections: SourceConnectionStore; executions: ExecutionStore; admissions: AdmissionStore; operations: OperationStore; db: Db;
  todoSourceId: string | null; jiraSourceId: string | null; config(): AppConfig; jiraCredentials: JiraSourceCredentialResolver;
  artifacts(instance: SourceInstanceV1, claim?: WorkClaimRecord): readonly ArtifactBinding[];
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  isStopped(runId: string): boolean;
  fetcher?: typeof fetch;
  report(message: string): void;
}) {
  const { store, registry, connections, executions, admissions, operations, db } = options;
  const local = openLocalSourceAdapter(store);
  const preparedFinalizations = new Map<string, PreparedSourceSettlement | null>();
  function claimForRun(runId: string): WorkClaimRecord | null { return store.claims().find(claim => claim.runId === runId && !claim.id.startsWith('legacy-')) ?? null; }
  function source(id: string | null) {
    const value = id ? store.source(id) : null;
    const instance = value && store.instance(value.currentInstanceId);
    if (!value || !instance) throw new PersistenceConflictError('Task source is unavailable');
    return { source: value, instance };
  }
  function scopeHttp(request: SourceHttpRequest, ref?: WorkRefV1): void {
    if (request.method === 'GET') {
      if (['/rest/api/3/myself', '/_edge/tenant_info', '/rest/api/3/search/jql'].includes(request.path)
        || /^\/rest\/api\/3\/issue\/(?:[1-9]\d*|[a-z][a-z\d_]*-\d+)(?:\/transitions)?$/i.test(request.path)) return;
    } else if (ref && /^[1-9]\d*$/.test(ref.externalId)
      && (request.method === 'PUT' && request.path === `/rest/api/3/issue/${ref.externalId}/assignee`
        || request.method === 'POST' && request.path === `/rest/api/3/issue/${ref.externalId}/transitions`)) return;
    throw new PersistenceConflictError('Task source HTTP request is outside its recorded target');
  }
  function http(instance: SourceInstanceV1, signal: AbortSignal, mutation: boolean, authorize: () => void, ref?: WorkRefV1) {
    const connection = instance.binding.connectionId ? connections.get(instance.binding.connectionId) : null;
    if (!connection || connection.credentialHandle !== instance.binding.credentialHandle || instance.authority && instance.authority.authorityId !== connection.authorityId) throw new PersistenceConflictError('Pinned task source connection is unavailable');
    return createJiraSourceHttp({ connection, resolveConfig: options.jiraCredentials, signal, mutation, fetcher: options.fetcher,
      authorize: request => { authorize(); scopeHttp(request, ref); } });
  }
  const service = createTaskSourceService({ store, registry, local, http: (instance, _repo, signal, _purpose, authorize) => http(instance, signal, false, authorize),
    refresh: {
      connection: instance => instance.binding.connectionId ? connections.get(instance.binding.connectionId) : null,
      identityFormat: instance => instance.binding.pluginId === 'helmsman.jira' && instance.binding.providerId === 'helmsman.jira/issues' ? 'jira.issue-id/v1' : null,
    } });
  const effects = createSourceEffectCoordinator({ store, registry, operations, artifacts: claim => options.artifacts(claim.instance, claim),
    authorize(operation, _context, claim) {
      if (operation.origin.kind === 'source-claim') {
        const admission = admissions.get(claim.runId);
        if (!admission || !['pending', 'blocked'].includes(admission.state) || executions.attempt({ runId: claim.runId, attempt: 1 }) || options.isStopped(claim.runId)) throw new PersistenceConflictError('Source admission is no longer authorized');
      } else if (operation.origin.kind === 'source-abort') {
        if (executions.attempt({ runId: claim.runId, attempt: 1 })) throw new PersistenceConflictError('Source admission abort cannot affect an execution attempt');
      } else if (operation.origin.kind === 'source-completion') {
        const run = db.getRun(claim.runId);
        const attempt = operation.origin.attempt;
        const execution = attempt ? executions.attempt({ runId: claim.runId, attempt }) : null;
        if (!run || run.status === 'running' || run.attempt !== attempt || !execution?.outcome) throw new PersistenceConflictError('Source completion is not backed by the current terminal attempt');
      } else throw new PersistenceConflictError('Unknown source operation purpose');
    },
    http: (operation, context, instance, mutation, authorize) => {
      const claim = store.claim(operation.origin.id);
      if (!claim) throw new PersistenceConflictError('Source operation claim is missing');
      return http(instance, context.signal, mutation, authorize, claim.ref);
    },
  });
  const coordinator = createSourceAdmissionCoordinator({ store, registry, local, context: service.context, effects,
    pins: { retain(claim) { executions.retainPins(options.artifacts(claim.instance, claim).map(artifact => ({ kind: 'dependency', ownerId: `source-claim:${claim.id}`, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash }))); },
      release: claim => executions.releaseSourceClaimPins(claim.id) } });
  const todoApi = options.todoSourceId ? createSourceTodoApi({ sourceId: options.todoSourceId, store, service }) : null;
  const schedule = openTaskSourceSchedule(store, service);
  function selection(body: LaunchIntent): SourceLaunchSelection | null {
    if (body.mode === 'source') {
      const ref = parseWorkRefV1(body.workRef);
      const instance = body.sourceInstanceId ? store.instance(body.sourceInstanceId) : null;
      if (!instance || instance.sourceId !== ref.sourceId || instance.revision !== body.sourceInstanceRevision) throw new PersistenceConflictError('Task source selection changed');
      service.assertScope(instance, body.repo, 'admission'); return { instance, ref, displayKey: null };
    }
    if (body.mode === 'todo') {
      const { instance } = source(options.todoSourceId);
      const ref = parseWorkRefV1({ sourceId: instance.sourceId, externalId: body.todoId });
      const record = local.get(ref.sourceId, ref.externalId);
      if (!record || record.repo !== body.repo) throw new PersistenceConflictError('Todo is unavailable in this galleon');
      service.assertScope(instance, body.repo, 'admission'); return { instance, ref, displayKey: null };
    }
    if (body.ticketId && !body.task && (!body.mode || body.mode === 'ticket')) {
      const { instance } = source(options.jiraSourceId);
      service.assertScope(instance, body.repo, 'admission'); return { instance, ref: null, displayKey: body.ticketId };
    }
    return null;
  }
  function canonical(body: LaunchIntent, value: SourceLaunchSelection): LaunchIntent {
    if (!value.ref) return { ...body, sourceInstanceId: value.instance.id, sourceInstanceRevision: value.instance.revision };
    const { todoId: _todoId, ...remaining } = body;
    return { ...remaining, mode: 'source', workRef: value.ref, sourceInstanceId: value.instance.id, sourceInstanceRevision: value.instance.revision };
  }
  function reserve(runId: string, repo: string, value: SourceLaunchSelection, admit: () => void, retryOf?: string): WorkClaimRecord | null {
    if (!value.ref) { admit(); return null; }
    const source = store.source(value.ref.sourceId);
    if (!source) throw new PersistenceConflictError('Source namespace is unavailable');
    return coordinator.reserve({ ref: value.ref, repo, admissionId: runId, runId, instanceId: value.instance.id,
      expectedSourceRevision: source.revision, expectedInstanceRevision: value.instance.revision, retryOf }, admit);
  }
  async function dispatchPlan(input: { claimId: string; purpose: 'claim' | 'completion' | 'abort'; requestHash: string }): Promise<void> {
    for (const id of effects.operationIds(input)) {
      const operation = operations.get(id);
      if (!operation || operation.status === 'completed') continue;
      await options.verifyArtifacts(operation.artifacts);
      await dispatchOperation(operations, id, effects.resolve, { reconcile: operation.requiresReconciliation });
    }
  }
  async function prepare(runId: string, repo: string, value: SourceLaunchSelection, signal: AbortSignal, retryOf?: string): Promise<{ task: AgentTask; selection: SourceLaunchSelection }> {
    signal.throwIfAborted();
    if (!value.ref) {
      const ref = await service.lookup({ instanceId: value.instance.id, instanceRevision: value.instance.revision, repo, displayKey: value.displayKey! }, signal);
      if (!ref) throw new PersistenceConflictError('Jira task was not found');
      value = { ...value, ref, displayKey: null };
      reserve(runId, repo, value, () => {
        const admission = admissions.get(runId);
        if (!admission || !['pending', 'blocked'].includes(admission.state)) throw new PersistenceConflictError('Admission is unavailable');
      }, retryOf);
    }
    const claim = claimForRun(runId);
    if (!claim) throw new PersistenceConflictError('Source work was not reserved');
    await options.verifyArtifacts(options.artifacts(claim.instance, claim));
    signal.throwIfAborted();
    const prepared = await coordinator.prepare({ claimId: claim.id, repo, signal, retryOf });
    signal.throwIfAborted();
    let result: AgentTask;
    if (prepared.plan.kind === 'remote-effects') {
      const snapshot = coordinator.stageRemoteClaim(prepared);
      await dispatchPlan({ claimId: claim.id, purpose: 'claim', requestHash: claim.admissionId });
      signal.throwIfAborted();
      result = coordinator.commitRemoteClaim({ claimId: claim.id, taskSnapshotHash: snapshot.hash }, (claimed, snapshot) => sourceExecutionTask(snapshot, claimed));
    } else result = coordinator.commit(prepared, (claimed, snapshot) => sourceExecutionTask(snapshot, claimed));
    return { task: result, selection: value };
  }
  function snapshotForClaim(claim: WorkClaimRecord) {
    if (claim.taskSnapshotHash) return store.taskSnapshot(claim.taskSnapshotHash);
    const rows = store.persistence.sql.prepare('SELECT json FROM source_effect_plans').all() as { json: string }[];
    const plan = rows.map(row => persistedJson(JSON.parse(row.json)) as { claimId?: unknown; purpose?: unknown; taskSnapshotHash?: unknown }).find(item => item.claimId === claim.id && item.purpose === 'claim');
    return typeof plan?.taskSnapshotHash === 'string' ? store.taskSnapshot(plan.taskSnapshotHash) : null;
  }
  function settlementFor(claimId: string, purpose?: 'completion' | 'abort') {
    const rows = store.persistence.sql.prepare('SELECT inputHash,json FROM source_settlements ORDER BY rowid DESC').all() as { inputHash: string; json: string }[];
    for (const row of rows) {
      const value = persistedJson(JSON.parse(row.json)) as unknown as { claimId: string; purpose: 'completion' | 'abort'; state: string; request: SourceAbortRequestV1 | SourceCompletionRequestV1 };
      if (value.claimId === claimId && (!purpose || value.purpose === purpose)) return { ...value, requestHash: row.inputHash };
    }
    return null;
  }
  function commitStaged(claim: WorkClaimRecord, settlement: NonNullable<ReturnType<typeof settlementFor>>): boolean {
    if (settlement.state !== 'staged') return false;
    const identity = { claimId: claim.id, purpose: settlement.purpose, requestHash: settlement.requestHash };
    if (!effects.operationIds(identity).length) throw new PersistenceConflictError('Staged source settlement operations are missing');
    const state = effects.acknowledged(identity);
    if (state.ready || state.blocked && claim.settlement?.disposition !== 'retained-for-operator') coordinator.commitRemoteSettlement(identity, () => {});
    return true;
  }
  async function abort(runId: string, reason: SourceAbortRequestV1['reason'], signal = AbortSignal.timeout(30_000)): Promise<void> {
    const claim = claimForRun(runId);
    if (!claim || claim.state === 'settled') return;
    if (executions.attempt({ runId, attempt: 1 })) throw new PersistenceConflictError('An execution attempt requires worker recovery, not admission abort');
    const savedSettlement = settlementFor(claim.id, 'abort');
    if (savedSettlement?.state === 'staged') {
      await dispatchPlan({ claimId: claim.id, purpose: 'abort', requestHash: savedSettlement.requestHash });
      commitStaged(claim, savedSettlement); return;
    }
    const snapshot = snapshotForClaim(claim);
    if (!snapshot && claim.state === 'reserved' && !effects.hasClaimPlan(claim.id)) {
      coordinator.cancelReserved({ claimId: claim.id, reason }, () => {}); return;
    }
    if (!snapshot) throw new PersistenceConflictError('Source abort snapshot is unavailable');
    const request: SourceAbortRequestV1 = savedSettlement ? savedSettlement.request as SourceAbortRequestV1 : { admissionId: claim.admissionId, runId, task: snapshot.task, claimReceipt: claim.receipt, reason, claimSteps: [] };
    const settlement = await coordinator.prepareSettlement({ claimId: claim.id, repo: snapshot.task.repo, signal, purpose: 'abort', request });
    if (settlement.plan.kind === 'remote-effects') {
      coordinator.stageRemoteSettlement(settlement);
      const identity = { claimId: claim.id, purpose: 'abort' as const, requestHash: settlement.requestHash };
      await dispatchPlan(identity);
      const state = effects.acknowledged(identity);
      if (state.ready || state.blocked) coordinator.commitRemoteSettlement(identity, () => {});
    } else coordinator.commitSettlement(settlement, () => {});
  }
  function completionRequest(row: RunRow, claim: WorkClaimRecord): SourceCompletionRequestV1 {
    const snapshot = claim.taskSnapshotHash ? store.taskSnapshot(claim.taskSnapshotHash) : null;
    if (!snapshot || !claim.receipt || row.status === 'running') throw new PersistenceConflictError('Source completion evidence is unavailable');
    const task = row.taskJson ? JSON.parse(row.taskJson) as AgentTask : null;
    return { runId: row.id, attempt: row.attempt, task: snapshot.task, claimReceipt: claim.receipt, outcome: row.status,
      publication: row.status === 'succeeded' && row.prNumber && !task?.review && !task?.prBranch ? { repo: row.repo, prNumber: row.prNumber } : null };
  }
  async function prepareFinalization(row: RunRow): Promise<void> {
    const claim = claimForRun(row.id); if (!claim || claim.state === 'settled') return;
    const key = `${row.id}:${row.attempt}`;
    if (settlementFor(claim.id, 'completion')?.state === 'staged') { preparedFinalizations.set(key, null); return; }
    if (row.status !== 'succeeded' && row.worktreePath && isPrePrAdapter(row.adapter)) { preparedFinalizations.set(key, null); return; }
    try {
      preparedFinalizations.set(key, await coordinator.prepareSettlement({ claimId: claim.id, repo: row.repo, signal: AbortSignal.timeout(30_000), purpose: 'completion', request: completionRequest(row, claim) }));
    } catch (error) {
      preparedFinalizations.set(key, null); options.report(`Source completion remains pending for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function finalize(row: RunRow): void {
    const claim = claimForRun(row.id); if (!claim || claim.state === 'settled') return;
    const key = `${row.id}:${row.attempt}`;
    if (!preparedFinalizations.has(key)) throw new PersistenceConflictError('Source finalization was not prepared');
    const prepared = preparedFinalizations.get(key);
    if (!prepared) return;
    try {
      store.persistence.transaction(() => {
        if (prepared.plan.kind === 'remote-effects') coordinator.stageRemoteSettlement(prepared);
        else coordinator.commitSettlement(prepared, () => {});
      });
    } catch (error) {
      preparedFinalizations.set(key, null);
      options.report(`Source finalization remains pending for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let draining: Promise<void> | null = null;
  async function drain(): Promise<void> {
    draining ??= (async () => {
      for (const claim of store.claims().filter(item => item.state === 'settling' && !item.id.startsWith('legacy-'))) {
        if (settlementFor(claim.id)?.purpose === 'abort') effects.fenceUnsentClaim(claim.id);
      }
      for (const operation of operations.list({ statuses: ['pending', 'leased', 'retrying', 'uncertain', 'blocked'] }).filter(item => item.kind === 'task-source.effect')) {
        try { await options.verifyArtifacts(operation.artifacts); await dispatchOperation(operations, operation.id, effects.resolve, { reconcile: operation.requiresReconciliation }); }
        catch (error) { options.report(`Source operation ${operation.id} remains pending: ${error instanceof Error ? error.message : String(error)}`); }
      }
      for (const claim of store.claims().filter(item => item.state !== 'settled' && !item.id.startsWith('legacy-'))) {
        const row = db.getRun(claim.runId);
        const execution = executions.attempt({ runId: claim.runId, attempt: row?.attempt ?? 1 });
        try {
          const existing = settlementFor(claim.id);
          if (existing?.state === 'staged') { commitStaged(claim, existing); continue; }
          if (!execution) {
            if (existing?.purpose === 'abort' || admissions.get(claim.runId)?.state === 'failed') await abort(claim.runId, existing?.purpose === 'abort' ? (existing.request as SourceAbortRequestV1).reason : 'preflight-failed');
            continue;
          }
          if (!row || row.status === 'running' || !execution.outcome || executions.checkpoint(`${row.id}:${row.attempt}:pre-pr`)?.state === 'resumable') continue;
          const settlement = await coordinator.prepareSettlement({ claimId: claim.id, repo: row.repo, signal: AbortSignal.timeout(30_000), purpose: 'completion', request: completionRequest(row, claim) });
          if (settlement.plan.kind === 'remote-effects') {
            coordinator.stageRemoteSettlement(settlement);
            const identity = { claimId: claim.id, purpose: 'completion' as const, requestHash: settlement.requestHash };
            await dispatchPlan(identity);
            const state = effects.acknowledged(identity);
            if (state.ready || state.blocked) coordinator.commitRemoteSettlement(identity, () => {});
          } else coordinator.commitSettlement(settlement, () => {});
        } catch (error) { options.report(`Source settlement ${claim.id} remains pending: ${error instanceof Error ? error.message : String(error)}`); }
      }
      createSourceConversionCoordinator(store).reconcile({ sourceIds: store.sources().map(source => source.id) });
      for (const key of preparedFinalizations.keys()) { const row = db.getRun(key.slice(0, key.lastIndexOf(':'))); if (row && row.status !== 'running') preparedFinalizations.delete(key); }
    })().finally(() => { draining = null; });
    return draining;
  }
  async function recoverAdmissions(): Promise<void> {
    for (const admission of admissions.pending()) {
      if (executions.attempt({ runId: admission.runId, attempt: 1 })) continue;
      const request = admission.request as { sourceInstanceId?: unknown } | null;
      if (!claimForRun(admission.runId) && typeof request?.sourceInstanceId !== 'string') continue;
      try {
        await abort(admission.runId, 'preflight-failed');
        admissions.fail(admission.runId, 'Restart proved admission had no worker attempt; source settlement is preserved separately');
      } catch (error) { admissions.block(admission.runId, `Source admission recovery requires reconciliation: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  async function retrySettlement(claimId: string): Promise<void> {
    const claim = store.claim(claimId);
    if (!claim || claim.id.startsWith('legacy-') || claim.state === 'settled') throw new PersistenceConflictError('Source settlement is unavailable');
    const row = db.getRun(claim.runId);
    const execution = executions.attempt({ runId: claim.runId, attempt: row?.attempt ?? 1 });
    if (execution && (!row || row.status === 'running' || !execution.outcome || executions.checkpoint(`${row.id}:${row.attempt}:pre-pr`)?.state === 'resumable')) throw new PersistenceConflictError('The source claim still belongs to an active or resumable execution');
    if (!execution && settlementFor(claimId)?.purpose !== 'abort' && admissions.get(claim.runId)?.state !== 'failed') throw new PersistenceConflictError('Cancel the unstarted source admission before settling it');
    await drain();
  }
  return { store, registry, connections, local, service, coordinator, effects, todoApi, schedule, selection, canonical, reserve, prepare, abort,
    claimForRun, snapshotForClaim, prepareFinalization, finalize, drain, recoverAdmissions, retrySettlement,
    sourceArtifacts: (claim: WorkClaimRecord) => options.artifacts(claim.instance, claim),
    jiraEnabled() { try { const { instance } = source(options.jiraSourceId); service.assertScope(instance, null, 'admission'); return true; } catch { return false; } },
    repos() { return [...new Set(store.instances().flatMap(instance => instance.allowedRepos))].sort(); },
    retained(instance: SourceInstanceV1) { return parseSourceInstanceV1(instance); },
  };
}
export type TaskSourceRuntime = ReturnType<typeof createTaskSourceRuntime>;
