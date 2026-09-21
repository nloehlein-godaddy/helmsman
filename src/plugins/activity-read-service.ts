import { ACTIVITY_READ_LIMITS, parseActivityReadSnapshotV1, type ActivityReadServiceV1 } from './activity-read';
import { createHostTaskReadService, type TaskReadScopeV1 } from './task-read-service';
import { parseTaskReadSelectionV1, type TaskReadUnavailableReasonV1 } from './task-read';

const unavailable = (reason: TaskReadUnavailableReasonV1) => Object.freeze({ status: 'unavailable' as const, reason });
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function discard(response?: Response): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > ACTIVITY_READ_LIMITS.responseBytes) throw new TypeError('Invalid activity response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let result = ''; let bytes = 0; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(result + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > ACTIVITY_READ_LIMITS.responseBytes) throw new TypeError('Activity response too large');
      result += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createHostActivityReadService(lifetime: AbortSignal, options: { scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch }): ActivityReadServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch;
  return Object.freeze<ActivityReadServiceV1>({ version: 1, async query(input, caller) {
    const selection = parseTaskReadSelectionV1(input); const scope = { ...options.scope() };
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw new DOMException('Activity scope changed', 'AbortError');
    }
    check();
    if (scope.repo !== null && scope.repo !== selection.repo) return unavailable('forbidden');
    const timeout = AbortSignal.timeout(30_000); const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    let response: Response | undefined;
    try {
      const tasks = createHostTaskReadService(lifetime, { fetch: fetcher, scope: () => ({ ...options.scope(), repo: options.scope().repo ?? selection.repo }) });
      const discovery = await tasks.discover(signal); check(); signal.throwIfAborted();
      if (discovery.status === 'unavailable') return discovery;
      const galleon = discovery.value.galleons.find(galleon => galleon.repo === selection.repo);
      if (!galleon) return unavailable('forbidden');
      if (galleon.sources.status === 'unavailable') return galleon.sources;
      const source = galleon.sources.value.find(source => source.instanceId === selection.instanceId);
      if (!source || source.sourceId !== selection.sourceId || source.instanceRevision !== selection.instanceRevision) return unavailable('selection-changed');
      if (source.availability !== 'available') return unavailable(source.availability === 'disabled' ? 'disabled' : 'source-unavailable');
      if (!source.readViews?.includes('history')) return unavailable('view-unavailable');
      const params = new URLSearchParams({ repo: selection.repo, revision: String(selection.instanceRevision), sourceId: selection.sourceId });
      response = await abortable<Response>(fetcher(`/api/activity-read/${encodeURIComponent(selection.instanceId)}?${params}`, { method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(value => {
        try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
      }), signal);
      check(); signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) return unavailable('forbidden');
      if (response.status === 409) return unavailable('selection-changed');
      if (response.status === 501) return unavailable('view-unavailable');
      if (!response.ok) return unavailable('service-unavailable');
      let result;
      try { result = parseActivityReadSnapshotV1(await body(response, signal), selection); }
      catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
      check(); signal.throwIfAborted(); return Object.freeze({ status: 'available', value: result });
    } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
    finally { discard(response); }
  } });
}
