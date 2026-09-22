import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from './task-read';
import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';

export type TaskContextUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type TaskContextResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: TaskContextUnavailableReasonV1 };
export interface TaskContextQueryV1 {
  readonly version: 1;
  readonly selection: TaskReadSelectionV1;
  readonly ref: WorkRefV1;
  readonly taskRevision: string;
  readonly claim: 'active' | 'settled';
}
export interface TaskContextSnapshotV1 {
  readonly version: 1;
  readonly task: { readonly selection: TaskReadSelectionV1; readonly ref: WorkRefV1; readonly url: string | null };
  readonly claim: { readonly id: string; readonly revision: number; readonly state: 'reserved' | 'claimed' | 'settling' | 'settled' } | null;
  readonly run: { readonly repo: string; readonly runId: string; readonly expectedAttempt: number } | null;
  readonly pullRequest: { readonly repo: string; readonly number: number; readonly sourceRunId: string } | null;
}
export interface TaskContextServiceV1 {
  readonly version: 1;
  resolve(input: TaskContextQueryV1, signal?: AbortSignal): Promise<TaskContextResultV1<TaskContextSnapshotV1>>;
}
export const TASK_CONTEXT_LIMITS: Readonly<{ responseBytes: number; taskRevision: number; url: number }> = Object.freeze({ responseBytes: 32 * 1024, taskRevision: 512, url: 4096 });
export class TaskContextValidationError extends Error {}
function invalid(): never { throw new TaskContextValidationError('Invalid task context data'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function id(value: unknown): string { const result = text(value, 160); if (!/^[a-z\d_-]+$/i.test(result)) invalid(); return result; }
function runId(value: unknown): string { const result = text(value, 128); if (!/^[a-z\d_-]+$/i.test(result)) invalid(); return result; }
function integer(value: unknown, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }

export function parseTaskContextQueryV1(input: unknown): TaskContextQueryV1 {
  const value = record(input); const selection = parseTaskReadSelectionV1(value.selection); const ref = parseWorkRefV1(value.ref);
  if (value.version !== 1 || ref.sourceId !== selection.sourceId || (value.claim !== 'active' && value.claim !== 'settled')) invalid();
  return Object.freeze({ version: 1, selection, ref, taskRevision: text(value.taskRevision, TASK_CONTEXT_LIMITS.taskRevision), claim: value.claim });
}

export function parseTaskContextSnapshotV1(input: unknown, query: TaskContextQueryV1): TaskContextSnapshotV1 {
  query = parseTaskContextQueryV1(query); const value = record(input); const task = record(value.task);
  const selection = parseTaskReadSelectionV1(task.selection); const ref = parseWorkRefV1(task.ref);
  if (value.version !== 1 || selection.sourceId !== query.selection.sourceId || selection.instanceId !== query.selection.instanceId
    || selection.instanceRevision !== query.selection.instanceRevision || selection.repo !== query.selection.repo
    || ref.sourceId !== query.ref.sourceId || ref.externalId !== query.ref.externalId) invalid();
  const url = task.url === null ? null : (() => { const result = text(task.url, TASK_CONTEXT_LIMITS.url); const parsed = new URL(result); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(); return result; })();
  const rawClaim = value.claim === null ? null : record(value.claim);
  const claim = rawClaim === null ? null : (() => {
    const state = rawClaim.state;
    if (state !== 'reserved' && state !== 'claimed' && state !== 'settling' && state !== 'settled') invalid();
    if (query.claim === 'active' && state === 'settled' || query.claim === 'settled' && state !== 'settled') invalid();
    return Object.freeze({ id: id(rawClaim.id), revision: integer(rawClaim.revision, 1), state });
  })();
  const rawRun = value.run === null ? null : record(value.run);
  const run = rawRun === null ? null : Object.freeze({ repo: parseTaskRepo(rawRun.repo), runId: runId(rawRun.runId), expectedAttempt: integer(rawRun.expectedAttempt, 1) });
  if (run && (!claim || run.repo !== query.selection.repo)) invalid();
  const rawPr = value.pullRequest === null ? null : record(value.pullRequest);
  const pullRequest = rawPr === null ? null : Object.freeze({ repo: parseTaskRepo(rawPr.repo), number: integer(rawPr.number, 1), sourceRunId: runId(rawPr.sourceRunId) });
  if (pullRequest && (!run || pullRequest.repo !== run.repo || pullRequest.sourceRunId !== run.runId)) invalid();
  return Object.freeze({ version: 1, task: Object.freeze({ selection, ref, url }), claim, run, pullRequest });
}
