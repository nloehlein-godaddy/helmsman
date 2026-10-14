import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons } from './task-read';
import { parsePullRequestReadPageV1, parsePullRequestReadQueryV1, PULL_REQUEST_READ_LIMITS } from './pull-request-read';
import type { PullRequestReadPageV1, PullRequestReadQueryV1, PullRequestReadResultV1, PullRequestReadServiceV1, PullRequestReadUnavailableReasonV1 } from './pull-request-read';

export interface PullRequestReadScopeV1 { readonly repo: string | null; readonly epoch: number; readonly active: boolean; readonly signal: AbortSignal; }
const available = <T>(value: T): PullRequestReadResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: PullRequestReadUnavailableReasonV1): PullRequestReadResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Pull request read scope is no longer active', 'AbortError');
function discard(response: Response | undefined): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > PULL_REQUEST_READ_LIMITS.responseBytes) throw new TypeError('Invalid pull request response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > PULL_REQUEST_READ_LIMITS.responseBytes) throw new TypeError('Pull request response exceeds limit');
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHostPullRequestReadService(lifetime: AbortSignal, options: { scope(): PullRequestReadScopeV1; fetch?: typeof globalThis.fetch; pollIntervalMs?: number }): PullRequestReadServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch;
  const interval = options.pollIntervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw new RangeError('Invalid pull request polling interval');
  function fence(caller?: AbortSignal) {
    const current = options.scope();
    const scope = { ...current, repo: current.repo === null ? null : parseTaskRepo(current.repo) };
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted();
      const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check(); return { scope, check };
  }
  function operation(caller?: AbortSignal) {
    const { scope, check } = fence(caller);
    const timeout = AbortSignal.timeout(30_000); const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    async function request<T>(path: string, parse: (value: unknown) => T): Promise<PullRequestReadResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 409) return unavailable('selection-changed');
        if (response.status === 422) return unavailable('selection-required');
        if (!response.ok) return unavailable('service-unavailable');
        try { const value = await body(response, signal); check(); signal.throwIfAborted(); return available(parse(value)); }
        catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    async function permitted(repo: string | null): Promise<PullRequestReadResultV1<readonly string[]>> {
      if (scope.repo !== null && repo !== scope.repo) return unavailable('forbidden');
      const result = await request('/api/context', parseTaskReadGalleons);
      if (result.status === 'unavailable') return result;
      if (repo !== null && !result.value.includes(repo)) return unavailable('forbidden');
      return available(repo === null ? result.value : Object.freeze([repo]));
    }
    return { request, permitted, check };
  }
  async function list(input: PullRequestReadQueryV1, signal?: AbortSignal): Promise<PullRequestReadResultV1<PullRequestReadPageV1>> {
    const query = parsePullRequestReadQueryV1(input); const call = operation(signal);
    if (query.kind === 'repo-open' && query.repo === null) return unavailable('selection-required');
    const permission = await call.permitted(query.repo); if (permission.status === 'unavailable') return permission;
    const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit) });
    if (query.repo !== null) params.set('repo', query.repo);
    if (query.state !== undefined) params.set('state', query.state);
    return call.request(`/api/pull-request-read?${params}`, value => parsePullRequestReadPageV1(value, query, permission.value));
  }
  function watch<T>(read: (signal: AbortSignal) => Promise<PullRequestReadResultV1<T>>, listener: (result: PullRequestReadResultV1<T>) => void,
    caller?: AbortSignal, delay: (result: PullRequestReadResultV1<T>) => number = () => interval): () => void {
    if (typeof listener !== 'function') throw new TypeError('Pull request read listener must be a function');
    const { scope, check } = fence(caller); const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, scope.signal, controller.signal, ...(caller ? [caller] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined; let stopped = false;
    function stop() { if (stopped) return; stopped = true; clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
    async function poll() {
      try {
        check(); signal.throwIfAborted(); const result = await read(signal); check(); signal.throwIfAborted();
        try { listener(result); } catch { /* A subscriber cannot break cancellation or future reads. */ }
        if (!stopped) timer = setTimeout(() => { void poll(); }, delay(result));
      } catch { stop(); }
    }
    signal.addEventListener('abort', stop, { once: true }); void poll(); return stop;
  }
  return Object.freeze<PullRequestReadServiceV1>({ version: 1, list,
    watchList(input, listener, signal) { const query = parsePullRequestReadQueryV1(input); return watch(signal => list(query, signal), listener, signal); },
  });
}
