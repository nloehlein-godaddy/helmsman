import { parseTaskRepo } from '../../src/plugins/tasks';
import { parsePullRequestReadItemV1, parsePullRequestReadPageV1, parsePullRequestReadQueryV1, PULL_REQUEST_READ_LIMITS } from '../../src/plugins/pull-request-read';
import type { PullRequestReadPageV1, PullRequestReadQueryV1 } from '../../src/plugins/pull-request-read';
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
