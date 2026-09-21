import { parseTaskRepo } from '../../src/plugins/tasks';
import { parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1, PULL_REQUEST_INSPECT_LIMITS } from '../../src/plugins/pull-request-inspect';
import type { PullRequestInspectDetailQueryV1, PullRequestInspectDetailV1, PullRequestInspectDiffQueryV1, PullRequestInspectDiffV1, PullRequestInspectUnavailableReasonV1 } from '../../src/plugins/pull-request-inspect';

export interface PullRequestInspectProvider {
  detail(query: PullRequestInspectDetailQueryV1, signal: AbortSignal): Promise<PullRequestInspectDetailV1>;
  diff(query: PullRequestInspectDiffQueryV1, signal: AbortSignal): Promise<PullRequestInspectDiffV1>;
}
export interface PullRequestInspectServerService {
  detail(query: PullRequestInspectDetailQueryV1, signal?: AbortSignal): Promise<PullRequestInspectDetailV1>;
  diff(query: PullRequestInspectDiffQueryV1, signal?: AbortSignal): Promise<PullRequestInspectDiffV1>;
}
export class PullRequestInspectError extends Error {
  readonly status: number; readonly reason: PullRequestInspectUnavailableReasonV1;
  constructor(status: number, reason: PullRequestInspectUnavailableReasonV1) { super(reason); this.status = status; this.reason = reason; }
}
function providerError(error: unknown): PullRequestInspectError | null {
  const reason = error && typeof error === 'object' && 'reason' in error ? (error as { reason?: unknown }).reason : null;
  if (reason === 'head-changed' || reason === 'selection-changed') return new PullRequestInspectError(409, reason);
  if (reason === 'invalid-response') return new PullRequestInspectError(502, reason);
  if (reason === 'timeout') return new PullRequestInspectError(504, reason);
  if (reason === 'service-unavailable' || reason === 'connection-failed') return new PullRequestInspectError(503, reason);
  return null;
}
export function createPullRequestInspectService(options: { repos(): readonly string[]; provider: PullRequestInspectProvider; timeoutMs?: number }): PullRequestInspectServerService {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid inspection timeout');
  const reads = new Map<string, { pending: Promise<unknown>; controller: AbortController; users: number }>();
  function permission(repo: string): string {
    const input = options.repos(); if (!Array.isArray(input) || input.length > PULL_REQUEST_INSPECT_LIMITS.repos) throw new PullRequestInspectError(503, 'service-unavailable');
    const repos = [...new Set(input.map(parseTaskRepo))].sort(); if (!repos.includes(repo)) throw new PullRequestInspectError(403, 'forbidden'); return JSON.stringify(repos);
  }
  async function read<T>(repo: string, key: string, invoke: (signal: AbortSignal) => Promise<unknown>, parse: (value: unknown) => T, caller?: AbortSignal): Promise<T> {
    caller?.throwIfAborted(); const authority = permission(repo); const identity = JSON.stringify([key, authority]);
    let entry = reads.get(identity);
    if (!entry) {
      if (reads.size >= 64) throw new PullRequestInspectError(503, 'service-unavailable');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new PullRequestInspectError(504, 'timeout')), timeoutMs);
      let cancel!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', cancel, { once: true }); });
      const pending = Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return invoke(controller.signal); }), aborted])
        .finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', cancel); });
      entry = { pending, controller, users: 0 }; reads.set(identity, entry);
      const current = entry; void pending.finally(() => { if (reads.get(identity) === current) reads.delete(identity); }).catch(() => {});
    }
    entry.users++;
    const timeout = AbortSignal.timeout(timeoutMs); const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
    try {
      const value = await Promise.race([entry.pending, aborted]); caller?.throwIfAborted(); signal.throwIfAborted();
      if (permission(repo) !== authority) throw new PullRequestInspectError(409, 'selection-changed');
      try { return parse(value); } catch { throw new PullRequestInspectError(502, 'invalid-response'); }
    } catch (error) {
      caller?.throwIfAborted(); if (timeout.aborted) throw new PullRequestInspectError(504, 'timeout');
      if (error instanceof PullRequestInspectError) throw error;
      const mapped = providerError(error); if (mapped) throw mapped;
      throw new PullRequestInspectError(503, 'service-unavailable');
    } finally {
      signal.removeEventListener('abort', cancel); entry.users--;
      if (!entry.users) { if (reads.get(identity) === entry) reads.delete(identity); entry.controller.abort(); }
    }
  }
  return Object.freeze({
    detail(input: PullRequestInspectDetailQueryV1, signal?: AbortSignal) { const query = parsePullRequestInspectDetailQueryV1(input); return read(query.repo, JSON.stringify(['detail', query]), signal => options.provider.detail(query, signal), value => parsePullRequestInspectDetailV1(value, query), signal); },
    diff(input: PullRequestInspectDiffQueryV1, signal?: AbortSignal) { const query = parsePullRequestInspectDiffQueryV1(input); return read(query.target.repo, JSON.stringify(['diff', query]), signal => options.provider.diff(query, signal), value => parsePullRequestInspectDiffV1(value, query), signal); },
  });
}
