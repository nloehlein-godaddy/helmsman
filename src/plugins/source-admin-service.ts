import { parseSourceAdminInputV1, parseSourceAdminReceiptQueryV1, parseSourceAdminReceiptV1, parseSourceAdminSnapshotV1, parseSourceAdminValidationInputV1, parseSourceAdminValidationV1,
  type SourceAdminServiceV1, type SourceAdminReceiptV1 } from './source-admin';
import { createSourceAdminJournal, type SourceAdminJournal } from './source-admin-journal';
import type { SourceCommandResultV1, SourceCommandUnavailableReasonV1 } from './source-command';
import type { TaskReadScopeV1 } from './task-read-service';
const available = <T>(value: T): SourceCommandResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: SourceCommandUnavailableReasonV1): SourceCommandResultV1<never> => Object.freeze({ status: 'unavailable', reason });
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
export function createHostSourceAdminService(lifetime: AbortSignal, options: { caller: string; scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch; journal?: SourceAdminJournal }): SourceAdminServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch; const journal = options.journal ?? createSourceAdminJournal(options.caller);
  function operation(caller?: AbortSignal) {
    const scope = { ...options.scope() }; const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    async function request<T>(path: string, parse: (body: unknown) => T, input?: unknown): Promise<SourceCommandResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: input ? 'POST' : 'GET', signal, credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Helmsman-Contribution': options.caller, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 409) return unavailable('conflict');
        if (!response.ok) return unavailable('service-unavailable');
        try { const result = await body(response, signal); check(); signal.throwIfAborted(); return available(parse(result)); }
        catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    async function record(receipt: SourceAdminReceiptV1): Promise<SourceCommandResultV1<SourceAdminReceiptV1>> {
      try { const saved = await abortable(journal.record(receipt), signal); check(); return available(saved); }
      catch { check(); return unavailable('invalid-response'); }
    }
    return { request, record, check, signal, repo: scope.repo, permitted: (repo: string | null) => scope.repo === null || scope.repo === repo };
  }
  return Object.freeze<SourceAdminServiceV1>({ version: 1,
    async snapshot(signal) {
      const call = operation(signal);
      return call.request(`/api/source-admin${call.repo === null ? '' : `?${new URLSearchParams({ repo: call.repo })}`}`, value => parseSourceAdminSnapshotV1(value, call.repo));
    },
    async validateReplacement(value, signal) {
      const input = parseSourceAdminValidationInputV1(value); const call = operation(signal);
      return call.permitted(input.repo) ? call.request('/api/source-admin/validate', body => parseSourceAdminValidationV1(body, input), input) : unavailable('forbidden');
    },
    async submit(value, signal) {
      const input = parseSourceAdminInputV1(value); const call = operation(signal);
      if (!call.permitted(input.repo)) return unavailable('forbidden');
      let command;
      try { command = await abortable(journal.reserve(input, call.signal), call.signal); }
      catch { call.check(); return unavailable('service-unavailable'); }
      call.check();
      const result = await call.request('/api/source-admin/commands', body => parseSourceAdminReceiptV1(body, command), command);
      return result.status === 'unavailable' ? result : call.record(result.value);
    },
    async receipt(value, signal) {
      const query = parseSourceAdminReceiptQueryV1(value); const call = operation(signal);
      if (!call.permitted(query.repo)) return unavailable('forbidden');
      const result = await call.request(`/api/source-admin/commands/${encodeURIComponent(query.requestId)}${query.repo === null ? '' : `?${new URLSearchParams({ repo: query.repo })}`}`, body => body === null ? null : parseSourceAdminReceiptV1(body, query));
      return result.status === 'unavailable' || result.value === null ? result : call.record(result.value);
    },
    async pending() {
      const call = operation(); const entries = await abortable(journal.pending(), call.signal); call.check();
      return Object.freeze(entries.filter(entry => call.permitted(entry.command.repo)));
    },
    async acknowledge(value) {
      const query = parseSourceAdminReceiptQueryV1(value); const call = operation();
      if (!call.permitted(query.repo)) throw new TypeError('Administration command is outside the current scope');
      await abortable(journal.acknowledge(query, call.signal), call.signal); call.check();
    },
  });
}
