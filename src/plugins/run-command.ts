import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';

export type RunCommandLaunchV1 = (
  | { readonly mode: 'source'; readonly workRef: WorkRefV1; readonly sourceInstanceId: string; readonly sourceInstanceRevision: number }
  | { readonly mode: 'freeform'; readonly task: string }
  | { readonly mode: 'review'; readonly prNumber: number; readonly headSha?: string }
  | { readonly mode: 'rerun'; readonly prNumber: number; readonly feedback: string }
) & { readonly model?: string; readonly effort?: string };
export interface RunCommandTargetV1 { readonly runId: string; readonly expectedAttempt: number; }
export type RunCommandInputV1 = { readonly version: 1; readonly repo: string } & (
  | { readonly action: 'stop'; readonly target: RunCommandTargetV1 }
  | { readonly action: 'retry'; readonly target: RunCommandTargetV1 }
  | { readonly action: 'launch'; readonly launch: RunCommandLaunchV1 }
);
export type RunCommandV1 = RunCommandInputV1 & { readonly requestId: string };
export interface RunCommandReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface RunCommandReceiptV1 extends RunCommandReceiptQueryV1 {
  readonly version: 1;
  readonly action: RunCommandInputV1['action'];
  readonly status: 'accepted' | 'rejected' | 'pending' | 'recovery-required';
  readonly runId: string | null;
  readonly attempt: number | null;
  readonly message: string | null;
}
export interface RunCommandPendingV1 { readonly command: RunCommandV1; readonly receipt: RunCommandReceiptV1 | null; }
export type RunCommandUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable'
  | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict';
export type RunCommandResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: RunCommandUnavailableReasonV1 };
export interface RunCommandServiceV1 {
  readonly version: 1;
  submit(input: RunCommandInputV1, signal?: AbortSignal): Promise<RunCommandResultV1<RunCommandReceiptV1>>;
  receipt(input: RunCommandReceiptQueryV1, signal?: AbortSignal): Promise<RunCommandResultV1<RunCommandReceiptV1 | null>>;
  pending(): Promise<readonly RunCommandPendingV1[]>;
  acknowledge(input: RunCommandReceiptQueryV1): Promise<void>;
}
export const RUN_COMMAND_LIMITS: Readonly<{ task: number; feedback: number; message: number; responseBytes: number }> = Object.freeze({ task: 20 * 1024, feedback: 20 * 1024, message: 2048, responseBytes: 64 * 1024 });
export class RunCommandValidationError extends Error {}
function invalid(): never { throw new RunCommandValidationError('Invalid run command data'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalid();
  return input as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(input: unknown, maximum: number, multiline = false, empty = false): string {
  if (typeof input !== 'string' || input.length > maximum || !empty && !input.trim()
    || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(input)) invalid();
  return input;
}
function integer(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) invalid(); return input;
}
function runId(input: unknown): string { const value = text(input, 128); if (!/^[a-z\d_-]+$/i.test(value)) invalid(); return value; }
function requestId(input: unknown): string {
  const value = text(input, 36); if (!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
function launch(input: unknown): RunCommandLaunchV1 {
  const value = record(input);
  const tuning = { ...(value.model === undefined ? {} : { model: text(value.model, 128) }),
    ...(value.effort === undefined ? {} : { effort: text(value.effort, 32) }) };
  const optional = ['model', 'effort'];
  if (value.mode === 'source') {
    fields(value, ['mode', 'workRef', 'sourceInstanceId', 'sourceInstanceRevision'], optional);
    const id = text(value.sourceInstanceId, 160); if (!/^[a-z\d-]+$/i.test(id)) invalid();
    return Object.freeze({ mode: 'source', workRef: Object.freeze(parseWorkRefV1(value.workRef)), sourceInstanceId: id,
      sourceInstanceRevision: integer(value.sourceInstanceRevision), ...tuning });
  }
  if (value.mode === 'freeform') {
    fields(value, ['mode', 'task'], optional);
    return Object.freeze({ mode: 'freeform', task: text(value.task, RUN_COMMAND_LIMITS.task, true), ...tuning });
  }
  if (value.mode === 'review') {
    fields(value, ['mode', 'prNumber'], [...optional, 'headSha']);
    if (value.headSha !== undefined && (typeof value.headSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value.headSha))) invalid();
    return Object.freeze({ mode: 'review', prNumber: integer(value.prNumber), ...(value.headSha === undefined ? {} : { headSha: value.headSha.toLowerCase() }), ...tuning });
  }
  if (value.mode === 'rerun') {
    fields(value, ['mode', 'prNumber', 'feedback'], optional);
    return Object.freeze({ mode: 'rerun', prNumber: integer(value.prNumber), feedback: text(value.feedback, RUN_COMMAND_LIMITS.feedback, true, true), ...tuning });
  }
  return invalid();
}
function command(input: unknown, identified: boolean): RunCommandInputV1 | RunCommandV1 {
  const value = record(input);
  if (value.version !== 1 || !['stop', 'retry', 'launch'].includes(value.action as string)) invalid();
  fields(value, ['version', 'repo', 'action', value.action === 'launch' ? 'launch' : 'target', ...(identified ? ['requestId'] : [])]);
  const base = { version: 1 as const, repo: parseTaskRepo(value.repo), ...(identified ? { requestId: requestId(value.requestId) } : {}) };
  if (value.action === 'launch') return Object.freeze({ ...base, action: 'launch', launch: launch(value.launch) });
  const target = record(value.target); fields(target, ['runId', 'expectedAttempt']);
  const validatedTarget = Object.freeze({ runId: runId(target.runId), expectedAttempt: integer(target.expectedAttempt) });
  return value.action === 'stop' ? Object.freeze({ ...base, action: 'stop', target: validatedTarget })
    : Object.freeze({ ...base, action: 'retry', target: validatedTarget });
}
export function parseRunCommandInputV1(input: unknown): RunCommandInputV1 { return command(input, false); }
export function parseRunCommandV1(input: unknown): RunCommandV1 { return command(input, true) as RunCommandV1; }
export function parseRunCommandReceiptQueryV1(input: unknown): RunCommandReceiptQueryV1 {
  const value = record(input); fields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: requestId(value.requestId) });
}
export function parseRunCommandReceiptV1(input: unknown, expected?: RunCommandReceiptQueryV1 & { action?: RunCommandInputV1['action']; target?: RunCommandTargetV1 }): RunCommandReceiptV1 {
  const value = record(input); fields(value, ['version', 'requestId', 'repo', 'action', 'status', 'runId', 'attempt', 'message']);
  if (value.version !== 1 || !['stop', 'retry', 'launch'].includes(value.action as string)
    || !['accepted', 'rejected', 'pending', 'recovery-required'].includes(value.status as string)) invalid();
  const result = Object.freeze({ version: 1 as const, repo: parseTaskRepo(value.repo), requestId: requestId(value.requestId),
    action: value.action as RunCommandInputV1['action'], status: value.status as RunCommandReceiptV1['status'],
    runId: value.runId === null ? null : runId(value.runId), attempt: value.attempt === null ? null : integer(value.attempt),
    message: value.message === null ? null : text(value.message, RUN_COMMAND_LIMITS.message, true) });
  if ((result.runId === null) !== (result.attempt === null) || result.status === 'accepted' && result.runId === null
    || expected && (result.repo !== expected.repo || result.requestId !== expected.requestId || expected.action !== undefined && result.action !== expected.action)) invalid();
  if (expected?.action === 'stop' && expected.target && result.runId !== null
    && (result.runId !== expected.target.runId || result.attempt !== expected.target.expectedAttempt)) invalid();
  return result;
}
