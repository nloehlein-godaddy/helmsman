import { awaitSourceResult } from './source-await';
import { parseTaskEditQueryV1, parseTaskEditLoadQueryV1, parseTaskEditListQueryV1, parseTaskEditEnvelopeV1, parseTaskEditPageV1,
  type TaskEditQueryV1, type TaskEditDiscoveryV1, type TaskEditEnvelopeV1, type TaskEditPageV1, type TaskEditorDeclarationV1 } from '../../src/plugins/task-edit';
import { type SourceInstanceV1 } from '../../src/plugins/tasks';
import type { TaskSourceStore } from './task-sources/store';
import type { TaskSourceRegistry } from './task-sources/registry';
import type { TaskSourceService } from './task-source-service';
import { PersistenceConflictError, stableJson } from './persistence';

export interface TaskEditorServerOptions {
  store: TaskSourceStore; registry: TaskSourceRegistry; service: TaskSourceService; repos(): readonly string[];
  getRun?(runId: string): { id: string; repo: string } | null;
}
export function resolveTaskEditor(options: TaskEditorServerOptions, query: TaskEditQueryV1): { instance: SourceInstanceV1; sourceRevision: number; declaration: TaskEditorDeclarationV1 } {
  const { selection, editor } = query;
  const source = options.store.source(selection.sourceId); const instance = options.store.instance(selection.instanceId);
  if (!options.repos().includes(selection.repo) || !source || !instance || instance.sourceId !== source.id
    || instance.revision !== selection.instanceRevision) throw new PersistenceConflictError('Task editor selection changed');
  options.service.assertScope(instance, selection.repo, 'admission');
  const registration = options.registry.resolve(instance, 'admission');
  const declaration = registration.declaration.editorContracts?.find(item => item.id === editor.id && item.version === editor.version);
  if (!declaration || !registration.provider.readEditor || !registration.provider.listEditableTasks) throw new PersistenceConflictError('Task editor is unavailable');
  return { instance, sourceRevision: source.revision, declaration };
}
export function createTaskEditService(options: TaskEditorServerOptions) {
  function relatedRun(envelope: TaskEditEnvelopeV1): TaskEditEnvelopeV1['relatedRun'] {
    const suggested = envelope.relatedRun;
    if (!envelope.target || !suggested) return null;
    try {
      const actual = options.getRun?.(suggested.runId);
      return actual?.id === suggested.runId && actual?.repo === envelope.selection.repo ? suggested : null;
    } catch { return null; }
  }
  function unchanged(query: TaskEditQueryV1, original: ReturnType<typeof resolveTaskEditor>): void {
    const current = resolveTaskEditor(options, query);
    if (current.sourceRevision !== original.sourceRevision || stableJson(current.instance) !== stableJson(original.instance)
      || stableJson(current.declaration) !== stableJson(original.declaration)) throw new PersistenceConflictError('Task editor selection changed');
  }
  async function read(query: TaskEditQueryV1 & { ref?: Parameters<TaskSourceService['load']>[0]['ref'] }, signal: AbortSignal): Promise<TaskEditEnvelopeV1 | null> {
    const selected = resolveTaskEditor(options, query); const registration = options.registry.resolve(selected.instance, 'admission');
    const document = await awaitSourceResult(registration.provider.readEditor!({ editor: query.editor, ref: query.ref ?? null }, options.service.context(selected.instance, query.selection.repo, signal)), signal);
    signal.throwIfAborted(); unchanged(query, selected);
    if (document === null) {
      if (!query.ref) throw new PersistenceConflictError('Task source did not provide a create editor');
      return null;
    }
    const envelope = parseTaskEditEnvelopeV1({ ...document, selection: query.selection, sourceRevision: selected.sourceRevision }, query);
    for (const action of ['create', 'update', 'delete'] as const) {
      if (envelope.commands[action] && envelope.commands[action]?.commandId !== selected.declaration.commands[action]) throw new PersistenceConflictError('Task editor returned an undeclared command');
    }
    if (envelope.destinationRepos.some(repo => !selected.instance.allowedRepos.includes(repo))) throw new PersistenceConflictError('Task editor returned an unauthorized destination');
    if (envelope.target) options.store.assertUnquarantined(envelope.target.ref);
    return Object.freeze({ ...envelope, relatedRun: relatedRun(envelope), destinationRepos: Object.freeze(envelope.destinationRepos.filter(repo => options.repos().includes(repo))) });
  }
  return {
    discover(repo: string | null): TaskEditDiscoveryV1 {
      const repos = options.repos().filter(item => repo === null || item === repo);
      if (repo !== null && !repos.length) throw new PersistenceConflictError('Task editor galleon is unavailable');
      const sources: TaskEditDiscoveryV1['sources'][number][] = [];
      for (const repo of repos) for (const instance of options.store.instances().filter(instance => instance.allowedRepos.includes(repo))) {
        let availability: 'available' | 'disabled' | 'unavailable' = instance.desiredEnabled ? 'available' : 'disabled';
        let editors: readonly TaskEditorDeclarationV1[] = [];
        try { options.service.assertScope(instance, repo, 'admission'); editors = options.registry.resolve(instance, 'admission').declaration.editorContracts ?? []; }
        catch { if (availability === 'available') availability = 'unavailable'; }
        sources.push({ selection: { version: 1, sourceId: instance.sourceId, instanceId: instance.id, instanceRevision: instance.revision, repo }, label: instance.label, availability, editors });
      }
      if (sources.length > 1000) throw new PersistenceConflictError('Task editor discovery exceeds its bound');
      return { version: 1, repo, sources };
    },
    async create(input: unknown, signal: AbortSignal) { return (await read(parseTaskEditQueryV1(input), signal))!; },
    async load(input: unknown, signal: AbortSignal) { return read(parseTaskEditLoadQueryV1(input), signal); },
    async list(input: unknown, signal: AbortSignal): Promise<TaskEditPageV1> {
      const query = parseTaskEditListQueryV1(input); const selected = resolveTaskEditor(options, query);
      const provider = options.registry.resolve(selected.instance, 'admission').provider;
      const raw = await awaitSourceResult(provider.listEditableTasks!({ repo: query.selection.repo, editor: query.editor, filter: query.filter, cursor: query.cursor, limit: query.limit }, options.service.context(selected.instance, query.selection.repo, signal)), signal);
      signal.throwIfAborted(); unchanged(query, selected);
      const page = parseTaskEditPageV1(raw, query, true);
      if (page.items.length > query.limit || page.nextCursor !== null && page.nextCursor === query.cursor) throw new PersistenceConflictError('Invalid editor task page');
      options.store.persistence.transaction(() => { for (const task of page.items) options.store.recordAlias({ ...task.ref, displayKey: task.displayKey, evidence: { revision: task.revision, repo: task.repo } }); });
      return page;
    },
  };
}
export type TaskEditServerService = ReturnType<typeof createTaskEditService>;
