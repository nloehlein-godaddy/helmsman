import { randomUUID } from 'node:crypto';
import { isContributionId } from '../../src/plugins/manifest';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from '../../src/plugins/task-read';
import { sourceFields, sourceObject } from '../../src/plugins/source-contract-validation';
import { parseSourceRemoteActionCommandV1, parseSourceRemoteActionInputV1, parseSourceRemoteActionOutcomeV1, parseSourceRemoteActionPlanV1, parseSourceRemoteActionReceiptQueryV1, parseSourceRemoteActionReceiptV1, type SourceRemoteActionCommandV1, type SourceRemoteActionDiscoveryV1, type SourceRemoteActionPlanV1, type SourceRemoteActionReceiptQueryV1, type SourceRemoteActionReceiptV1 } from '../../src/plugins/task-actions';
import { parseSourceEffectResultV1, parseSourceInstanceV1, type SourceInstanceV1, type SourceMutationHttpV1, type SourceReadHttpV1, type WorkRefV1 } from '../../src/plugins/tasks';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { migrateOwned, validateTableColumns } from './migrations';
import { dispatchOperation, type OperationContext, type OperationResolver } from './operation-dispatcher';
import type { DurableOperation, OperationResult, OperationStore } from './operations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { createTaskSourceService } from './task-source-service';
import type { TaskSourceRegistry } from './task-sources/registry';
import type { TaskSourceStore } from './task-sources/store';

export interface TaskActionServerOptions {
  store: TaskSourceStore;
  registry: TaskSourceRegistry;
  service: ReturnType<typeof createTaskSourceService>;
  operations: OperationStore;
  repos(): readonly string[];
  authorize(caller: string): void;
  actionArtifacts(instance: SourceInstanceV1): readonly ArtifactBinding[];
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  actionHttp(instance: SourceInstanceV1, signal: AbortSignal, mutation: boolean, authorize: () => void, ref: WorkRefV1): SourceReadHttpV1 | SourceMutationHttpV1;
}
interface ActionRecord {
  caller: string; command: SourceRemoteActionCommandV1; owner: string;
  instance: SourceInstanceV1; artifacts: readonly ArtifactBinding[];
  plan: SourceRemoteActionPlanV1 | null; operationId: string | null; receipt: SourceRemoteActionReceiptV1 | null;
}
const kind = 'source-remote-action.assign-self';
const origin = 'public-source-action';
const schema = 'CREATE TABLE task_action_commands (id TEXT PRIMARY KEY, contentHash TEXT NOT NULL, json TEXT NOT NULL)';
const same = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);
const key = (caller: string, requestId: string) => `public-source-action:${persistenceHash({ caller, requestId })}`;
function binding(instance: SourceInstanceV1): ProviderBinding {
  return { role: 'effect', capability: 'helmsman/task-source', contributionId: instance.binding.providerId, contractVersion: 1,
    pluginId: instance.binding.pluginId, artifactHash: instance.binding.artifactHash, connectionId: instance.binding.connectionId, credentialHandle: instance.binding.credentialHandle };
}
function receipt(command: SourceRemoteActionCommandV1, status: SourceRemoteActionReceiptV1['status'], reason: string | null = null, result: unknown = null): SourceRemoteActionReceiptV1 {
  return parseSourceRemoteActionReceiptV1({ version: 1, requestId: command.requestId, input: parseSourceRemoteActionInputV1((({ requestId: _id, ...input }) => input)(command)), status, result, reason }, command);
}
export function createTaskActionService(options: TaskActionServerOptions) {
  const { store, registry, service, operations } = options;
  const { persistence } = store; const { sql } = persistence;
  const owner = randomUUID();
  migrateOwned(sql, { owner: 'core.task-actions', version: 1, checksum: persistenceHash(schema), tables: ['task_action_commands'],
    validateLegacy: () => null, apply: database => database.exec(schema),
    validateCurrent: database => validateTableColumns(database, 'task_action_commands', ['id', 'contentHash', 'json']) });
  const save = (record: ActionRecord) => {
    const json = stableJson(record);
    sql.prepare('INSERT INTO task_action_commands VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET contentHash=excluded.contentHash,json=excluded.json')
      .run(key(record.caller, record.command.requestId), persistenceHash(record), json);
  };
  function read(id: string): ActionRecord | null {
    const row = sql.prepare('SELECT contentHash,json FROM task_action_commands WHERE id=?').get(id) as { contentHash: string; json: string } | undefined;
    if (!row) return null;
    const record = persistedJson(JSON.parse(row.json)) as unknown as ActionRecord;
    const command = parseSourceRemoteActionCommandV1(record?.command);
    const instance = parseSourceInstanceV1(record?.instance);
    if (!isContributionId(record.caller) || row.contentHash !== persistenceHash(record) || id !== key(record.caller, command.requestId)
      || instance.id !== command.selection.instanceId || instance.sourceId !== command.selection.sourceId || instance.revision !== command.selection.instanceRevision
      || !Array.isArray(record.artifacts) || !record.artifacts.length || typeof record.owner !== 'string'
      || record.operationId !== null && record.operationId !== persistenceHash({ key: id })) throw new PersistenceValidationError('Task action reservation integrity failed');
    if (record.plan !== null) parseSourceRemoteActionPlanV1(record.plan, command);
    if (record.receipt !== null) parseSourceRemoteActionReceiptV1(record.receipt, command);
    return record;
  }
  const access = (caller: string, repo: string, scope: string | null) => {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller); clarificationScope(options.repos(), scope, repo);
  };
  function selection(raw: TaskReadSelectionV1): SourceInstanceV1 {
    sourceFields(sourceObject(raw), ['version', 'sourceId', 'instanceId', 'instanceRevision', 'repo']);
    const value = parseTaskReadSelectionV1(raw); const instance = store.instance(value.instanceId);
    if (!instance || instance.sourceId !== value.sourceId || instance.revision !== value.instanceRevision) throw new PersistenceConflictError('Task source selection changed');
    service.assertScope(instance, value.repo, 'admission'); return instance;
  }
  function current(record: ActionRecord): void {
    access(record.caller, record.command.selection.repo, record.command.selection.repo);
    const instance = selection(record.command.selection);
    if (!same(instance, record.instance) || store.source(instance.sourceId)?.revision !== record.command.sourceRevision) throw new PersistenceConflictError('Task source revision changed');
    store.assertUnquarantined(record.command.target.ref);
    if (store.activeClaim(record.command.target.ref)) throw new PersistenceConflictError('Task is owned by an active voyage');
    const registration = registry.resolve(instance, 'admission');
    const declaration = registration.declaration.remoteActions?.find(action => action.id === record.command.action);
    if (!declaration || !registration.provider.prepareRemoteAction || record.plan?.kind === 'effect' && declaration.effectId !== record.plan.effectId) throw new PersistenceConflictError('Task action is unavailable');
  }
  function checkedOperation(record: ActionRecord): DurableOperation {
    const operation = record.operationId ? operations.get(record.operationId) : null;
    if (!operation || record.plan?.kind !== 'effect' || operation.key !== key(record.caller, record.command.requestId) || operation.kind !== kind
      || !same(operation.origin, { kind: origin, id: record.command.requestId, revision: persistenceHash({ caller: record.caller, command: record.command }), runId: null, attempt: null })
      || !same(operation.binding, binding(record.instance)) || !same(operation.artifacts, record.artifacts)
      || !same(operation.target, record.plan.target) || !same(operation.payload, { caller: record.caller, command: record.command, instance: record.instance, plan: record.plan })) throw new PersistenceValidationError('Task action operation integrity failed');
    return operation;
  }
  function outcome(record: ActionRecord, value: unknown) {
    const result = parseSourceRemoteActionOutcomeV1(value, record.command);
    const expected = record.plan?.kind === 'effect' ? sourceObject(record.plan.receipt) : null;
    if (expected && (expected.accountId !== result.accountId || !same(expected.ref, result.ref) || expected.repo !== result.repo)) throw new PersistenceValidationError('Task action completion identity changed');
    return result;
  }
  function project(record: ActionRecord): SourceRemoteActionReceiptV1 {
    if (record.receipt) return record.receipt;
    if (!record.operationId) return receipt(record.command, 'pending');
    const operation = checkedOperation(record);
    if (operation.status === 'completed') {
      try { return receipt(record.command, 'succeeded', null, outcome(record, sourceObject(operation.receipt).result)); }
      catch { return receipt(record.command, 'recovery-required', 'Recorded completion does not prove assignment.'); }
    }
    if (operation.status === 'blocked' && !operation.requiresReconciliation) {
      const attempt = operations.attempts(operation.id).at(-1);
      const evidence = attempt?.kind === 'definitely-not-applied' ? sourceObject(attempt.evidence) : null;
      const proof = evidence?.status === 'definitely-not-applied' ? sourceObject(evidence.evidence) : null;
      if (proof?.manualRetryAllowed === false) {
        const hash = persistenceHash({ operationId: operation.id, generation: operation.generation, evidence });
        return parseSourceRemoteActionReceiptV1({ ...receipt(record.command, 'rejected', operation.diagnostic?.message?.slice(0, 2000) ?? 'Provider proved assignment was not applied.'),
          resolution: { version: 1, kind: 'not-applied', id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` } }, record.command);
      }
    }
    return operation.requiresReconciliation || ['blocked', 'uncertain'].includes(operation.status)
      ? receipt(record.command, 'recovery-required', operation.diagnostic?.message?.slice(0, 2000) ?? 'Recovery is required.') : receipt(record.command, 'pending');
  }
  const find = (caller: string, query: SourceRemoteActionReceiptQueryV1) => {
    const record = read(key(caller, query.requestId));
    if (record && record.command.selection.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found');
    return record;
  };
  const resolve: OperationResolver = async operation => {
    if (operation.kind !== kind || operation.origin.kind !== origin) return null;
    const record = read(operation.key);
    if (!record || checkedOperation(record).contentHash !== operation.contentHash || record.plan?.kind !== 'effect') return null;
    await options.verifyArtifacts(record.artifacts);
    const registration = registry.resolve(record.instance, 'obligation');
    const plan = record.plan;
    if (!registration.declaration.remoteActions?.some(action => action.id === record.command.action && action.effectId === plan.effectId)) return null;
    const handler = registration.provider.effects[plan.effectId]; if (!handler) return null;
    function assert(context: OperationContext, mutation: boolean): void {
      context.signal.throwIfAborted();
      const saved = read(operation.key); const live = saved && checkedOperation(saved);
      if (!live || live.contentHash !== operation.contentHash || live.status !== 'leased' || live.generation !== context.generation
        || context.idempotencyKey !== operation.id || !live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= Date.now()
        || registry.resolve(record!.instance, 'obligation') !== registration) throw new PersistenceConflictError('Task action delivery is fenced');
      service.assertScope(record!.instance, record!.command.selection.repo, 'obligation');
      if (mutation) current(record!);
    }
    function http(context: OperationContext, mutation: boolean): SourceReadHttpV1 | SourceMutationHttpV1 {
      const broker = options.actionHttp(record!.instance, context.signal, mutation, () => assert(context, mutation), record!.command.target.ref);
      const get: SourceReadHttpV1['get'] = async request => { assert(context, mutation); const result = await broker.get(request); assert(context, mutation); return result; };
      return mutation ? { get, send: async request => {
        assert(context, true);
        if (!('send' in broker)) throw new PersistenceConflictError('Mutation HTTP is unavailable');
        const result = await broker.send(request); assert(context, true); return result;
      } } : { get };
    }
    async function execute(context: OperationContext, mutation: boolean): Promise<OperationResult> {
      assert(context, mutation);
      const input = { target: plan.target, payload: plan.payload };
      const base = { signal: context.signal, operationId: operation.id, generation: context.generation, instance: record!.instance };
      const value = mutation ? await handler!.invoke(input, { ...base, http: http(context, true) as SourceMutationHttpV1 })
        : await handler!.reconcile(input, { ...base, http: http(context, false) });
      assert(context, false);
      const result = parseSourceEffectResultV1(value);
      if (result.status === 'acknowledged') outcome(record!, sourceObject(result.receipt).result);
      return result.status === 'definitely-not-applied' ? { ...result, retryable: false, evidence: { provider: result.evidence, manualRetryAllowed: result.retryable } } : result;
    }
    return { kind, binding: binding(record.instance), delivery: 'reconcile',
      async authorize(_operation, context) { try { assert(context, true); return { allowed: true }; } catch { return { allowed: false, reason: 'Task action admission changed.' }; } },
      invoke: (_operation, context) => execute(context, true), reconcile: (_operation, context) => execute(context, false) };
  };
  const dispatch = (id: string) => dispatchOperation(operations, id, resolve, { reconcile: true });
  persistence.transaction(() => {
    for (const row of sql.prepare('SELECT id FROM task_action_commands').all() as { id: string }[]) {
      const record = read(row.id)!;
      if (!record.operationId && !record.receipt) save({ ...record, receipt: receipt(record.command, 'rejected', 'Preparation was interrupted before any remote write.') });
    }
  });
  return {
    resolve, dispatch,
    discover(caller: string, raw: TaskReadSelectionV1, scope: string | null): SourceRemoteActionDiscoveryV1 {
      access(caller, raw?.repo, scope); const instance = selection(raw); const source = store.source(instance.sourceId);
      if (!source) throw new PersistenceConflictError('Task source is unavailable');
      const registration = registry.resolve(instance, 'admission');
      return { version: 1, selection: parseTaskReadSelectionV1(raw), sourceRevision: source.revision,
        actions: registration.provider.prepareRemoteAction && registration.declaration.remoteActions?.some(action => action.id === 'assign-self') ? ['assign-self'] : [] };
    },
    async submit(caller: string, raw: SourceRemoteActionCommandV1, scope: string | null): Promise<SourceRemoteActionReceiptV1> {
      const command = parseSourceRemoteActionCommandV1(raw); access(caller, command.selection.repo, scope);
      const prior = find(caller, { repo: command.selection.repo, requestId: command.requestId });
      if (prior) {
        if (!same(prior.command, command)) throw new PersistenceConflictError('Task action request content changed');
        return project(prior);
      }
      const instance = selection(command.selection);
      let record: ActionRecord = { caller, command, instance, artifacts: [...options.actionArtifacts(instance)].sort((a, b) => a.pluginId.localeCompare(b.pluginId)), owner, plan: null, operationId: null, receipt: null };
      persistence.transaction(() => { current(record); save(record); });
      try {
        const signal = AbortSignal.timeout(30_000);
        await options.verifyArtifacts(record.artifacts); current(record);
        const task = await service.load({ ...command.selection, ref: command.target.ref }, signal);
        if (!task || task.revision !== command.target.expectedRevision) throw new PersistenceConflictError('Task revision changed');
        current(record);
        const registration = registry.resolve(instance, 'admission');
        const plan = parseSourceRemoteActionPlanV1(await registration.provider.prepareRemoteAction!(parseSourceRemoteActionInputV1((({ requestId: _id, ...input }) => input)(command)), service.context(instance, command.selection.repo, signal)), command);
        signal.throwIfAborted();
        record = persistence.transaction(() => {
          const saved = read(key(caller, command.requestId));
          if (!saved || saved.owner !== owner || saved.receipt || saved.operationId) throw new PersistenceConflictError('Task action preparation is fenced');
          const prepared = { ...record, plan }; current(prepared);
          if (registry.resolve(instance, 'admission') !== registration) throw new PersistenceConflictError('Task action provider changed');
          if (plan.kind === 'acknowledged') { const completed = { ...prepared, receipt: receipt(command, 'succeeded', null, plan.result) }; save(completed); return completed; }
          const expected = sourceObject(plan.receipt); sourceFields(expected, ['ref', 'repo', 'accountId']);
          parseSourceRemoteActionOutcomeV1({ ...expected, revision: command.target.expectedRevision }, command);
          const operation = operations.enqueue({ version: 1, key: key(caller, command.requestId), kind,
            origin: { kind: origin, id: command.requestId, revision: persistenceHash({ caller, command }), runId: null, attempt: null },
            binding: binding(instance), artifacts: record.artifacts, target: plan.target, payload: persistedJson({ caller, command, instance, plan }) });
          const queued = { ...prepared, operationId: operation.id }; save(queued); return queued;
        });
      } catch {
        record = persistence.transaction(() => {
          const saved = read(key(caller, command.requestId));
          if (!saved) throw new PersistenceValidationError('Task action reservation is missing');
          if (saved.operationId || saved.receipt) return saved;
          const failed = { ...saved, receipt: receipt(command, 'rejected', 'Task action preparation failed or its authority changed before delivery.') }; save(failed); return failed;
        });
      }
      if (record.operationId) await dispatch(record.operationId);
      return project(record);
    },
    receipt(caller: string, raw: SourceRemoteActionReceiptQueryV1, scope: string | null) {
      const query = parseSourceRemoteActionReceiptQueryV1(raw); access(caller, query.repo, scope); const record = find(caller, query); return record ? project(record) : null;
    },
    async retry(caller: string, raw: SourceRemoteActionReceiptQueryV1, scope: string | null) {
      const query = parseSourceRemoteActionReceiptQueryV1(raw); access(caller, query.repo, scope); const record = find(caller, query);
      if (!record) throw new ClarificationServiceError(404, 'not-found');
      if (record.operationId) {
        const operation = checkedOperation(record);
        if (operation.status === 'blocked' && !operation.requiresReconciliation && operation.diagnostic?.code === 'delivery-blocked') {
          const attempt = operations.attempts(operation.id).at(-1);
          const evidence = attempt?.kind === 'definitely-not-applied' ? sourceObject(attempt.evidence) : null;
          const proof = evidence?.status === 'definitely-not-applied' ? sourceObject(evidence.evidence) : null;
          if (proof?.manualRetryAllowed === true) {
            current(record);
            operations.retry(operation.id, { actor: caller, reason: 'Explicit retry after provider proved no write occurred', evidence: { requestId: query.requestId } });
          }
        }
        await dispatch(record.operationId);
      }
      return project(record);
    },
  };
}
export type TaskActionServerService = ReturnType<typeof createTaskActionService>;
