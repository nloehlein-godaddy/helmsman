import { parseTaskEditorContractV1, type TaskEditorContractV1, type TaskEditorDeclarationV1, type TaskEditActionV1 } from './task-editor-contract';
export * from './task-editor-contract';
import type { PluginJson } from './backend';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1, type TaskReadTaskV1, type TaskReadResultV1 } from './task-read';
import { parseTaskRepo, parseWorkRefV1, parseTaskPageV1, type TaskSnapshotV1, type WorkRefV1 } from './tasks';
import { invalidSourceContract, sourceFields, sourceInteger, sourceJson, sourceObject, sourceText } from './source-contract-validation';

export interface TaskEditQueryV1 { readonly selection: TaskReadSelectionV1; readonly editor: TaskEditorContractV1; }
export interface TaskEditLoadQueryV1 extends TaskEditQueryV1 { readonly ref: WorkRefV1; }
export interface TaskEditListQueryV1 extends TaskEditQueryV1 { readonly filter: PluginJson; readonly cursor: string | null; readonly limit: number; }
export interface TaskEditAvailabilityV1 { readonly commandId: string; readonly available: boolean; readonly reason: string | null; }
export interface TaskEditorDocumentV1 {
  readonly version: 1;
  readonly editor: TaskEditorContractV1;
  readonly target: { readonly ref: WorkRefV1; readonly revision: string } | null;
  readonly value: PluginJson;
  readonly commands: Readonly<Record<TaskEditActionV1, TaskEditAvailabilityV1 | null>>;
  readonly destinationRepos: readonly string[];
  readonly relatedRun: { readonly repo: string; readonly runId: string } | null;
}
export interface TaskEditEnvelopeV1 extends TaskEditorDocumentV1 { readonly selection: TaskReadSelectionV1; readonly sourceRevision: number; }
export interface TaskEditSourceV1 { readonly selection: TaskReadSelectionV1; readonly label: string; readonly availability: 'available' | 'disabled' | 'unavailable'; readonly editors: readonly TaskEditorDeclarationV1[]; }
export interface TaskEditDiscoveryV1 { readonly version: 1; readonly repo: string | null; readonly sources: readonly TaskEditSourceV1[]; }
export interface TaskEditListItemV1 extends TaskReadTaskV1 { readonly createdAt: string | null; readonly updatedAt: string | null; }
export interface TaskEditorPageV1 { readonly items: readonly (TaskSnapshotV1 & { readonly createdAt: string | null; readonly updatedAt: string | null })[]; readonly nextCursor: string | null; readonly total: number | null; }
export interface TaskEditPageV1 { readonly selection: TaskReadSelectionV1; readonly items: readonly TaskEditListItemV1[]; readonly nextCursor: string | null; readonly total: number | null; }
export interface TaskEditServiceV1 {
  readonly version: 1;
  discover(signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditDiscoveryV1>>;
  create(input: TaskEditQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditEnvelopeV1>>;
  load(input: TaskEditLoadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditEnvelopeV1 | null>>;
  list(input: TaskEditListQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditPageV1>>;
}
export const LOCAL_TASK_EDITOR_V1: TaskEditorContractV1 = Object.freeze({ id: 'helmsman/local-task-editor', version: 1 });
export function parseTaskEditQueryV1(input: unknown): TaskEditQueryV1 {
  const value = sourceObject(input); sourceFields(value, ['selection', 'editor']);
  return Object.freeze({ selection: parseTaskReadSelectionV1(value.selection), editor: parseTaskEditorContractV1(value.editor) });
}
export function parseTaskEditLoadQueryV1(input: unknown): TaskEditLoadQueryV1 {
  const value = sourceObject(input); sourceFields(value, ['selection', 'editor', 'ref']);
  const query = parseTaskEditQueryV1({ selection: value.selection, editor: value.editor }); const ref = parseWorkRefV1(value.ref);
  if (ref.sourceId !== query.selection.sourceId) invalidSourceContract(); return Object.freeze({ ...query, ref: Object.freeze(ref) });
}
export function parseTaskEditListQueryV1(input: unknown): TaskEditListQueryV1 {
  const value = sourceObject(input); sourceFields(value, ['selection', 'editor', 'filter', 'cursor', 'limit']);
  const query = parseTaskEditQueryV1({ selection: value.selection, editor: value.editor }); const limit = sourceInteger(value.limit);
  if (limit > 100) invalidSourceContract();
  return Object.freeze({ ...query, filter: sourceJson(value.filter, 4096), cursor: value.cursor === null ? null : sourceText(value.cursor, 2048), limit });
}
export function parseTaskEditorDocumentV1(input: unknown): TaskEditorDocumentV1 {
  const value = sourceObject(sourceJson(input)); sourceFields(value, ['version', 'editor', 'target', 'value', 'commands', 'destinationRepos', 'relatedRun']);
  if (value.version !== 1 || !Array.isArray(value.destinationRepos) || value.destinationRepos.length > 1000) invalidSourceContract();
  const editor = parseTaskEditorContractV1(value.editor); const rawTarget = value.target === null ? null : sourceObject(value.target);
  if (rawTarget) sourceFields(rawTarget, ['ref', 'revision']);
  const target = rawTarget ? Object.freeze({ ref: Object.freeze(parseWorkRefV1(rawTarget.ref)), revision: sourceText(rawTarget.revision, 512) }) : null;
  const raw = sourceObject(value.commands); sourceFields(raw, ['create', 'update', 'delete']);
  const available = (action: TaskEditActionV1): TaskEditAvailabilityV1 | null => {
    if (raw[action] === null) return null;
    const command = sourceObject(raw[action]); sourceFields(command, ['commandId', 'available', 'reason']);
    if (typeof command.available !== 'boolean' || command.available && command.reason !== null || !command.available && command.reason === null) invalidSourceContract();
    return Object.freeze({ commandId: sourceText(command.commandId, 100), available: command.available, reason: command.reason === null ? null : sourceText(command.reason, 512) });
  };
  const destinationRepos = Object.freeze(value.destinationRepos.map(parseTaskRepo));
  if (new Set(destinationRepos).size !== destinationRepos.length) invalidSourceContract();
  const related = value.relatedRun === null ? null : sourceObject(value.relatedRun);
  if (related) sourceFields(related, ['repo', 'runId']);
  return Object.freeze({ version: 1, editor, target, value: sourceJson(value.value),
    commands: Object.freeze({ create: available('create'), update: available('update'), delete: available('delete') }), destinationRepos,
    relatedRun: related ? Object.freeze({ repo: parseTaskRepo(related.repo), runId: sourceText(related.runId, 128) }) : null });
}
export function parseTaskEditEnvelopeV1(input: unknown, expected?: TaskEditQueryV1 & { ref?: WorkRefV1 }): TaskEditEnvelopeV1 {
  const value = sourceObject(input); const { selection: rawSelection, sourceRevision: rawRevision, ...rawDocument } = value;
  const document = parseTaskEditorDocumentV1(rawDocument); const selection = parseTaskReadSelectionV1(rawSelection);
  if (document.target && document.target.ref.sourceId !== selection.sourceId || document.relatedRun && document.relatedRun.repo !== selection.repo
    || expected && (JSON.stringify(selection) !== JSON.stringify(expected.selection) || JSON.stringify(document.editor) !== JSON.stringify(expected.editor)
      || (expected.ref ? !document.target || JSON.stringify(sourceJson(document.target.ref)) !== JSON.stringify(sourceJson(expected.ref)) : document.target !== null))) invalidSourceContract();
  return Object.freeze({ ...document, selection, sourceRevision: sourceInteger(rawRevision) });
}

export function parseTaskEditPageV1(input: unknown, query: TaskEditListQueryV1, provider: boolean = false): TaskEditPageV1 {
  query = parseTaskEditListQueryV1(query); const value = sourceObject(input);
  sourceFields(value, provider ? ['items', 'nextCursor', 'total'] : ['selection', 'items', 'nextCursor', 'total']);
  if (!provider && JSON.stringify(parseTaskReadSelectionV1(value.selection)) !== JSON.stringify(query.selection)
    || !Array.isArray(value.items) || value.items.length > query.limit
    || value.total !== null && (typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < value.items.length)) invalidSourceContract();
  const timestamp = (input: unknown): string | null => {
    if (input === null) return null; const value = sourceText(input, 128);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalidSourceContract(); return value;
  };
  const metadata = value.items.map(raw => { const item = sourceObject(raw); return { createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) }; });
  const tasks = value.items.map(raw => { const { createdAt: _created, updatedAt: _updated, ...task } = sourceObject(raw); if (!provider && 'providerData' in task) invalidSourceContract(); return provider ? task : { ...task, providerData: null }; });
  const page = parseTaskPageV1({ items: tasks, nextCursor: value.nextCursor }, query.selection);
  if (page.nextCursor !== null && page.nextCursor === query.cursor) invalidSourceContract();
  return Object.freeze({ selection: query.selection, nextCursor: page.nextCursor, total: value.total as number | null,
    items: Object.freeze(page.items.map(({ providerData: _data, ...task }, index) => Object.freeze({ ...task, ...metadata[index]! }))) });
}
