import type { PluginJson } from './backend';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from './task-read';
import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';
import type { SourceCommandResultV1 } from './source-command';
import { invalidSourceContract, sourceFields, sourceInteger, sourceJson, sourceObject, sourceText, sourceUuid } from './source-contract-validation';

export interface SourceRemoteActionInputV1 {
  readonly version: 1; readonly action: 'assign-self'; readonly selection: TaskReadSelectionV1; readonly sourceRevision: number;
  readonly target: { readonly ref: WorkRefV1; readonly repo: string; readonly expectedRevision: string };
}
export type SourceRemoteActionRequestV1 = SourceRemoteActionInputV1;
export interface SourceRemoteActionCommandV1 extends SourceRemoteActionInputV1 { readonly requestId: string; }
export interface SourceRemoteActionOutcomeV1 { readonly ref: WorkRefV1; readonly repo: string; readonly revision: string; readonly accountId: string; }
export type SourceRemoteActionPlanV1 =
  | { readonly version: 1; readonly action: 'assign-self'; readonly kind: 'acknowledged'; readonly result: SourceRemoteActionOutcomeV1 }
  | { readonly version: 1; readonly action: 'assign-self'; readonly kind: 'effect'; readonly effectId: string; readonly target: PluginJson; readonly payload: PluginJson; readonly receipt: PluginJson };
export interface SourceRemoteActionReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface SourceRemoteActionReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: SourceRemoteActionInputV1;
  readonly status: 'pending' | 'succeeded' | 'rejected' | 'recovery-required'; readonly result: SourceRemoteActionOutcomeV1 | null; readonly reason: string | null;
  readonly resolution?: { readonly version: 1; readonly id: string; readonly kind: 'not-applied' };
}
export interface SourceRemoteActionPendingV1 { readonly command: SourceRemoteActionCommandV1; readonly receipt: SourceRemoteActionReceiptV1 | null; }
export interface SourceRemoteActionDiscoveryV1 { readonly version: 1; readonly selection: TaskReadSelectionV1; readonly sourceRevision: number; readonly actions: readonly 'assign-self'[]; }
export type SourceRemoteActionResultV1<T> = SourceCommandResultV1<T>;
export interface TaskActionServiceV1 {
  readonly version: 1;
  discover(selection: TaskReadSelectionV1, signal?: AbortSignal): Promise<SourceRemoteActionResultV1<SourceRemoteActionDiscoveryV1>>;
  submit(input: SourceRemoteActionInputV1, signal?: AbortSignal): Promise<SourceRemoteActionResultV1<SourceRemoteActionReceiptV1>>;
  receipt(query: SourceRemoteActionReceiptQueryV1, signal?: AbortSignal): Promise<SourceRemoteActionResultV1<SourceRemoteActionReceiptV1 | null>>;
  retry(query: SourceRemoteActionReceiptQueryV1, signal?: AbortSignal): Promise<SourceRemoteActionResultV1<SourceRemoteActionReceiptV1>>;
  pending(): Promise<readonly SourceRemoteActionPendingV1[]>;
  acknowledge(query: SourceRemoteActionReceiptQueryV1): Promise<void>;
}
export const SOURCE_REMOTE_ACTION_LIMITS = Object.freeze({ responseBytes: 512 * 1024, pending: 256, aggregateBytes: 8 * 1024 * 1024 });
const same = (left: unknown, right: unknown) => JSON.stringify(sourceJson(left)) === JSON.stringify(sourceJson(right));
export function parseSourceRemoteActionInputV1(input: unknown): SourceRemoteActionInputV1 {
  const value = sourceObject(sourceJson(input)); sourceFields(value, ['version', 'action', 'selection', 'sourceRevision', 'target']);
  if (value.version !== 1 || value.action !== 'assign-self') invalidSourceContract();
  const selection = parseTaskReadSelectionV1(value.selection); const target = sourceObject(value.target); sourceFields(target, ['ref', 'repo', 'expectedRevision']);
  const ref = parseWorkRefV1(target.ref); const repo = parseTaskRepo(target.repo);
  if (ref.sourceId !== selection.sourceId || repo !== selection.repo) invalidSourceContract();
  return Object.freeze({ version: 1, action: 'assign-self', selection, sourceRevision: sourceInteger(value.sourceRevision),
    target: Object.freeze({ ref, repo, expectedRevision: sourceText(target.expectedRevision, 512) }) });
}
export const parseSourceRemoteActionRequestV1 = parseSourceRemoteActionInputV1;
export function parseSourceRemoteActionCommandV1(input: unknown): SourceRemoteActionCommandV1 {
  const { requestId, ...rest } = sourceObject(input);
  return Object.freeze({ ...parseSourceRemoteActionInputV1(rest), requestId: sourceUuid(requestId) });
}
export function parseSourceRemoteActionOutcomeV1(input: unknown, expected?: SourceRemoteActionInputV1): SourceRemoteActionOutcomeV1 {
  const value = sourceObject(input); sourceFields(value, ['ref', 'repo', 'revision', 'accountId']);
  const ref = parseWorkRefV1(value.ref); const repo = parseTaskRepo(value.repo);
  if (expected && (!same(ref, expected.target.ref) || repo !== expected.target.repo)) invalidSourceContract();
  return Object.freeze({ ref, repo, revision: sourceText(value.revision, 512), accountId: sourceText(value.accountId, 512) });
}
export function parseSourceRemoteActionPlanV1(input: unknown, expected?: SourceRemoteActionInputV1): SourceRemoteActionPlanV1 {
  const value = sourceObject(sourceJson(input));
  if (value.version !== 1 || value.action !== 'assign-self') invalidSourceContract();
  if (value.kind === 'acknowledged') {
    sourceFields(value, ['version', 'action', 'kind', 'result']);
    return Object.freeze({ version: 1, action: 'assign-self', kind: 'acknowledged', result: parseSourceRemoteActionOutcomeV1(value.result, expected) });
  }
  if (value.kind !== 'effect') invalidSourceContract();
  sourceFields(value, ['version', 'action', 'kind', 'effectId', 'target', 'payload', 'receipt']);
  return Object.freeze({ version: 1, action: 'assign-self', kind: 'effect', effectId: sourceText(value.effectId, 100),
    target: sourceJson(value.target), payload: sourceJson(value.payload), receipt: sourceJson(value.receipt) });
}
export function parseSourceRemoteActionReceiptQueryV1(input: unknown): SourceRemoteActionReceiptQueryV1 {
  const value = sourceObject(input); sourceFields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: sourceUuid(value.requestId) });
}
export function parseSourceRemoteActionReceiptV1(input: unknown, expected?: SourceRemoteActionCommandV1 | SourceRemoteActionReceiptQueryV1): SourceRemoteActionReceiptV1 {
  const value = sourceObject(sourceJson(input, SOURCE_REMOTE_ACTION_LIMITS.responseBytes)); sourceFields(value, ['version', 'requestId', 'input', 'status', 'result', 'reason'], ['resolution']);
  if (value.version !== 1 || !['pending', 'succeeded', 'rejected', 'recovery-required'].includes(String(value.status)) || (value.status === 'succeeded') !== (value.result !== null)) invalidSourceContract();
  const commandInput = parseSourceRemoteActionInputV1(value.input); const requestId = sourceUuid(value.requestId);
  if (expected && (requestId !== expected.requestId || commandInput.selection.repo !== ('selection' in expected ? expected.selection.repo : expected.repo))) invalidSourceContract();
  if (expected && 'selection' in expected) { const { requestId: _id, ...input } = parseSourceRemoteActionCommandV1(expected); if (!same(input, commandInput)) invalidSourceContract(); }
  let resolution: SourceRemoteActionReceiptV1['resolution'];
  if (value.resolution !== undefined) {
    const raw = sourceObject(value.resolution); sourceFields(raw, ['version', 'id', 'kind']);
    if (raw.version !== 1 || raw.kind !== 'not-applied' || value.status !== 'rejected') invalidSourceContract();
    resolution = Object.freeze({ version: 1, id: sourceUuid(raw.id), kind: 'not-applied' });
  }
  return Object.freeze({ version: 1, requestId, input: commandInput, status: value.status as SourceRemoteActionReceiptV1['status'],
    result: value.result === null ? null : parseSourceRemoteActionOutcomeV1(value.result, commandInput), reason: value.reason === null ? null : sourceText(value.reason, 2048), ...(resolution ? { resolution } : {}) });
}
export function parseSourceRemoteActionDiscoveryV1(input: unknown, expected?: TaskReadSelectionV1): SourceRemoteActionDiscoveryV1 {
  const value = sourceObject(input); sourceFields(value, ['version', 'selection', 'sourceRevision', 'actions']);
  if (value.version !== 1 || !Array.isArray(value.actions) || value.actions.length > 1 || value.actions.some(action => action !== 'assign-self')) invalidSourceContract();
  const selection = parseTaskReadSelectionV1(value.selection); if (expected && !same(selection, parseTaskReadSelectionV1(expected))) invalidSourceContract();
  return Object.freeze({ version: 1, selection, sourceRevision: sourceInteger(value.sourceRevision), actions: Object.freeze([...value.actions]) as readonly 'assign-self'[] });
}
