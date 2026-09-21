import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons } from './task-read';
import { parseRunReadItemV1, parseRunReadListQueryV1, parseRunReadLoadQueryV1, parseRunReadLogPageV1, parseRunReadLogQueryV1,
  parseRunReadPageV1, RUN_READ_LIMITS } from './run-read';
import type { RunReadItemV1, RunReadListQueryV1, RunReadLoadQueryV1, RunReadLogPageV1, RunReadLogQueryV1,
  RunReadPageV1, RunReadResultV1, RunReadServiceV1, RunReadUnavailableReasonV1 } from './run-read';

export interface RunReadScopeV1 { readonly repo: string | null; readonly epoch: number; readonly active: boolean; readonly signal: AbortSignal; }
const available = <T>(value: T): RunReadResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: RunReadUnavailableReasonV1): RunReadResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Run read scope is no longer active', 'AbortError');
function discard(response: Response | undefined): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > RUN_READ_LIMITS.responseBytes) throw new TypeError('Invalid run response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > RUN_READ_LIMITS.responseBytes) throw new TypeError('Run response exceeds limit');
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHostRunReadService(lifetime: AbortSignal, options: { scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch; pollIntervalMs?: number }): RunReadServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch;
  const interval = options.pollIntervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw new RangeError('Invalid run polling interval');
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
    async function request<T>(path: string, parse: (value: unknown) => T): Promise<RunReadResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 409) return unavailable('selection-changed');
        if (response.status === 404) return unavailable('not-found');
        if (!response.ok) return unavailable('service-unavailable');
        try { const value = await body(response, signal); check(); signal.throwIfAborted(); return available(parse(value)); }
        catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    async function permitted(repo: string | null): Promise<RunReadResultV1<readonly string[]>> {
      if (scope.repo !== null && repo !== scope.repo) return unavailable('forbidden');
      const result = await request('/api/context', parseTaskReadGalleons);
      if (result.status === 'unavailable') return result;
      if (repo !== null && !result.value.includes(repo)) return unavailable('forbidden');
      return available(repo === null ? result.value : Object.freeze([repo]));
    }
    return { request, permitted, check };
  }
  async function list(input: RunReadListQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadPageV1>> {
    const query = parseRunReadListQueryV1(input); const call = operation(signal); const permission = await call.permitted(query.repo);
    if (permission.status === 'unavailable') return permission;
    const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit) });
    if (query.repo !== null) params.set('repo', query.repo); if (query.cursor !== null) params.set('cursor', query.cursor);
    return call.request(`/api/run-read?${params}`, value => parseRunReadPageV1(value, query, permission.value));
  }
  async function load(input: RunReadLoadQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadItemV1>> {
    const query = parseRunReadLoadQueryV1(input); const call = operation(signal); const permission = await call.permitted(query.repo);
    if (permission.status === 'unavailable') return permission;
    return call.request(`/api/run-read/${encodeURIComponent(query.runId)}?${new URLSearchParams({ repo: query.repo })}`, value => parseRunReadItemV1(value, query));
  }
  async function log(input: RunReadLogQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadLogPageV1>> {
    const query = parseRunReadLogQueryV1(input); const call = operation(signal); const permission = await call.permitted(query.repo);
    if (permission.status === 'unavailable') return permission;
    const params = new URLSearchParams({ repo: query.repo, limit: String(query.limit) }); if (query.cursor !== null) params.set('cursor', query.cursor);
    return call.request(`/api/run-read/${encodeURIComponent(query.runId)}/log?${params}`, value => parseRunReadLogPageV1(value, query));
  }
  function watch<T>(read: (signal: AbortSignal) => Promise<RunReadResultV1<T>>, listener: (result: RunReadResultV1<T>) => void,
    caller?: AbortSignal, delay: (result: RunReadResultV1<T>) => number = () => interval): () => void {
    if (typeof listener !== 'function') throw new TypeError('Run read listener must be a function');
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
  return Object.freeze<RunReadServiceV1>({ version: 1, list, load, log,
    watchList(input, listener, signal) { const query = parseRunReadListQueryV1(input); return watch(signal => list(query, signal), listener, signal); },
    watchLoad(input, listener, signal) { const query = parseRunReadLoadQueryV1(input); return watch(signal => load(query, signal), listener, signal); },
    watchLog(input, listener, signal) {
      let query = parseRunReadLogQueryV1(input); let sequence = 0;
      return watch(async signal => {
        const result = await log(query, signal);
        if (result.status === 'available') {
          if (result.value.events.some(event => event.sequence <= sequence)) return unavailable('invalid-response');
          sequence = result.value.events.at(-1)?.sequence ?? sequence;
          query = { ...query, cursor: result.value.nextCursor };
        }
        return result;
      }, listener, signal, result => result.status === 'available' && result.value.hasMore ? 0 : interval);
    },
  });
}
