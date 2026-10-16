import { apiFetch, rejectApiCache } from '../data/api-client';
import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons } from './task-read';
import { parseRunReadListQueryV1 } from './run-read';
import type { RunReadScopeV1 } from './run-read-service';
import { parseRunInspectExportMetadataV1, parseRunInspectExportQueryV1, parseRunInspectHistoryPageV1, parseRunInspectLogPageV1,
  parseRunInspectLogQueryV1, parseRunInspectResolvedV1, parseRunInspectResolveQueryV1, RUN_INSPECT_LIMITS } from './run-inspect';
import type { RunInspectResultV1, RunInspectServiceV1, RunInspectTargetV1 } from './run-inspect';

type Reason = Extract<RunInspectResultV1<never>, { status: 'unavailable' }>['reason'];
const unavailable = (reason: Reason): RunInspectResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const available = <T>(value: T): RunInspectResultV1<T> => Object.freeze({ status: 'available', value });
const cancelled = () => new DOMException('Run inspection scope is inactive', 'AbortError');
function discard(response: Response | undefined) { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > RUN_INSPECT_LIMITS.responseBytes) throw new TypeError('Invalid inspection response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0; let complete = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { complete = true; return JSON.parse(text + decoder.decode()); }
      bytes += part.value.byteLength; if (bytes > RUN_INSPECT_LIMITS.responseBytes) throw new TypeError('Inspection response is too large');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function responseFailure(response: Response, signal: AbortSignal): Promise<RunInspectResultV1<never>> {
  if (response.status === 401 || response.status === 403) return unavailable('forbidden');
  if (response.status === 404) return unavailable('not-found');
  if (response.status === 409) {
    try { const value = await json(response, signal) as { error?: unknown } | null;
      if (value?.error === 'attempt-changed' || value?.error === 'cursor-invalid' || value?.error === 'selection-changed') return unavailable(value.error);
    } catch { signal.throwIfAborted(); }
    return unavailable('selection-changed');
  }
  return unavailable('service-unavailable');
}
export function createHostRunInspectService(lifetime: AbortSignal, options: { scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch }): RunInspectServiceV1 {
  const fetcher = options.fetch ?? apiFetch;
  function operation(caller?: AbortSignal) {
    const original = options.scope(); const scope = { ...original, repo: original.repo === null ? null : parseTaskRepo(original.repo) };
    const signal = AbortSignal.any([lifetime, scope.signal, ...(caller ? [caller] : [])]);
    function check() {
      signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    async function response(path: string, requestSignal: AbortSignal, accept = 'application/json') {
      check(); requestSignal.throwIfAborted();
      const value = await abortable(fetcher(path, { method: 'GET', credentials: 'same-origin', signal: requestSignal, headers: { Accept: accept } }).then(value => {
        try { check(); requestSignal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
      }), requestSignal); check(); return value;
    }
    async function request<T>(path: string, parse: (value: unknown) => T): Promise<RunInspectResultV1<T>> {
      const timeout = AbortSignal.timeout(30_000); const requestSignal = AbortSignal.any([signal, timeout]); let value: Response | undefined;
      try {
        value = await response(path, requestSignal);
        if (!value.ok) return await responseFailure(value, requestSignal);
        try { const result = parse(await json(value, requestSignal)); check(); requestSignal.throwIfAborted(); return available(result); }
        catch { check(); requestSignal.throwIfAborted(); rejectApiCache(path); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(value); }
    }
    async function permitted(repo: string | null): Promise<RunInspectResultV1<readonly string[]>> {
      if (scope.repo !== null && repo !== scope.repo) return unavailable('forbidden');
      const result = await request('/api/context', parseTaskReadGalleons);
      if (result.status === 'unavailable') return result;
      if (repo !== null && !result.value.includes(repo)) return unavailable('forbidden');
      return available(repo === null ? result.value : Object.freeze([repo]));
    }
    function params(target: RunInspectTargetV1): URLSearchParams {
      const params = new URLSearchParams({ repo: target.repo, expectedAttempt: String(target.expectedAttempt) });
      if (scope.repo !== null) params.set('scopeRepo', scope.repo); return params;
    }
    return { scope, signal, check, request, permitted, params, response };
  }
  return Object.freeze<RunInspectServiceV1>({ version: 1,
    async resolve(input, signal) {
      const query = parseRunInspectResolveQueryV1(input); const call = operation(signal); const repos = await call.permitted(call.scope.repo);
      if (repos.status === 'unavailable') return repos;
      const params = new URLSearchParams({ runId: query.runId }); if (call.scope.repo !== null) params.set('repo', call.scope.repo);
      return call.request(`/api/run-inspect/resolve?${params}`, value => parseRunInspectResolvedV1(value, query, repos.value));
    },
    async history(input, signal) {
      const query = parseRunReadListQueryV1(input); const call = operation(signal); const repos = await call.permitted(query.repo);
      if (repos.status === 'unavailable') return repos;
      const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit) });
      if (query.repo !== null) params.set('repo', query.repo); if (query.cursor !== null) params.set('cursor', query.cursor);
      return call.request(`/api/run-inspect/history?${params}`, value => parseRunInspectHistoryPageV1(value, query, repos.value));
    },
    async log(input, signal) {
      const query = parseRunInspectLogQueryV1(input); const call = operation(signal); const repos = await call.permitted(query.target.repo);
      if (repos.status === 'unavailable') return repos;
      const params = call.params(query.target); params.set('direction', query.direction); params.set('limit', String(query.limit)); if (query.cursor !== null) params.set('cursor', query.cursor);
      return call.request(`/api/run-inspect/${encodeURIComponent(query.target.runId)}/log?${params}`, value => parseRunInspectLogPageV1(value, query));
    },
    async exportLog(input, signal) {
      const query = parseRunInspectExportQueryV1(input); const call = operation(signal); const repos = await call.permitted(query.target.repo);
      if (repos.status === 'unavailable') return repos;
      const controller = new AbortController(); const requestSignal = AbortSignal.any([call.signal, controller.signal]);
      let timedOut = false; let value: Response | undefined; let transferred = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      try {
        value = await call.response(`/api/run-inspect/${encodeURIComponent(query.target.runId)}/export?${call.params(query.target)}`, requestSignal, 'text/plain');
        if (!value.ok) return await responseFailure(value, requestSignal);
        const header = value.headers.get('x-helmsman-run-inspect');
        if (!header || header.length > 8192 || !value.body) return unavailable('invalid-response');
        let metadata;
        try { metadata = parseRunInspectExportMetadataV1(JSON.parse(decodeURIComponent(header)), query);
          if (value.headers.get('content-type') !== metadata.contentType) return unavailable('invalid-response');
        } catch { return unavailable('invalid-response'); }
        call.check(); const reader = value.body.getReader(); let finished = false; let streamController: ReadableStreamDefaultController<Uint8Array>;
        let buffered: Uint8Array | null = null; let offset = 0;
        function finish() { finished = true; buffered = null; requestSignal.removeEventListener('abort', cancel); }
        async function cancelReader(reason?: unknown) { try { await reader.cancel(reason); } catch {} finally { reader.releaseLock(); } }
        function cancel() {
          if (finished) return; finish(); void cancelReader(requestSignal.reason);
          streamController.error(requestSignal.reason ?? cancelled());
        }
        const stream = new ReadableStream<Uint8Array>({
          start(value) { streamController = value; requestSignal.addEventListener('abort', cancel, { once: true }); if (requestSignal.aborted) cancel(); },
          async pull(value) {
            if (finished) return;
            try {
              call.check();
              while (!buffered) {
                const part = await abortable(reader.read(), requestSignal); call.check(); if (finished) return;
                if (part.done) { finish(); reader.releaseLock(); value.close(); return; }
                if (part.value.byteLength > RUN_INSPECT_LIMITS.responseBytes) throw new Error('Export chunk exceeds limit');
                if (part.value.byteLength) { buffered = part.value; offset = 0; }
              }
              const end = Math.min(buffered.byteLength, offset + RUN_INSPECT_LIMITS.exportChunkBytes);
              value.enqueue(buffered.slice(offset, end)); offset = end; if (offset === buffered.byteLength) buffered = null;
            } catch (error) { if (!finished) { finish(); void cancelReader(error); controller.abort(error); value.error(error); } }
          },
          async cancel(reason) { if (!finished) { finish(); controller.abort(reason); await cancelReader(reason); } },
        }, { highWaterMark: 0 });
        transferred = true; return available(Object.freeze({ ...metadata, stream }));
      } catch { call.check(); return unavailable(timedOut ? 'timeout' : 'connection-failed'); }
      finally { clearTimeout(timer); if (!transferred) { controller.abort(); discard(value); } }
    },
  });
}
