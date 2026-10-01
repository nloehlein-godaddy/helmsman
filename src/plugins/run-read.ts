import { normalizeFeedbackOutcomeForStatus, parseFeedbackOutcome, type FeedbackOutcome } from './feedback-outcome';
import { parseTaskRepo } from './tasks';

export type RunReadStatusV1 = 'running' | 'succeeded' | 'failed' | 'stopped';
export type RunReadUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type RunReadResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: RunReadUnavailableReasonV1 };
export interface RunReadSettlementV1 { readonly state: 'pending' | 'settled' | 'operator-required'; }
export interface RunReadSummaryV1 {
  readonly version: 1;
  readonly id: string;
  readonly repo: string;
  readonly displayKey: string;
  readonly title?: string;
  readonly status: RunReadStatusV1;
  readonly attempt: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly prNumber: number | null;
  readonly costUsd: number | null;
  readonly review: { readonly outcome: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; readonly verdict: string } | null;
  /** Null while work is running or no source settlement applies; never changes the worker status. */
  readonly sourceSettlement: RunReadSettlementV1 | null;
  readonly feedbackOutcome?: Readonly<FeedbackOutcome>;
}
export interface RunReadListQueryV1 {
  readonly version: 1;
  readonly repo: string | null;
  readonly kind: 'running' | 'terminal' | 'all';
  readonly limit: number;
  readonly cursor: string | null;
}
export interface RunReadLoadQueryV1 { readonly version: 1; readonly repo: string; readonly runId: string; }
export interface RunReadLogQueryV1 extends RunReadLoadQueryV1 { readonly cursor: string | null; readonly limit: number; }
export interface RunReadPageV1 { readonly version: 1; readonly repo: string | null; readonly items: readonly RunReadSummaryV1[]; readonly nextCursor: string | null; }
export interface RunReadItemV1 { readonly version: 1; readonly repo: string; readonly runId: string; readonly run: RunReadSummaryV1 | null; }
export interface RunReadLogEventV1 { readonly sequence: number; readonly at: string; readonly kind: string; readonly text: string; readonly truncated: boolean; }
export interface RunReadLogPageV1 {
  readonly version: 1; readonly repo: string; readonly runId: string;
  readonly events: readonly RunReadLogEventV1[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly earlierTruncated: boolean;
  readonly workerStatus: RunReadStatusV1;
}
export interface RunReadServiceV1 {
  readonly version: 1;
  list(input: RunReadListQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadPageV1>>;
  load(input: RunReadLoadQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadItemV1>>;
  log(input: RunReadLogQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadLogPageV1>>;
  watchList(input: RunReadListQueryV1, listener: (result: RunReadResultV1<RunReadPageV1>) => void, signal?: AbortSignal): () => void;
  watchLoad(input: RunReadLoadQueryV1, listener: (result: RunReadResultV1<RunReadItemV1>) => void, signal?: AbortSignal): () => void;
  watchLog(input: RunReadLogQueryV1, listener: (result: RunReadResultV1<RunReadLogPageV1>) => void, signal?: AbortSignal): () => void;
}
export const RUN_READ_LIMITS: Readonly<{ page: number; logPage: number; logText: number; responseBytes: number; cursor: number; repos: number }> = Object.freeze({ page: 100, logPage: 50, logText: 2000, responseBytes: 1024 * 1024, cursor: 4096, repos: 1000 });
export class RunReadValidationError extends Error {}
function invalid(): never { throw new RunReadValidationError('Invalid run read data'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalid();
  return input as Record<string, unknown>;
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) invalid();
  for (const key of Reflect.ownKeys(input)) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !('value' in descriptor)) invalid();
    return descriptor.value as unknown;
  });
}
function text(input: unknown, maximum: number, multiline = false): string {
  if (typeof input !== 'string' || input.length > maximum || !multiline && (!input.trim() || /[\x00-\x1f\x7f]/.test(input))) invalid();
  return input;
}
function integer(input: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) invalid();
  return input;
}
function date(input: unknown): string { const value = text(input, 64); if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function status(input: unknown): RunReadStatusV1 { if (typeof input !== 'string' || !['running', 'succeeded', 'failed', 'stopped'].includes(input)) invalid(); return input as RunReadStatusV1; }
function cursor(input: unknown): string | null { return input === null ? null : text(input, RUN_READ_LIMITS.cursor); }
function runId(input: unknown): string { const value = text(input, 128); if (!/^[a-z\d_-]+$/i.test(value)) invalid(); return value; }

export function parseRunReadListQueryV1(input: unknown): RunReadListQueryV1 {
  const value = record(input);
  if (value.version !== 1 || typeof value.kind !== 'string' || !['running', 'terminal', 'all'].includes(value.kind)) invalid();
  return Object.freeze({ version: 1, repo: value.repo === null ? null : parseTaskRepo(value.repo), kind: value.kind as RunReadListQueryV1['kind'],
    limit: integer(value.limit, 1, RUN_READ_LIMITS.page), cursor: cursor(value.cursor) });
}
export function parseRunReadLoadQueryV1(input: unknown): RunReadLoadQueryV1 {
  const value = record(input); if (value.version !== 1) invalid();
  return Object.freeze({ version: 1, repo: parseTaskRepo(value.repo), runId: runId(value.runId) });
}
export function parseRunReadLogQueryV1(input: unknown): RunReadLogQueryV1 {
  const value = record(input); return Object.freeze({ ...parseRunReadLoadQueryV1(value), cursor: cursor(value.cursor), limit: integer(value.limit, 1, RUN_READ_LIMITS.logPage) });
}
export function parseRunReadSummaryV1(input: unknown): RunReadSummaryV1 {
  const value = record(input); if (value.version !== 1) invalid();
  const workerStatus = status(value.status);
  if (value.costUsd !== null && (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0)) invalid();
  let review: RunReadSummaryV1['review'] = null;
  if (value.review !== null) {
    const data = record(value.review);
    if (workerStatus !== 'succeeded' || typeof data.outcome !== 'string' || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(data.outcome)) invalid();
    review = Object.freeze({ outcome: data.outcome as NonNullable<RunReadSummaryV1['review']>['outcome'], verdict: text(data.verdict, 512, true) });
  }
  let sourceSettlement: RunReadSettlementV1 | null = null;
  if (value.sourceSettlement !== null) {
    const data = record(value.sourceSettlement); if (workerStatus === 'running' || typeof data.state !== 'string' || !['pending', 'settled', 'operator-required'].includes(data.state)) invalid();
    sourceSettlement = Object.freeze({ state: data.state as RunReadSettlementV1['state'] });
  }
  const feedbackOutcome = normalizeFeedbackOutcomeForStatus(parseFeedbackOutcome(value.feedbackOutcome), workerStatus);
  const visibleFeedback = feedbackOutcome && (feedbackOutcome.state !== 'completed' || workerStatus === 'succeeded') ? Object.freeze(feedbackOutcome) : null;
  return Object.freeze({ version: 1, id: runId(value.id), repo: parseTaskRepo(value.repo), displayKey: text(value.displayKey, 512), ...(value.title === undefined ? {} : { title: text(value.title, 512) }), status: workerStatus,
    attempt: integer(value.attempt, 1), startedAt: date(value.startedAt), endedAt: value.endedAt === null ? null : date(value.endedAt),
    prNumber: value.prNumber === null ? null : integer(value.prNumber, 1), costUsd: value.costUsd as number | null, review, sourceSettlement, ...(visibleFeedback ? { feedbackOutcome: visibleFeedback } : {}) });
}
export function parseRunReadPageV1(input: unknown, query: RunReadListQueryV1, repos: readonly string[]): RunReadPageV1 {
  const value = record(input); if (value.version !== 1 || value.repo !== query.repo) invalid();
  const items = array(value.items, query.limit).map(parseRunReadSummaryV1);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id) || !repos.includes(item.repo) || query.repo !== null && item.repo !== query.repo
      || query.kind === 'running' && item.status !== 'running' || query.kind === 'terminal' && item.status === 'running') invalid();
    ids.add(item.id);
  }
  return Object.freeze({ version: 1, repo: query.repo, items: Object.freeze(items), nextCursor: cursor(value.nextCursor) });
}
export function parseRunReadItemV1(input: unknown, query: RunReadLoadQueryV1): RunReadItemV1 {
  const value = record(input); if (value.version !== 1 || value.repo !== query.repo || value.runId !== query.runId) invalid();
  const run = value.run === null ? null : parseRunReadSummaryV1(value.run);
  if (run && (run.id !== query.runId || run.repo !== query.repo)) invalid();
  return Object.freeze({ version: 1, repo: query.repo, runId: query.runId, run });
}
export function parseRunReadLogPageV1(input: unknown, query: RunReadLogQueryV1): RunReadLogPageV1 {
  const value = record(input); if (value.version !== 1 || value.repo !== query.repo || value.runId !== query.runId
    || typeof value.hasMore !== 'boolean' || typeof value.earlierTruncated !== 'boolean') invalid();
  let previous = 0;
  const events = array(value.events, query.limit).map(input => {
    const event = record(input); const sequence = integer(event.sequence, 1);
    if (sequence <= previous || typeof event.truncated !== 'boolean') invalid(); previous = sequence;
    return Object.freeze({ sequence, at: date(event.at), kind: text(event.kind, 128), text: text(event.text, RUN_READ_LIMITS.logText, true), truncated: event.truncated });
  });
  if (value.hasMore && !events.length) invalid();
  return Object.freeze({ version: 1, repo: query.repo, runId: query.runId, events: Object.freeze(events), nextCursor: text(value.nextCursor, RUN_READ_LIMITS.cursor),
    hasMore: value.hasMore, earlierTruncated: value.earlierTruncated, workerStatus: status(value.workerStatus) });
}
