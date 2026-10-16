import { apiFetch } from '../data/api-client';
import { parseTaskContextQueryV1, parseTaskContextSnapshotV1, TASK_CONTEXT_LIMITS } from './task-context';
import type { TaskContextQueryV1, TaskContextResultV1, TaskContextServiceV1, TaskContextUnavailableReasonV1 } from './task-context';
import type { TaskReadScopeV1 } from './task-read-service';

const unavailable = (reason: TaskContextUnavailableReasonV1): TaskContextResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Task context scope is no longer active', 'AbortError');
function discard(response?: Response): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void; const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > TASK_CONTEXT_LIMITS.responseBytes) throw new TypeError('Invalid task context response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let result = ''; let complete = false;
  try { while (true) { const next = await abortable(reader.read(), signal); if (next.done) { complete = true; return JSON.parse(result + decoder.decode()) as unknown; } bytes += next.value.byteLength; if (bytes > TASK_CONTEXT_LIMITS.responseBytes) throw new TypeError('Task context response exceeds limit'); result += decoder.decode(next.value, { stream: true }); } }
  finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHostTaskContextService(lifetime: AbortSignal, options: { scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch }): TaskContextServiceV1 {
  const fetcher = options.fetch ?? apiFetch;
  return Object.freeze<TaskContextServiceV1>({ version: 1, async resolve(input: TaskContextQueryV1, caller?: AbortSignal) {
    const query = parseTaskContextQueryV1(input); const current = options.scope(); const scope = { ...current };
    const check = () => { lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope(); if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled(); };
    check(); if (scope.repo !== null && scope.repo !== query.selection.repo) return unavailable('forbidden');
    const timeout = AbortSignal.timeout(30_000); const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]); let response: Response | undefined;
    try {
      const params = new URLSearchParams({ repo: query.selection.repo, sourceId: query.selection.sourceId, revision: String(query.selection.instanceRevision), taskRevision: query.taskRevision, claim: query.claim });
      response = await abortable(fetcher(`/api/task-context/${encodeURIComponent(query.selection.instanceId)}/${encodeURIComponent(query.ref.externalId)}?${params}`, { method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }), signal); check();
      if (response.status === 401 || response.status === 403) return unavailable('forbidden'); if (response.status === 404) return unavailable('not-found'); if (response.status === 409) return unavailable('selection-changed'); if (!response.ok) return unavailable('service-unavailable');
      try { const value = parseTaskContextSnapshotV1(await body(response, signal), query); check(); return Object.freeze({ status: 'available' as const, value }); }
      catch { check(); return unavailable('invalid-response'); }
    } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
    finally { discard(response); }
  } });
}
