import type { PluginJson } from './backend';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from './task-read';
import { parseTaskEditorContractV1, type TaskEditorContractV1, type TaskEditActionV1 } from './task-edit';
import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';
import { invalidSourceContract, sourceFields, sourceInteger, sourceJson, sourceObject, sourceText, sourceUuid } from './source-contract-validation';

export interface SourceCommandTargetV1 { readonly ref: WorkRefV1; readonly expectedRevision: string; }
export interface SourceCommandInputV1 {
  readonly version: 1;
  readonly selection: TaskReadSelectionV1;
  readonly sourceRevision: number;
  readonly editor: TaskEditorContractV1;
  readonly action: TaskEditActionV1;
  readonly commandId: string;
  readonly target: SourceCommandTargetV1 | null;
  readonly destinationRepo: string | null;
  readonly input: PluginJson;
}
export interface SourceCommandV1 extends SourceCommandInputV1 { readonly requestId: string; }
export interface SourceCommandReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export type SourceCommandOutcomeV1 = { readonly kind: 'changed'; readonly ref: WorkRefV1; readonly repo: string; readonly revision: string }
  | { readonly kind: 'deleted'; readonly ref: WorkRefV1; readonly repo: string; readonly previousRevision: string };
export interface SourceCommandReceiptV1 extends Omit<SourceCommandV1, 'input'> {
  readonly status: 'pending' | 'succeeded' | 'rejected' | 'recovery-required';
  readonly result: SourceCommandOutcomeV1 | null;
  readonly message: string | null;
  readonly resolution?: { readonly version: 1; readonly id: string; readonly kind: 'not-applied' };
}
export interface SourceCommandPendingV1 { readonly command: SourceCommandV1; readonly receipt: SourceCommandReceiptV1 | null; }
export type SourceCommandUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict';
export type SourceCommandResultV1<T> = { readonly status: 'available'; readonly value: T } | { readonly status: 'unavailable'; readonly reason: SourceCommandUnavailableReasonV1 };
export interface SourceCommandServiceV1 {
  readonly version: 1;
  submit(input: SourceCommandInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1>>;
  retry?(query: SourceCommandReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1>>;
  receipt(input: SourceCommandReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1 | null>>;
  pending(): Promise<readonly SourceCommandPendingV1[]>;
  acknowledge(input: SourceCommandReceiptQueryV1): Promise<void>;
}
export const SOURCE_COMMAND_LIMITS: Readonly<{ responseBytes: number; pending: number; aggregateBytes: number }> = Object.freeze({ responseBytes: 512 * 1024, pending: 256, aggregateBytes: 8 * 1024 * 1024 });
export interface SourceCommandDefiniteRejectionV1 { readonly version: 1; readonly kind: 'rejected'; readonly message: string; }
export function parseSourceCommandDefiniteRejectionV1(input: unknown): SourceCommandDefiniteRejectionV1 {
  const value = sourceObject(input); sourceFields(value, ['version', 'kind', 'message']);
  if (value.version !== 1 || value.kind !== 'rejected') invalidSourceContract();
  return Object.freeze({ version: 1, kind: 'rejected', message: sourceText(value.message, 2048) });
}
function identity(input: unknown, identified: boolean): Omit<SourceCommandV1, 'input'> | Omit<SourceCommandInputV1, 'input'> {
  const value = sourceObject(input);
  const selection = parseTaskReadSelectionV1(value.selection); const editor = parseTaskEditorContractV1(value.editor);
  if (value.version !== 1 || !['create', 'update', 'delete'].includes(value.action as string)) invalidSourceContract();
  const rawTarget = value.target === null ? null : sourceObject(value.target);
  if (rawTarget) sourceFields(rawTarget, ['ref', 'expectedRevision']);
  const target = rawTarget ? Object.freeze({ ref: Object.freeze(parseWorkRefV1(rawTarget.ref)), expectedRevision: sourceText(rawTarget.expectedRevision, 512) }) : null;
  const destinationRepo = value.destinationRepo === null ? null : parseTaskRepo(value.destinationRepo);
  if ((value.action === 'create') !== (target === null) || (value.action === 'delete') !== (destinationRepo === null)
    || target && target.ref.sourceId !== selection.sourceId || value.action === 'create' && destinationRepo !== selection.repo) invalidSourceContract();
  return Object.freeze({ version: 1, selection, sourceRevision: sourceInteger(value.sourceRevision), editor, action: value.action as TaskEditActionV1,
    commandId: sourceText(value.commandId, 100), target, destinationRepo, ...(identified ? { requestId: sourceUuid(value.requestId) } : {}) });
}
const IDENTITY_FIELDS = ['version', 'selection', 'sourceRevision', 'editor', 'action', 'commandId', 'target', 'destinationRepo'];
export function parseSourceCommandInputV1(input: unknown): SourceCommandInputV1 {
  const value = sourceObject(input); sourceFields(value, [...IDENTITY_FIELDS, 'input']);
  return Object.freeze({ ...identity(value, false), input: sourceJson(value.input) });
}
export function parseSourceCommandV1(input: unknown): SourceCommandV1 {
  const value = sourceObject(input); sourceFields(value, [...IDENTITY_FIELDS, 'input', 'requestId']);
  return Object.freeze({ ...identity(value, true), input: sourceJson(value.input) }) as SourceCommandV1;
}
export function parseSourceCommandReceiptQueryV1(input: unknown): SourceCommandReceiptQueryV1 {
  const value = sourceObject(input); sourceFields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: sourceUuid(value.requestId) });
}
export function parseSourceCommandReceiptV1(input: unknown, expected?: SourceCommandV1 | SourceCommandReceiptQueryV1): SourceCommandReceiptV1 {
  const value = sourceObject(input); sourceFields(value, [...IDENTITY_FIELDS, 'requestId', 'status', 'result', 'message'], ['resolution']);
  const base = identity(value, true) as Omit<SourceCommandV1, 'input'>;
  if (!['pending', 'succeeded', 'rejected', 'recovery-required'].includes(value.status as string) || (value.status === 'succeeded') !== (value.result !== null)) invalidSourceContract();
  let result: SourceCommandOutcomeV1 | null = null;
  if (value.result !== null) {
    const raw = sourceObject(value.result); const deleted = raw.kind === 'deleted';
    if (raw.kind !== 'changed' && !deleted || deleted !== (base.action === 'delete')) invalidSourceContract();
    sourceFields(raw, ['kind', 'ref', 'repo', deleted ? 'previousRevision' : 'revision']);
    const ref = Object.freeze(parseWorkRefV1(raw.ref)); const repo = parseTaskRepo(raw.repo);
    if (ref.sourceId !== base.selection.sourceId || base.target && JSON.stringify(sourceJson(ref)) !== JSON.stringify(sourceJson(base.target.ref))
      || repo !== (deleted ? base.selection.repo : base.destinationRepo) || deleted && raw.previousRevision !== base.target?.expectedRevision) invalidSourceContract();
    result = deleted ? Object.freeze({ kind: 'deleted', ref, repo, previousRevision: sourceText(raw.previousRevision, 512) })
      : Object.freeze({ kind: 'changed', ref, repo, revision: sourceText(raw.revision, 512) });
  }
  let resolution: SourceCommandReceiptV1['resolution'];
  if (Object.hasOwn(value, 'resolution')) {
    const raw = sourceObject(value.resolution); sourceFields(raw, ['version', 'id', 'kind']);
    if (raw.version !== 1 || raw.kind !== 'not-applied' || value.status !== 'rejected') invalidSourceContract();
    resolution = Object.freeze({ version: 1, id: sourceUuid(raw.id), kind: 'not-applied' });
  }
  if (expected) {
    if (base.requestId !== expected.requestId || base.selection.repo !== ('selection' in expected ? expected.selection.repo : expected.repo)) invalidSourceContract();
    if ('selection' in expected) {
      const { input: _input, ...expectedIdentity } = parseSourceCommandV1(expected);
      if (JSON.stringify(sourceJson(base)) !== JSON.stringify(sourceJson(expectedIdentity))) invalidSourceContract();
    }
  }
  return Object.freeze({ ...base, status: value.status as SourceCommandReceiptV1['status'], result,
    message: value.message === null ? null : sourceText(value.message, 2048), ...(resolution ? { resolution } : {}) });
}
