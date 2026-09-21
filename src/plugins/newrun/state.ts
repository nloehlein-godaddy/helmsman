import type { PanelOpaqueStateV1, RunCommandInputV1, TaskReadSelectionV1, WorkRefV1 } from '@helmsman/plugin-sdk';

export type Mode = 'source' | 'freeform' | 'review' | 'rerun';
export interface Draft {
  mode: Mode; task: string; prNumber: string; feedback: string; model: string; effort: string; lookupKey: string;
  source: TaskReadSelectionV1 | null; ref: WorkRefV1 | null;
}
export interface DraftState { selectedRepo: string | null; drafts: { repo: string; draft: Draft }[]; }
export const efforts = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const emptyDraft = (): Draft => ({ mode: 'freeform', task: '', prNumber: '', feedback: '', model: '', effort: '', lookupKey: '', source: null, ref: null });
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) return null;
  return value as Record<string, unknown>;
}
export function validRepo(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..');
}
export function readState(saved: PanelOpaqueStateV1 | null): DraftState | null {
  if (saved === null) return { selectedRepo: null, drafts: [] };
  const value = record(saved?.value);
  if (saved?.version !== 1 || !value || value.selectedRepo !== null && !validRepo(value.selectedRepo)
    || !Array.isArray(value.drafts) || value.drafts.length > 100 || new TextEncoder().encode(JSON.stringify(saved)).length > 16 * 1024) return null;
  const drafts: DraftState['drafts'] = [];
  for (const item of value.drafts) {
    const entry = record(item); const draft = record(entry?.draft);
    if (!entry || !validRepo(entry.repo) || drafts.some(item => item.repo === entry.repo) || !draft
      || !['source', 'freeform', 'review', 'rerun'].includes(draft.mode as string)
      || ['task', 'prNumber', 'feedback', 'model', 'effort'].some(key => typeof draft[key] !== 'string')
      || draft.lookupKey !== undefined && typeof draft.lookupKey !== 'string') return null;
    const source = draft.source === null ? null : record(draft.source);
    const ref = draft.ref === null ? null : record(draft.ref);
    if (draft.source !== null && (!source || source.version !== 1 || source.repo !== entry.repo || typeof source.sourceId !== 'string'
      || typeof source.instanceId !== 'string' || !Number.isSafeInteger(source.instanceRevision) || Number(source.instanceRevision) < 1)
      || draft.ref !== null && (!ref || !source || ref.sourceId !== source.sourceId || typeof ref.externalId !== 'string' || !ref.externalId)) return null;
    drafts.push({ repo: entry.repo, draft: { mode: draft.mode as Mode, task: draft.task as string, prNumber: draft.prNumber as string,
      feedback: draft.feedback as string, model: draft.model as string, effort: draft.effort as string, lookupKey: draft.lookupKey as string | undefined ?? '',
      source: source ? { version: 1, sourceId: source.sourceId as string, instanceId: source.instanceId as string, instanceRevision: source.instanceRevision as number, repo: entry.repo } : null,
      ref: ref ? { sourceId: ref.sourceId as string, externalId: ref.externalId as string } : null } });
  }
  return { selectedRepo: value.selectedRepo as string | null, drafts };
}
export function saveValue(state: DraftState): PanelOpaqueStateV1 {
  const value: PanelOpaqueStateV1 = { version: 1, value: state };
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 16 * 1024) throw new Error('Drafts exceed the 16 KiB saved-state limit. Shorten a draft before saving; your current text is kept.');
  return JSON.parse(json) as PanelOpaqueStateV1;
}
export function launchInput(repo: string, draft: Draft): RunCommandInputV1 {
  if (!validRepo(repo)) throw new Error('Choose a galleon before launching.');
  if (draft.model && (!/^[a-z\d][a-z\d._-]*$/i.test(draft.model) || draft.model.length > 128)
    || !efforts.includes(draft.effort as typeof efforts[number])) throw new Error('Choose a valid model and effort.');
  const tuning = { ...(draft.model ? { model: draft.model } : {}), ...(draft.effort ? { effort: draft.effort } : {}) };
  const base = { version: 1 as const, repo, action: 'launch' as const };
  if (draft.mode === 'source') {
    if (!draft.source || draft.source.repo !== repo || !draft.ref || draft.ref.sourceId !== draft.source.sourceId) throw new Error('Choose a source and a task before launching.');
    return { ...base, launch: { mode: 'source', workRef: { ...draft.ref }, sourceInstanceId: draft.source.instanceId,
      sourceInstanceRevision: draft.source.instanceRevision, ...tuning } };
  }
  if (draft.mode === 'freeform') {
    if (!draft.task.trim() || draft.task.length > 20 * 1024) throw new Error('Enter task instructions of at most 20 KiB.');
    return { ...base, launch: { mode: 'freeform', task: draft.task, ...tuning } };
  }
  const prNumber = Number(draft.prNumber);
  if (!/^[1-9]\d*$/.test(draft.prNumber) || !Number.isSafeInteger(prNumber)) throw new Error('Enter a positive PR number.');
  if (draft.feedback.length > 20 * 1024) throw new Error('PR feedback exceeds 20 KiB.');
  return draft.mode === 'review' ? { ...base, launch: { mode: 'review', prNumber, ...tuning } }
    : { ...base, launch: { mode: 'rerun', prNumber, feedback: draft.feedback, ...tuning } };
}
