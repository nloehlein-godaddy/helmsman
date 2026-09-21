import { parseTaskRepo } from './tasks';
import { parseRunReadListQueryV1, parseRunReadPageV1 } from './run-read';
import type { RunReadListQueryV1, RunReadPageV1, RunReadStatusV1, RunReadUnavailableReasonV1 } from './run-read';

export type RunInspectResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: RunReadUnavailableReasonV1 | 'attempt-changed' | 'cursor-invalid' };
export interface RunInspectTargetV1 { readonly repo: string; readonly runId: string; readonly expectedAttempt: number; }
export interface RunInspectResolveQueryV1 { readonly version: 1; readonly runId: string; }
export interface RunInspectResolvedV1 { readonly version: 1; readonly target: RunInspectTargetV1; readonly observedAt: string; }
export interface RunInspectHistoryPageV1 extends RunReadPageV1 {
  readonly total: number | null; readonly totalQuality: 'exact' | 'unknown'; readonly observedAt: string;
  readonly coverage: 'insertion-bounded-current-state';
}
export interface RunInspectLogQueryV1 {
  readonly version: 1; readonly target: RunInspectTargetV1; readonly direction: 'backward' | 'forward';
  readonly cursor: string | null; readonly limit: number;
}
export interface RunInspectLogEventV1 { readonly sequence: number; readonly at: string; readonly kind: string; readonly text: string; readonly truncated: boolean; }
export interface RunInspectLogPageV1 {
  readonly version: 1; readonly target: RunInspectTargetV1; readonly provenance: 'run-wide'; readonly observedAt: string;
  readonly workerStatus: RunReadStatusV1; readonly events: readonly RunInspectLogEventV1[]; readonly throughSequence: number;
  readonly hasEarlier: boolean; readonly hasLater: boolean; readonly nextCursor: string | null; readonly followCursor: string | null;
}
export interface RunInspectExportQueryV1 { readonly version: 1; readonly target: RunInspectTargetV1; }
export interface RunInspectExportMetadataV1 extends RunInspectResolvedV1 {
  readonly provenance: 'run-wide'; readonly throughSequence: number; readonly filename: string;
  readonly contentType: 'text/plain; charset=utf-8';
}
export interface RunInspectExportV1 extends RunInspectExportMetadataV1 { readonly stream: ReadableStream<Uint8Array>; }
export interface RunInspectServiceV1 {
  readonly version: 1;
  resolve(input: RunInspectResolveQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectResolvedV1>>;
  history(input: RunReadListQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectHistoryPageV1>>;
  log(input: RunInspectLogQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectLogPageV1>>;
  exportLog(input: RunInspectExportQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectExportV1>>;
}
export const RUN_INSPECT_LIMITS: Readonly<{ page: number; logPage: number; logText: number; cursor: number; responseBytes: number; exportChunkBytes: number }> = Object.freeze({ page: 100, logPage: 50, logText: 4000, cursor: 4096, responseBytes: 2 * 1024 * 1024, exportChunkBytes: 64 * 1024 });
export class RunInspectValidationError extends Error {}
function invalid(): never { throw new RunInspectValidationError('Invalid run inspection data'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalid();
  return input as Record<string, unknown>;
}
function text(input: unknown, max: number, multiline = false): string {
  if (typeof input !== 'string' || input.length > max || !multiline && (!input.trim() || /[\x00-\x1f\x7f]/.test(input))) invalid();
  return input;
}
function integer(input: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) invalid(); return input;
}
function date(input: unknown): string { const value = text(input, 64); if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function cursor(input: unknown): string | null { return input === null ? null : text(input, RUN_INSPECT_LIMITS.cursor); }
export function parseRunInspectResolveQueryV1(input: unknown): RunInspectResolveQueryV1 {
  const value = record(input); const runId = text(value.runId, 128);
  if (value.version !== 1 || !/^[a-z\d_-]+$/i.test(runId)) invalid(); return Object.freeze({ version: 1, runId });
}
export function parseRunInspectTargetV1(input: unknown): RunInspectTargetV1 {
  const value = record(input); const identity = parseRunInspectResolveQueryV1({ version: 1, runId: value.runId });
  return Object.freeze({ repo: parseTaskRepo(value.repo), runId: identity.runId, expectedAttempt: integer(value.expectedAttempt, 1) });
}
export function parseRunInspectExportQueryV1(input: unknown): RunInspectExportQueryV1 {
  const value = record(input); if (value.version !== 1) invalid(); return Object.freeze({ version: 1, target: parseRunInspectTargetV1(value.target) });
}
export function parseRunInspectLogQueryV1(input: unknown): RunInspectLogQueryV1 {
  const value = record(input); const base = parseRunInspectExportQueryV1(value);
  if (value.direction !== 'backward' && value.direction !== 'forward' || value.direction === 'forward' && value.cursor === null) invalid();
  return Object.freeze({ ...base, direction: value.direction, cursor: cursor(value.cursor), limit: integer(value.limit, 1, RUN_INSPECT_LIMITS.logPage) });
}
function target(input: unknown, expected: RunInspectTargetV1): RunInspectTargetV1 {
  const result = parseRunInspectTargetV1(input);
  if (result.repo !== expected.repo || result.runId !== expected.runId || result.expectedAttempt !== expected.expectedAttempt) invalid(); return result;
}
export function parseRunInspectResolvedV1(input: unknown, query: RunInspectResolveQueryV1, repos: readonly string[]): RunInspectResolvedV1 {
  const value = record(input); const result = parseRunInspectTargetV1(value.target);
  if (value.version !== 1 || result.runId !== query.runId || !repos.includes(result.repo)) invalid();
  return Object.freeze({ version: 1, target: result, observedAt: date(value.observedAt) });
}
export function parseRunInspectHistoryPageV1(input: unknown, query: RunReadListQueryV1, repos: readonly string[]): RunInspectHistoryPageV1 {
  const value = record(input); const page = parseRunReadPageV1(value, parseRunReadListQueryV1(query), repos);
  if (value.coverage !== 'insertion-bounded-current-state' || value.totalQuality !== 'exact' && value.totalQuality !== 'unknown') invalid();
  const total = value.total === null ? null : integer(value.total);
  if ((total === null) !== (value.totalQuality === 'unknown') || total !== null && total < page.items.length) invalid();
  return Object.freeze({ ...page, total, totalQuality: value.totalQuality, coverage: value.coverage, observedAt: date(value.observedAt) });
}
export function parseRunInspectLogPageV1(input: unknown, query: RunInspectLogQueryV1): RunInspectLogPageV1 {
  const value = record(input);
  if (value.version !== 1 || value.provenance !== 'run-wide' || !['running', 'succeeded', 'failed', 'stopped'].includes(value.workerStatus as string)
    || typeof value.hasEarlier !== 'boolean' || typeof value.hasLater !== 'boolean' || !Array.isArray(value.events) || value.events.length > query.limit) invalid();
  const throughSequence = integer(value.throughSequence); let previous = 0;
  const events = Array.from({ length: value.events.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.events, index); if (!descriptor || !('value' in descriptor)) invalid();
    const item = record(descriptor.value); const sequence = integer(item.sequence, 1, throughSequence);
    if (sequence <= previous || typeof item.truncated !== 'boolean') invalid(); previous = sequence;
    return Object.freeze({ sequence, at: date(item.at), kind: text(item.kind, 128), text: text(item.text, RUN_INSPECT_LIMITS.logText, true), truncated: item.truncated });
  });
  const nextCursor = cursor(value.nextCursor); const followCursor = cursor(value.followCursor);
  if (query.direction === 'forward' && nextCursor === null || query.direction === 'backward' && value.hasEarlier !== (nextCursor !== null)
    || (query.cursor === null ? followCursor === null : followCursor !== null)
    || (query.direction === 'backward' ? value.hasEarlier : value.hasLater) && !events.length) invalid();
  return Object.freeze({ version: 1, target: target(value.target, query.target), provenance: 'run-wide', observedAt: date(value.observedAt),
    workerStatus: value.workerStatus as RunReadStatusV1, events: Object.freeze(events), throughSequence, hasEarlier: value.hasEarlier, hasLater: value.hasLater, nextCursor, followCursor });
}
export function parseRunInspectExportMetadataV1(input: unknown, query: RunInspectExportQueryV1): RunInspectExportMetadataV1 {
  const value = record(input);
  if (value.version !== 1 || value.provenance !== 'run-wide' || value.contentType !== 'text/plain; charset=utf-8' || value.filename !== `helmsman-${query.target.runId}.log`) invalid();
  return Object.freeze({ version: 1, target: target(value.target, query.target), provenance: 'run-wide', observedAt: date(value.observedAt),
    throughSequence: integer(value.throughSequence), filename: value.filename, contentType: value.contentType });
}
