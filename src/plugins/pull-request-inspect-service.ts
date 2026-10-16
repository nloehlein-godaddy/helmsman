import { apiFetch, rejectApiCache } from '../data/api-client';
import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons } from './task-read';
import { parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1, PULL_REQUEST_INSPECT_LIMITS } from './pull-request-inspect';
import type { PullRequestInspectResultV1, PullRequestInspectServiceV1, PullRequestInspectUnavailableReasonV1 } from './pull-request-inspect';

export interface PullRequestInspectScopeV1 { readonly repo: string | null; readonly epoch: number; readonly active: boolean; readonly signal: AbortSignal; }
const unavailable = (reason: PullRequestInspectUnavailableReasonV1): PullRequestInspectResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Pull request inspection scope is no longer active', 'AbortError');
function discard(response: Response | undefined) { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > PULL_REQUEST_INSPECT_LIMITS.responseBytes) throw new TypeError('Invalid inspection response');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > PULL_REQUEST_INSPECT_LIMITS.responseBytes) throw new TypeError('Inspection response exceeds limit');
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createHostPullRequestInspectService(lifetime: AbortSignal, options: { scope(): PullRequestInspectScopeV1; fetch?: typeof globalThis.fetch }): PullRequestInspectServiceV1 {
  const fetcher = options.fetch ?? apiFetch;
  function operation(caller?: AbortSignal) {
    const current = options.scope(); const scope = { ...current, repo: current.repo === null ? null : parseTaskRepo(current.repo) };
    const timeout = AbortSignal.timeout(30_000); const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.repo !== scope.repo || latest.epoch !== scope.epoch || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    async function request<T>(path: string, parse: (value: unknown) => T): Promise<PullRequestInspectResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: 'GET', credentials: 'same-origin', signal, headers: { Accept: 'application/json' } }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 404) return unavailable('not-found');
        if (!response.ok) {
          if ([409, 502, 503, 504].includes(response.status)) {
            const value = await body(response, signal); check(); signal.throwIfAborted();
            const reason = value && typeof value === 'object' ? (value as { reason?: unknown }).reason : null;
            const allowed = response.status === 409 ? ['selection-changed', 'head-changed'] : response.status === 502 ? ['invalid-response'] : response.status === 504 ? ['timeout'] : ['service-unavailable'];
            if (typeof reason === 'string' && allowed.includes(reason)) return unavailable(reason as PullRequestInspectUnavailableReasonV1);
          }
          return unavailable('service-unavailable');
        }
        try { const value = await body(response, signal); check(); signal.throwIfAborted(); return Object.freeze({ status: 'available', value: parse(value) }); }
        catch { check(); signal.throwIfAborted(); rejectApiCache(path); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    async function permitted(repo: string): Promise<PullRequestInspectResultV1<readonly string[]>> {
      if (scope.repo !== null && repo !== scope.repo) return unavailable('forbidden');
      const result = await request('/api/context', parseTaskReadGalleons);
      return result.status === 'available' && !result.value.includes(repo) ? unavailable('forbidden') : result;
    }
    return { request, permitted };
  }
  return Object.freeze<PullRequestInspectServiceV1>({ version: 1,
    async detail(input, caller) {
      const query = parsePullRequestInspectDetailQueryV1(input); const call = operation(caller); const permission = await call.permitted(query.repo);
      if (permission.status === 'unavailable') return permission;
      return call.request(`/api/pull-request-inspect/detail?${new URLSearchParams({ repo: query.repo, number: String(query.number) })}`, value => parsePullRequestInspectDetailV1(value, query));
    },
    async diff(input, caller) {
      const query = parsePullRequestInspectDiffQueryV1(input); const call = operation(caller); const permission = await call.permitted(query.target.repo);
      if (permission.status === 'unavailable') return permission;
      const { repo, number, headSha, baseSha } = query.target;
      return call.request(`/api/pull-request-inspect/diff?${new URLSearchParams({ repo, number: String(number), headSha, baseSha })}`, value => parsePullRequestInspectDiffV1(value, query));
    },
  });
}
