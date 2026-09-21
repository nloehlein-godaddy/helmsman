import { parseTaskEditQueryV1, parseTaskEditLoadQueryV1, parseTaskEditListQueryV1, parseTaskEditEnvelopeV1, parseTaskEditorDeclarationV1, parseTaskEditPageV1,
  type TaskEditServiceV1, type TaskEditDiscoveryV1 } from './task-edit';
import { parseTaskReadSelectionV1, type TaskReadResultV1, type TaskReadUnavailableReasonV1 } from './task-read';
import { parseTaskRepo } from './tasks';
import { invalidSourceContract, sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';
import type { TaskReadScopeV1 } from './task-read-service';

const available = <T>(value: T): TaskReadResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: TaskReadUnavailableReasonV1): TaskReadResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Task editor scope is no longer active', 'AbortError');
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function discard(response: Response | undefined): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new TypeError('Invalid editor response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new TypeError('Editor response exceeds limit'); text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function discovery(input: unknown, repo: string | null): TaskEditDiscoveryV1 {
  const value = sourceObject(sourceJson(input, 2 * 1024 * 1024)); sourceFields(value, ['version', 'repo', 'sources']);
  if (value.version !== 1 || value.repo !== repo || !Array.isArray(value.sources) || value.sources.length > 1000) invalidSourceContract();
  const sources = value.sources.map(raw => {
    const item = sourceObject(raw); sourceFields(item, ['selection', 'label', 'availability', 'editors']); const selection = parseTaskReadSelectionV1(item.selection);
    if (repo !== null && selection.repo !== repo || !['available', 'disabled', 'unavailable'].includes(String(item.availability)) || !Array.isArray(item.editors) || item.editors.length > 16) invalidSourceContract();
    const editors = Object.freeze(item.editors.map(parseTaskEditorDeclarationV1));
    if (new Set(editors.map(editor => editor.id)).size !== editors.length) invalidSourceContract();
    return Object.freeze({ selection, label: sourceText(item.label, 240), availability: item.availability as 'available' | 'disabled' | 'unavailable', editors });
  });
  if (new Set(sources.map(source => `${source.selection.repo}:${source.selection.instanceId}`)).size !== sources.length) invalidSourceContract();
  return Object.freeze({ version: 1, repo, sources: Object.freeze(sources) });
}
export function createHostTaskEditService(lifetime: AbortSignal, options: { scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch }): TaskEditServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch;
  function operation(caller?: AbortSignal) {
    const scope = { ...options.scope() }; const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    async function request<T>(path: string, parse: (body: unknown) => T, input?: unknown): Promise<TaskReadResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: input ? 'POST' : 'GET', signal, credentials: 'same-origin',
          headers: { Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 409) return unavailable('selection-changed');
        if (response.status === 501) return unavailable('view-unavailable');
        if (!response.ok) return unavailable('service-unavailable');
        try { const result = await body(response, signal); check(); signal.throwIfAborted(); return available(parse(result)); }
        catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    return { request, repo: scope.repo, permitted: (repo: string) => scope.repo === null || scope.repo === repo };
  }
  return Object.freeze<TaskEditServiceV1>({ version: 1,
    async discover(signal) {
      const call = operation(signal); if (call.repo !== null) parseTaskRepo(call.repo);
      return call.request(`/api/task-edit${call.repo === null ? '' : `?${new URLSearchParams({ repo: call.repo })}`}`, value => discovery(value, call.repo));
    },
    async create(input, signal) {
      const query = parseTaskEditQueryV1(input); const call = operation(signal);
      return call.permitted(query.selection.repo) ? call.request('/api/task-edit/create', value => parseTaskEditEnvelopeV1(value, query), query) : Promise.resolve(unavailable('forbidden'));
    },
    async load(input, signal) {
      const query = parseTaskEditLoadQueryV1(input); const call = operation(signal);
      return call.permitted(query.selection.repo) ? call.request('/api/task-edit/load', value => value === null ? null : parseTaskEditEnvelopeV1(value, query), query) : Promise.resolve(unavailable('forbidden'));
    },
    async list(input, signal) {
      const query = parseTaskEditListQueryV1(input); const call = operation(signal);
      return call.permitted(query.selection.repo) ? call.request('/api/task-edit/list', value => parseTaskEditPageV1(value, query), query) : Promise.resolve(unavailable('forbidden'));
    },
  });
}
