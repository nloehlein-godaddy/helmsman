import { parseTaskRepo } from '../../src/plugins/tasks';
import { parsePullRequestReadItemV1, parsePullRequestReadPageV1, parsePullRequestReadQueryV1, PULL_REQUEST_READ_LIMITS } from '../../src/plugins/pull-request-read';
import type { PullRequestReadItemV1, PullRequestReadPageV1, PullRequestReadQueryV1 } from '../../src/plugins/pull-request-read';
import type { PullRequestProviderBatchV1 } from '../../src/plugins/pull-request-provider';

export type PullRequestProviderBatch = PullRequestProviderBatchV1;
export interface PullRequestReadServerService { list(query: PullRequestReadQueryV1, signal?: AbortSignal): Promise<PullRequestReadPageV1>; }
export class PullRequestReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function providerError(error: unknown): PullRequestReadError | null {
  const reason = error && typeof error === 'object' && 'reason' in error ? (error as { reason?: unknown }).reason : null;
  if (reason === 'selection-changed') return new PullRequestReadError(409, reason);
  return null;
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function legacyItem(value: unknown, authored: boolean): PullRequestReadItemV1 {
  const item = record(value); if (!item) throw new TypeError('Invalid provider pull request');
  const repo = parseTaskRepo(item.repo); const mergedAt = authored ? item.mergedAt : null;
  const reviews = record(item.reviews);
  const title = typeof item.title === 'string' ? item.title.slice(0, 2048).replace(/[\uD800-\uDBFF]$/, '') : item.title;
  const ticketId = typeof title === 'string' ? title.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? (typeof item.headRef === 'string' ? item.headRef.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] : null) ?? null : null;
  if (authored && !['open', 'closed'].includes(item.state as string)) throw new TypeError('Invalid provider pull request status');
  return parsePullRequestReadItemV1({ repo, number: item.number, title,
    url: `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/pull/${String(item.number)}`,
    status: mergedAt ? 'merged' : authored && item.state === 'closed' ? 'closed' : 'open', createdAt: item.createdAt, mergedAt,
    draft: typeof item.draft === 'boolean' ? item.draft : null, ticketId,
    reviewDecision: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(item.reviewDecision as string) ? item.reviewDecision : null,
    comments: count(item.comments), reviews: reviews ? { approved: count(reviews.approved), changesRequested: count(reviews.changesRequested), commented: count(reviews.commented), requested: count(reviews.requested) } : null });
}
function project(values: readonly unknown[], authored: boolean): { items: PullRequestReadItemV1[]; degraded: boolean } {
  const items: PullRequestReadItemV1[] = []; const seen = new Set<string>(); let degraded = false;
  for (const value of values.slice(0, 300)) {
    try {
      const item = legacyItem(value, authored); const key = `${item.repo.toLowerCase()}#${item.number}`;
      if (seen.has(key)) continue; seen.add(key); items.push(item);
    } catch { degraded = true; }
  }
  return { items, degraded };
}
export function projectLegacyOpenPullRequests(value: unknown, browseUrl: string | null): PullRequestProviderBatch {
  const data = record(value);
  if (!Array.isArray(data?.prs)) throw new PullRequestReadError(503, 'Pull request provider unavailable');
  const result = project(data.prs, false); const truncated = data.truncated === true || data.prs.length > 300;
  return { items: result.items, quality: result.degraded || data.degraded !== false || typeof data.truncated !== 'boolean' ? 'degraded' : truncated ? 'partial' : 'complete', truncated, browseUrl };
}
export function projectLegacyAuthoredPullRequests(value: unknown, browseUrl: string | null): PullRequestProviderBatch {
  if (!Array.isArray(value)) throw new PullRequestReadError(503, 'Pull request provider unavailable');
  const result = project(value, true);
  return { items: result.items, quality: result.degraded ? 'degraded' : 'partial', truncated: true, browseUrl };
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
export function createPullRequestReadService(options: {
  repos(): readonly string[];
  read(query: PullRequestReadQueryV1, repos: readonly string[], signal: AbortSignal): Promise<PullRequestProviderBatch>;
  timeoutMs?: number;
}): PullRequestReadServerService {
  const reads = new Map<string, Promise<PullRequestProviderBatch>>();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid provider timeout');
  function scope(repo: string | null): readonly string[] {
    const configured = options.repos(); if (!Array.isArray(configured) || configured.length > PULL_REQUEST_READ_LIMITS.repos) throw new PullRequestReadError(503, 'Pull request scope unavailable');
    const repos = [...new Set(configured.map(parseTaskRepo))].sort();
    if (repo !== null && !repos.includes(repo)) throw new PullRequestReadError(403, 'Pull request scope forbidden');
    return repo === null ? repos : [repo];
  }
  return Object.freeze<PullRequestReadServerService>({ async list(input, caller) {
    caller?.throwIfAborted(); const query = parsePullRequestReadQueryV1(input);
    if (query.kind === 'repo-open' && query.repo === null) throw new PullRequestReadError(422, 'Select a repository for its open pull requests');
    const repos = scope(query.repo); const scopeKey = JSON.stringify(repos);
    if (!repos.length) return parsePullRequestReadPageV1({ version: 1, repo: query.repo, kind: query.kind, items: [], quality: 'complete', truncated: false, browseUrl: null }, query, repos);
    const key = JSON.stringify([query.repo, query.kind, scopeKey]);
    let pending = reads.get(key);
    if (!pending) {
      if (reads.size >= 64) throw new PullRequestReadError(503, 'Pull request provider busy');
      const providerSignal = AbortSignal.timeout(timeoutMs);
      pending = Promise.resolve().then(() => options.read({ ...query, limit: PULL_REQUEST_READ_LIMITS.page }, repos, providerSignal));
      reads.set(key, pending);
      const current = pending; void pending.finally(() => { if (reads.get(key) === current) reads.delete(key); }).catch(() => {});
    }
    const timeout = AbortSignal.timeout(timeoutMs); const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    let batch: PullRequestProviderBatch;
    try { batch = await abortable(pending, signal); }
    catch (error) {
      caller?.throwIfAborted();
      const mapped = providerError(error); if (mapped) throw mapped;
      throw new PullRequestReadError(503, 'Pull request provider unavailable');
    }
    caller?.throwIfAborted();
    if (JSON.stringify(scope(query.repo)) !== scopeKey) throw new PullRequestReadError(409, 'Pull request scope changed');
    if (!batch || !Array.isArray(batch.items) || batch.items.length > 300) throw new PullRequestReadError(503, 'Invalid pull request provider response');
    const items = batch.items.map(parsePullRequestReadItemV1).filter(item => repos.includes(item.repo));
    const truncated = batch.truncated || items.length > query.limit;
    return parsePullRequestReadPageV1({ version: 1, repo: query.repo, kind: query.kind, items: items.slice(0, query.limit),
      quality: batch.quality === 'complete' && truncated ? 'partial' : batch.quality, truncated, browseUrl: batch.browseUrl }, query, repos);
  } });
}
