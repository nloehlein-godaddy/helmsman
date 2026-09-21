import { parseTaskHistoryQueryV1, parseTaskHistoryV1, type TaskHistoryQueryV1 } from '../../src/plugins/activity-read';
import { createTaskSourceRefreshService, type TaskSourceRefreshOptions } from './task-source-refresh';
import { createTaskSourceAdoptionService } from './task-source-adoption';
import type { PluginJson } from '../../src/plugins/backend';
import { parseLocalSourceCommandPlanV1, parseTaskPageV1, parseTaskRepo, parseTaskSnapshotV1, parseWorkRefV1, TASK_SOURCE_LIMITS,
  type SourceCallContextV1, type SourceInstanceV1, type SourceReadHttpV1,
  type TaskSnapshotV1, type WorkRefV1 } from '../../src/plugins/tasks';
import { pluginJson } from './plugins/data';
import { PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { LocalSourceAdapter } from './task-sources/local-records';
import type { SourceResolutionPurpose, TaskSourceRegistry } from './task-sources/registry';
import type { TaskSourceStore } from './task-sources/store';

import { createTaskSourceViews, TaskSourceViewUnavailableError } from './task-source-views';
export { TaskSourceViewUnavailableError } from './task-source-views';

export function createTaskSourceService(options: {
  store: TaskSourceStore;
  registry: TaskSourceRegistry;
  local: LocalSourceAdapter;
  refresh?: TaskSourceRefreshOptions;
  http(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal, purpose: SourceResolutionPurpose, authorize: () => void): SourceReadHttpV1;
}) {
  const { store, registry, local } = options;
  function assertScope(instance: SourceInstanceV1, repo: string | null, purpose: SourceResolutionPurpose): void {
    registry.resolve(instance, purpose);
    if (repo !== null && !instance.allowedRepos.includes(parseTaskRepo(repo))) throw new PersistenceConflictError('Task source is not authorized for this galleon');
    if (purpose === 'obligation') return;
    const current = store.instance(instance.id);
    const source = store.source(instance.sourceId);
    const selected = source && store.instance(source.currentInstanceId);
    if (!source?.conversionReady || !current || current.revision !== instance.revision || stableJson(current) !== stableJson(instance)
      || !selected || selected.binding.pluginId !== instance.binding.pluginId || selected.binding.providerId !== instance.binding.providerId || selected.binding.artifactHash !== instance.binding.artifactHash) throw new PersistenceConflictError('Task source selection changed or ownership conversion is incomplete');
  }
  function context(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal, purpose: SourceResolutionPurpose = 'admission'): SourceCallContextV1 {
    assertScope(instance, repo, purpose); signal.throwIfAborted();
    const registration = registry.resolve(instance, purpose);
    const records = registration.declaration.access.includes('local-records') ? local.forContext(instance, repo, signal) : null;
    const http = registration.declaration.access.includes('connection-http') ? options.http(instance, repo, signal, purpose, () => assertScope(instance, repo, purpose)) : null;
    const checked = async <T>(fn: () => Promise<T>) => {
      signal.throwIfAborted(); assertScope(instance, repo, purpose);
      const result = await fn(); signal.throwIfAborted(); assertScope(instance, repo, purpose); return result;
    };
    return Object.freeze({ instance, repo, signal,
      local: records ? Object.freeze({ describeCollection: () => checked(() => records.describeCollection()),
        get: (externalId: string) => checked(() => records.get(externalId)), list: (input: Parameters<typeof records.list>[0]) => checked(() => records.list(input)) }) : null,
      http: http ? Object.freeze({ get: (input: Parameters<typeof http.get>[0]) => checked(() => http.get(input)),
        ...(http.query ? { query: (input: Parameters<NonNullable<typeof http.query>>[0]) => checked(() => http.query!(input)) } : {}) }) : null });
  }
  function selected(instanceId: string, expectedRevision: number, repo: string): SourceInstanceV1 {
    const instance = store.instance(instanceId);
    if (!instance || instance.revision !== expectedRevision) throw new PersistenceConflictError('Task source instance revision changed');
    assertScope(instance, repo, 'admission'); return instance;
  }
  function recordAlias(task: TaskSnapshotV1, requireAvailable = true): void {
    store.recordAlias({ sourceId: task.ref.sourceId, externalId: task.ref.externalId, displayKey: task.displayKey, evidence: { revision: task.revision, repo: task.repo } });
    if (requireAvailable) store.assertUnquarantined(task.ref, task.displayKey);
  }
  return {
    ...createTaskSourceViews({ registry, selected, context, assertScope }),
    context, assertScope, adoption: createTaskSourceAdoptionService(options),
    refresh: createTaskSourceRefreshService({ ...options, ...(options.refresh ?? { connection: () => null, identityFormat: () => null }) }),
    configure(input: { instanceId: string; instanceRevision: number; desiredEnabled?: boolean; label?: string; settings?: Readonly<Record<string, PluginJson>>; allowedRepos?: readonly string[] }) {
      const value = pluginJson(input, { maxBytes: 128 * 1024, maxNodes: 16_384 }) as unknown as typeof input;
      if (!value || Object.keys(value).some(key => !['instanceId', 'instanceRevision', 'desiredEnabled', 'label', 'settings', 'allowedRepos'].includes(key))
        || value.desiredEnabled !== undefined && typeof value.desiredEnabled !== 'boolean' || value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 240)
        || value.settings !== undefined && (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings))
        || value.allowedRepos !== undefined && (!Array.isArray(value.allowedRepos) || value.allowedRepos.length > 1000)) throw new PersistenceValidationError('Invalid source configuration');
      value.allowedRepos?.forEach(parseTaskRepo);
      const instance = store.instance(value.instanceId);
      if (!instance || instance.revision !== value.instanceRevision) throw new PersistenceConflictError('Task source instance revision changed');
      registry.resolve(instance, 'obligation');
      return store.configureInstance({ instanceId: instance.id, expectedRevision: instance.revision,
        ...(value.desiredEnabled === undefined ? {} : { desiredEnabled: value.desiredEnabled }), ...(value.label === undefined ? {} : { label: value.label }),
        ...(value.settings === undefined ? {} : { settings: value.settings }), ...(value.allowedRepos === undefined ? {} : { allowedRepos: value.allowedRepos }) });
    },
    instances(repo: string | null) {
      if (repo !== null) parseTaskRepo(repo);
      return store.instances().filter(instance => repo === null || instance.allowedRepos.includes(repo)).map(instance => {
        let available = true;
        try { assertScope(instance, repo, 'admission'); } catch { available = false; }
        const registration = available ? registry.resolve(instance, 'admission') : null;
        return { id: instance.id, sourceId: instance.sourceId, label: instance.label, revision: instance.revision, desiredEnabled: instance.desiredEnabled,
          available, identityLevel: instance.identityLevel, commands: registration?.declaration.commandIds ?? [],
          readViews: registration?.declaration.readViews ?? [],
          providerId: instance.binding.providerId, allowedRepos: instance.allowedRepos, settings: instance.settings };
      });
    },
    async list(input: { instanceId: string; instanceRevision: number; repo: string; state: TaskSnapshotV1['state'] | null; cursor: string | null; limit: number }, signal: AbortSignal) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > TASK_SOURCE_LIMITS.pageItems
        || input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length > TASK_SOURCE_LIMITS.cursorLength)
        || input.state !== null && !['ready', 'in_progress', 'review', 'done', 'blocked'].includes(input.state)) throw new PersistenceValidationError('Invalid task source query');
      const instance = selected(input.instanceId, input.instanceRevision, input.repo);
      const result = await registry.resolve(instance, 'admission').provider.list({ repo: input.repo, state: input.state, cursor: input.cursor, limit: input.limit }, context(instance, input.repo, signal));
      signal.throwIfAborted(); assertScope(instance, input.repo, 'admission');
      const page = parseTaskPageV1(result, { sourceId: instance.sourceId, repo: input.repo });
      if (page.items.length > input.limit) throw new PersistenceValidationError('Task source exceeded the requested page size');
      store.persistence.transaction(() => { for (const task of page.items) recordAlias(task, false); });
      return page;
    },
    async listUnderway(input: { instanceId: string; instanceRevision: number; repo: string; cursor: string | null; limit: number }, signal: AbortSignal) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > TASK_SOURCE_LIMITS.pageItems
        || input.cursor !== null && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > TASK_SOURCE_LIMITS.cursorLength)) throw new PersistenceValidationError('Invalid Underway query');
      const instance = selected(input.instanceId, input.instanceRevision, input.repo);
      const registration = registry.resolve(instance, 'admission');
      if (!registration.declaration.readViews?.includes('underway') || !registration.provider.listUnderway) throw new TaskSourceViewUnavailableError('This source does not provide the Underway view');
      const result = await registration.provider.listUnderway({ repo: input.repo, cursor: input.cursor, limit: input.limit }, context(instance, input.repo, signal));
      signal.throwIfAborted(); assertScope(instance, input.repo, 'admission');
      const page = parseTaskPageV1(result, { sourceId: instance.sourceId, repo: input.repo });
      if (page.items.length > input.limit || page.items.some(task => task.state === 'done') || page.nextCursor !== null && page.nextCursor === input.cursor) throw new PersistenceValidationError('Source returned an invalid Underway page');
      store.persistence.transaction(() => { for (const task of page.items) recordAlias(task, false); });
      return page;
    },
    async readHistory(input: TaskHistoryQueryV1 & { instanceId: string; instanceRevision: number }, signal: AbortSignal) {
      const query = parseTaskHistoryQueryV1(input); const instance = selected(input.instanceId, input.instanceRevision, query.repo);
      const registration = registry.resolve(instance, 'admission');
      if (!registration.declaration.readViews?.includes('history') || !registration.provider.readHistory) throw new TaskSourceViewUnavailableError('This source does not provide task history');
      const result = await registration.provider.readHistory(query, context(instance, query.repo, signal));
      signal.throwIfAborted(); assertScope(instance, query.repo, 'admission');
      return parseTaskHistoryV1(result, query, instance.sourceId);
    },
    assertLaunch(input: { instanceId: string; instanceRevision: number; repo: string; ref: WorkRefV1 }): void {
      const instance = selected(input.instanceId, input.instanceRevision, parseTaskRepo(input.repo));
      const ref = parseWorkRefV1(input.ref);
      if (ref.sourceId !== instance.sourceId) throw new PersistenceConflictError('Task belongs to another source');
      store.assertUnquarantined(ref);
    },
    async load(input: { instanceId: string; instanceRevision: number; repo: string; ref: WorkRefV1 }, signal: AbortSignal) {
      const instance = selected(input.instanceId, input.instanceRevision, input.repo);
      const ref = parseWorkRefV1(input.ref);
      if (ref.sourceId !== instance.sourceId) throw new PersistenceConflictError('Task belongs to another source');
      store.assertUnquarantined(ref);
      const result = await registry.resolve(instance, 'admission').provider.load(ref, context(instance, input.repo, signal));
      signal.throwIfAborted(); assertScope(instance, input.repo, 'admission');
      if (result === null) return null;
      const task = parseTaskSnapshotV1(result, { sourceId: ref.sourceId, repo: input.repo });
      if (task.ref.externalId !== ref.externalId) throw new PersistenceConflictError('Task source returned another item');
      recordAlias(task); return task;
    },
    async lookup(input: { instanceId: string; instanceRevision: number; repo: string; displayKey: string }, signal: AbortSignal) {
      const instance = selected(input.instanceId, input.instanceRevision, input.repo);
      if (typeof input.displayKey !== 'string' || !input.displayKey.trim() || input.displayKey.length > 512) throw new PersistenceValidationError('Invalid task display key');
      const result = await registry.resolve(instance, 'admission').provider.lookup({ displayKey: input.displayKey }, context(instance, input.repo, signal));
      signal.throwIfAborted(); assertScope(instance, input.repo, 'admission');
      if (result === null) return null;
      const ref = parseWorkRefV1(result);
      if (ref.sourceId !== instance.sourceId) throw new PersistenceConflictError('Task source returned another namespace');
      store.recordAlias({ ...ref, displayKey: input.displayKey, evidence: { instanceRevision: instance.revision, repo: input.repo } });
      store.assertUnquarantined(ref, input.displayKey); return ref;
    },
    async command(input: { instanceId: string; instanceRevision: number; repo: string; commandId: string; requestId: string; input: PluginJson }, signal: AbortSignal, authorizeCommit?: () => void) {
      const instance = selected(input.instanceId, input.instanceRevision, input.repo);
      const registration = registry.resolve(instance, 'admission');
      const handler = registration.provider.commands?.[input.commandId];
      if (!registration.declaration.commandIds.includes(input.commandId) || !handler) throw new PersistenceConflictError('Task source command is unavailable');
      const commandInput = pluginJson(input.input, { maxBytes: TASK_SOURCE_LIMITS.taskBytes, maxNodes: 16_384 });
      signal.throwIfAborted();
      const receipt = local.commandResult({ requestId: input.requestId, instance, repo: input.repo, commandId: input.commandId, commandInput });
      if (receipt.found) return receipt.result;
      const plan = parseLocalSourceCommandPlanV1(await handler.prepare(commandInput, context(instance, input.repo, signal)));
      signal.throwIfAborted(); assertScope(instance, input.repo, 'admission');
      return store.persistence.transaction(() => {
        assertScope(instance, input.repo, 'admission');
        authorizeCommit?.();
        return local.applyCommand({ requestId: input.requestId, instance, repo: input.repo, commandId: input.commandId, commandInput, plan });
      });
    },
  };
}

export type TaskSourceService = ReturnType<typeof createTaskSourceService>;
