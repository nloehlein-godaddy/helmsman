import { parseTaskRepo } from './tasks';

export type PullRequestReadKindV1 = 'repo-open' | 'authored-recent' | 'review-requested';
export type PullRequestReadQualityV1 = 'complete' | 'partial' | 'degraded';
export interface PullRequestReadQueryV1 { readonly version: 1; readonly repo: string | null; readonly kind: PullRequestReadKindV1; readonly limit: number; readonly state?: 'open' | 'all'; }
export interface PullRequestReadItemV1 {
  readonly repo: string; readonly number: number; readonly title: string; readonly url: string | null;
  readonly status: 'open' | 'closed' | 'merged'; readonly createdAt: string; readonly mergedAt: string | null;
  readonly draft: boolean | null; readonly ticketId: string | null;
  readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  readonly comments: number | null;
  readonly reviews: { readonly approved: number | null; readonly changesRequested: number | null; readonly commented: number | null; readonly requested: number | null } | null;
  readonly feedback?: { readonly changesRequested: boolean | null; readonly newComments: boolean | null; readonly latestCommitAt: string | null };
}
export interface PullRequestReadPageV1 {
  readonly version: 1; readonly repo: string | null; readonly kind: PullRequestReadKindV1;
  readonly items: readonly PullRequestReadItemV1[]; readonly quality: PullRequestReadQualityV1;
  readonly truncated: boolean; readonly browseUrl: string | null;
}
export type PullRequestReadUnavailableReasonV1 = 'forbidden' | 'selection-required' | 'selection-changed' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type PullRequestReadResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: PullRequestReadUnavailableReasonV1 };
export interface PullRequestReadServiceV1 {
  readonly version: 1;
  list(query: PullRequestReadQueryV1, signal?: AbortSignal): Promise<PullRequestReadResultV1<PullRequestReadPageV1>>;
  watchList(query: PullRequestReadQueryV1, listener: (result: PullRequestReadResultV1<PullRequestReadPageV1>) => void, signal?: AbortSignal): () => void;
}
export const PULL_REQUEST_READ_LIMITS: Readonly<{ page: number; responseBytes: number; repos: number }> = Object.freeze({ page: 100, responseBytes: 1024 * 1024, repos: 1000 });
export class PullRequestReadValidationError extends Error {}
function invalid(): never { throw new PullRequestReadValidationError('Invalid pull request read data'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalid();
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum: number): string { if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\x00-\x1f\x7f]/.test(input)) invalid(); return input; }
function date(input: unknown): string { const value = text(input, 64); if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function count(input: unknown, minimum = 0): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) invalid(); return input; }
function nullableCount(input: unknown): number | null { return input === null ? null : count(input); }
function url(input: unknown): string | null {
  if (input === null) return null;
  const value = text(input, 2048); let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid();
  return value;
}
export function parsePullRequestReadQueryV1(input: unknown): PullRequestReadQueryV1 {
  const value = record(input);
  if (value.version !== 1 || !['repo-open', 'authored-recent', 'review-requested'].includes(value.kind as string)) invalid();
  const limit = count(value.limit, 1); if (limit > PULL_REQUEST_READ_LIMITS.page) invalid();
  if (Object.hasOwn(value, 'state') && (value.kind !== 'authored-recent' || !['open', 'all'].includes(value.state as string))) invalid();
  return Object.freeze({ version: 1, repo: value.repo === null ? null : parseTaskRepo(value.repo), kind: value.kind as PullRequestReadKindV1, limit, ...(Object.hasOwn(value, 'state') ? { state: value.state as 'open' | 'all' } : {}) });
}
export function parsePullRequestReadItemV1(input: unknown): PullRequestReadItemV1 {
  const value = record(input);
  if (!['open', 'closed', 'merged'].includes(value.status as string) || value.draft !== null && typeof value.draft !== 'boolean'
    || value.reviewDecision !== null && !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(value.reviewDecision as string)) invalid();
  const mergedAt = value.mergedAt === null ? null : date(value.mergedAt);
  if (value.status === 'merged' && mergedAt === null || value.status !== 'merged' && mergedAt !== null) invalid();
  const reviews = value.reviews === null ? null : record(value.reviews);
  const feedback = value.feedback === undefined ? null : record(value.feedback);
  if (feedback && [feedback.changesRequested, feedback.newComments].some(flag => flag !== null && typeof flag !== 'boolean')) invalid();
  return Object.freeze({ repo: parseTaskRepo(value.repo), number: count(value.number, 1), title: text(value.title, 2048), url: url(value.url),
    status: value.status as PullRequestReadItemV1['status'], createdAt: date(value.createdAt), mergedAt, draft: value.draft as boolean | null,
    ticketId: value.ticketId === null ? null : text(value.ticketId, 128), reviewDecision: value.reviewDecision as PullRequestReadItemV1['reviewDecision'],
    comments: nullableCount(value.comments), reviews: reviews ? Object.freeze({ approved: nullableCount(reviews.approved), changesRequested: nullableCount(reviews.changesRequested), commented: nullableCount(reviews.commented), requested: nullableCount(reviews.requested) }) : null,
    ...(feedback ? { feedback: Object.freeze({ changesRequested: feedback.changesRequested as boolean | null, newComments: feedback.newComments as boolean | null, latestCommitAt: feedback.latestCommitAt === null ? null : date(feedback.latestCommitAt) }) } : {}) });
}
export function parsePullRequestReadPageV1(input: unknown, query: PullRequestReadQueryV1, repos: readonly string[]): PullRequestReadPageV1 {
  const value = record(input);
  if (value.version !== 1 || value.repo !== query.repo || value.kind !== query.kind || !['complete', 'partial', 'degraded'].includes(value.quality as string)
    || typeof value.truncated !== 'boolean' || value.quality === 'complete' && value.truncated || !Array.isArray(value.items) || value.items.length > query.limit) invalid();
  const items: PullRequestReadItemV1[] = []; const identities = new Set<string>();
  for (let index = 0; index < value.items.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.items, index); if (!descriptor || !('value' in descriptor)) invalid();
    const item = parsePullRequestReadItemV1(descriptor.value); const key = `${item.repo.toLowerCase()}#${item.number}`;
    if (!repos.includes(item.repo) || query.repo !== null && item.repo !== query.repo || identities.has(key)
      || (query.kind !== 'authored-recent' || query.state === 'open') && item.status !== 'open') invalid();
    identities.add(key); items.push(item);
  }
  return Object.freeze({ version: 1, repo: query.repo, kind: query.kind, items: Object.freeze(items), quality: value.quality as PullRequestReadQualityV1, truncated: value.truncated, browseUrl: url(value.browseUrl) });
}
