import type { PanelOpaqueStateV1, SourceCommandInputV1, SourceCommandPendingV1, TaskReadSelectionV1, WorkRefV1 } from '@helmsman/plugin-sdk';

export const priorities = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export const states = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
export interface Values { title: string; description: string; acceptanceCriteria: string; repo: string; priority: typeof priorities[number]; state: typeof states[number]; }
export interface Draft {
  key: string;
  selection: TaskReadSelectionV1;
  sourceRevision: number;
  target: { ref: WorkRefV1; revision: string } | null;
  destinationPolicy: 'inherit' | 'fixed';
  values: Values;
  baseline: Values;
  submitted: SourceCommandInputV1 | null;
}
export interface SavedState {
  selectedSource: TaskReadSelectionV1 | null;
  filters: { search: string; state: typeof states[number] | null };
  activeDraftKey: string | null;
  drafts: Draft[];
  consumedRequests: string[];
}
export const emptyState = (): SavedState => ({ selectedSource: null, filters: { search: '', state: null }, activeDraftKey: null, drafts: [], consumedRequests: [] });
export const stateLimit = 512 * 1024;
export function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) return null;
  return value as Record<string, unknown>;
}
function selectionValue(input: unknown): TaskReadSelectionV1 {
  const value = object(input);
  if (!value || value.version !== 1 || typeof value.sourceId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.sourceId)
    || typeof value.instanceId !== 'string' || !/^[a-z\d-]{1,160}$/i.test(value.instanceId) || !Number.isSafeInteger(value.instanceRevision) || Number(value.instanceRevision) < 1
    || typeof value.repo !== 'string' || value.repo.length > 512 || !/^[a-z\d_-][a-z\d_.-]*\/[a-z\d_-][a-z\d_.-]*$/i.test(value.repo)) throw new Error('Invalid source selection');
  return { version: 1, sourceId: value.sourceId, instanceId: value.instanceId, instanceRevision: value.instanceRevision as number, repo: value.repo };
}
function refValue(input: unknown): WorkRefV1 {
  const value = object(input);
  if (!value || typeof value.sourceId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.sourceId)
    || typeof value.externalId !== 'string' || !value.externalId.trim() || value.externalId.length > 1024 || /[\x00-\x1f\x7f]/.test(value.externalId)) throw new Error('Invalid task identity');
  return { sourceId: value.sourceId, externalId: value.externalId };
}
function submissionValue(input: unknown): SourceCommandInputV1 {
  const value = object(input); const editor = object(value?.editor);
  if (!value || value.version !== 1 || !editor || editor.id !== 'helmsman/local-task-editor' || editor.version !== 1
    || !Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) < 1 || !['create', 'update', 'delete'].includes(value.action as string)
    || typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 100) throw new Error('Invalid saved submission');
  const selection = selectionValue(value.selection); const target = value.target === null ? null : object(value.target);
  if (value.target !== null && (!target || typeof target.expectedRevision !== 'string' || !target.expectedRevision || target.expectedRevision.length > 512)) throw new Error('Invalid saved target');
  const ref = target ? refValue(target.ref) : null;
  if (ref && ref.sourceId !== selection.sourceId || (value.action === 'create') !== (target === null)
    || value.action === 'delete' && value.destinationRepo !== null || value.action !== 'delete' && (typeof value.destinationRepo !== 'string' || value.destinationRepo !== values(value.input)?.repo)
    || value.action === 'create' && value.destinationRepo !== selection.repo) throw new Error('Invalid saved destination');
  const fields = value.action === 'delete' ? object(value.input) : values(value.input);
  if (!fields || value.action === 'delete' && Object.keys(fields).length) throw new Error('Invalid saved fields');
  return { version: 1, selection, sourceRevision: value.sourceRevision as number, editor: { id: editor.id, version: 1 }, action: value.action as SourceCommandInputV1['action'],
    commandId: value.commandId, target: target && ref ? { ref, expectedRevision: target.expectedRevision as string } : null,
    destinationRepo: value.destinationRepo as string | null, input: { ...fields } as SourceCommandInputV1['input'] };
}
export function values(input: unknown): Values | null {
  const value = object(input);
  if (!value || typeof value.title !== 'string' || value.title.length > 240 || typeof value.description !== 'string' || value.description.length > 20_000
    || typeof value.acceptanceCriteria !== 'string' || value.acceptanceCriteria.length > 20_000 || typeof value.repo !== 'string'
    || !/^[a-z\d_-][a-z\d_.-]*\/[a-z\d_-][a-z\d_.-]*$/i.test(value.repo) || value.repo.length > 512
    || !priorities.includes(value.priority as Values['priority']) || !states.includes(value.state as Values['state'])
    || [value.title, value.description, value.acceptanceCriteria].some(field => field.includes('\0'))) return null;
  return { title: value.title, description: value.description, acceptanceCriteria: value.acceptanceCriteria, repo: value.repo,
    priority: value.priority as Values['priority'], state: value.state as Values['state'] };
}
export function sameSelection(a: TaskReadSelectionV1 | null, b: TaskReadSelectionV1 | null): boolean {
  return a === b || !!a && !!b && a.sourceId === b.sourceId && a.instanceId === b.instanceId && a.instanceRevision === b.instanceRevision && a.repo === b.repo;
}
export function sameValues(a: Values, b: Values): boolean { return (Object.keys(a) as (keyof Values)[]).every(key => a[key] === b[key]); }
export function readState(saved: PanelOpaqueStateV1 | null): SavedState | null {
  if (saved === null) return emptyState();
  try {
    if (saved.version !== 1 || new TextEncoder().encode(JSON.stringify(saved)).length > stateLimit) return null;
    const value = object(saved.value); const filters = object(value?.filters);
    if (!value || !filters || typeof filters.search !== 'string' || filters.search.length > 500 || filters.state !== null && !states.includes(filters.state as Values['state'])
      || value.activeDraftKey !== null && typeof value.activeDraftKey !== 'string' || !Array.isArray(value.drafts) || value.drafts.length > 100
      || !Array.isArray(value.consumedRequests) || value.consumedRequests.length > 1000 || value.consumedRequests.some(id => typeof id !== 'string' || id.length > 128)) return null;
    const drafts: Draft[] = [];
    for (const raw of value.drafts) {
      const draft = object(raw); const current = values(draft?.values); const baseline = values(draft?.baseline);
      if (!draft || !current || !baseline || typeof draft.key !== 'string' || !draft.key || draft.key.length > 128 || drafts.some(item => item.key === draft.key)
        || !Number.isSafeInteger(draft.sourceRevision) || Number(draft.sourceRevision) < 1 || !['inherit', 'fixed'].includes(draft.destinationPolicy as string)) return null;
      const selection = selectionValue(draft.selection);
      const rawTarget = draft.target === null ? null : object(draft.target);
      if (draft.target !== null && (!rawTarget || typeof rawTarget.revision !== 'string' || !rawTarget.revision || rawTarget.revision.length > 512)) return null;
      const target = rawTarget ? { ref: refValue(rawTarget.ref), revision: rawTarget.revision as string } : null;
      if (target && (target.ref.sourceId !== selection.sourceId || draft.destinationPolicy !== 'fixed')) return null;
      const submitted = draft.submitted === null ? null : submissionValue(draft.submitted);
      if (submitted && (!sameSelection(submitted.selection, selection) || submitted.sourceRevision !== draft.sourceRevision
        || (submitted.target === null) !== (target === null) || target && (submitted.target?.ref.sourceId !== target.ref.sourceId
          || submitted.target.ref.externalId !== target.ref.externalId || submitted.target.expectedRevision !== target.revision))) return null;
      drafts.push({ key: draft.key, selection, sourceRevision: draft.sourceRevision as number, target,
        destinationPolicy: draft.destinationPolicy as Draft['destinationPolicy'], values: current, baseline, submitted });
    }
    if (value.activeDraftKey !== null && !drafts.some(draft => draft.key === value.activeDraftKey)) return null;
    return { selectedSource: value.selectedSource === null ? null : selectionValue(value.selectedSource),
      filters: { search: filters.search, state: filters.state as Values['state'] | null }, activeDraftKey: value.activeDraftKey as string | null,
      drafts, consumedRequests: [...value.consumedRequests] as string[] };
  } catch { return null; }
}
export function saveValue(state: SavedState): PanelOpaqueStateV1 {
  const snapshot = JSON.parse(JSON.stringify({ version: 1, value: state })) as PanelOpaqueStateV1;
  if (!readState(snapshot)) throw new Error('Drafts could not be saved. Keep this panel open and shorten or remove another draft.');
  return snapshot;
}
export function followHeader(draft: Draft, selection: TaskReadSelectionV1, sourceRevision: number): Draft {
  if (draft.target || draft.submitted || draft.destinationPolicy !== 'inherit' || draft.selection.sourceId !== selection.sourceId
    || draft.selection.instanceId !== selection.instanceId || draft.selection.instanceRevision !== selection.instanceRevision) return draft;
  return { ...draft, selection, sourceRevision, values: { ...draft.values, repo: selection.repo }, baseline: { ...draft.baseline, repo: selection.repo } };
}
export function sameSubmission(input: SourceCommandInputV1 | null, entry: SourceCommandPendingV1): boolean {
  if (!input) return false;
  const { requestId: _requestId, ...command } = entry.command;
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)])) : value;
  return JSON.stringify(stable(input)) === JSON.stringify(stable(command));
}
export function consumeResult(state: SavedState, entry: SourceCommandPendingV1): SavedState {
  const receipt = entry.receipt;
  if (!receipt || !['succeeded', 'rejected'].includes(receipt.status) || state.consumedRequests.includes(entry.command.requestId)) return state;
  const draft = state.drafts.find(value => sameSubmission(value.submitted, entry));
  if (!draft) throw new Error('The original draft is unavailable. Keep this receipt until its draft can be reconciled.');
  const result = receipt.result;
  const submittedValues = values(entry.command.input);
  const drafts = state.drafts.flatMap(value => {
    if (value.key !== draft.key) return [value];
    if (!result) return [{ ...value, submitted: null }];
    if (result.kind === 'deleted') {
      if (sameValues(value.values, value.baseline)) return [];
      return [{ ...value, target: null, submitted: null, baseline: { ...value.values, title: '', description: '', acceptanceCriteria: '' } }];
    }
    if (!submittedValues) throw new Error('The submitted fields cannot be reconciled. Keep this receipt.');
    return [{ ...value, target: { ref: result.ref, revision: result.revision }, selection: { ...value.selection, repo: result.repo },
      destinationPolicy: 'fixed' as const, submitted: null, baseline: { ...submittedValues, repo: result.repo } }];
  });
  return { ...state, drafts, activeDraftKey: drafts.some(value => value.key === state.activeDraftKey) ? state.activeDraftKey : null,
    consumedRequests: [...state.consumedRequests, entry.command.requestId] };
}
