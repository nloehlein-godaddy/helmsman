import { createRunCommandJournal, RunCommandJournalValidationError, type RunCommandJournal } from './run-command-journal';
import { parseRunCommandInputV1, parseRunCommandReceiptQueryV1, parseRunCommandReceiptV1, RunCommandValidationError, RUN_COMMAND_LIMITS } from './run-command';
import type { RunCommandInputV1, RunCommandReceiptQueryV1, RunCommandReceiptV1, RunCommandResultV1, RunCommandServiceV1, RunCommandUnavailableReasonV1 } from './run-command';
import type { RunReadScopeV1 } from './run-read-service';

const available = <T>(value: T): RunCommandResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: RunCommandUnavailableReasonV1): RunCommandResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Command scope is no longer active', 'AbortError');

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function discard(response: Response | undefined): void {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > RUN_COMMAND_LIMITS.responseBytes) throw new TypeError('Invalid command response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength;
      if (bytes > RUN_COMMAND_LIMITS.responseBytes) throw new TypeError('Command response exceeds limit');
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHostRunCommandService(lifetime: AbortSignal, options: {
  caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch; journal?: RunCommandJournal;
}): RunCommandServiceV1 {
  const journal = options.journal ?? createRunCommandJournal(options.caller);
  const fetcher = options.fetch ?? globalThis.fetch;
  function operation(caller?: AbortSignal) {
    const scope = { ...options.scope() };
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted();
      const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    async function request(path: string, expected: RunCommandReceiptQueryV1 & { action?: RunCommandInputV1['action'] }, command?: unknown): Promise<RunCommandResultV1<RunCommandReceiptV1 | null>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: command ? 'POST' : 'GET', signal, credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Helmsman-Contribution': options.caller, ...(command ? { 'Content-Type': 'application/json' } : {}) },
          ...(command ? { body: JSON.stringify(command) } : {}) }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 404) return unavailable('not-found');
        if (response.status === 409) return unavailable('conflict');
        if (!response.ok) return unavailable('service-unavailable');
        let receipt: RunCommandReceiptV1 | null;
        try {
          const body = await readBody(response, signal); check(); signal.throwIfAborted();
          receipt = !command && body === null ? null : parseRunCommandReceiptV1(body, expected);
        } catch { check(); signal.throwIfAborted(); return unavailable('invalid-response'); }
        if (receipt) {
          try { receipt = await abortable(journal.record(receipt), signal); }
          catch (error) {
            check(); signal.throwIfAborted();
            return unavailable(error instanceof RunCommandJournalValidationError || error instanceof RunCommandValidationError
              ? 'invalid-response' : 'service-unavailable');
          }
        }
        check(); signal.throwIfAborted(); return available(receipt);
      } catch { check(); return unavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    return { check, signal, permitted: (repo: string) => scope.repo === null || scope.repo === repo, request };
  }
  return Object.freeze<RunCommandServiceV1>({
    version: 1,
    async submit(value, caller) {
      const input = parseRunCommandInputV1(value); const call = operation(caller);
      if (!call.permitted(input.repo)) return unavailable('forbidden');
      let command;
      try { command = await abortable(journal.reserve(input, call.signal), call.signal); }
      catch { call.check(); return unavailable('service-unavailable'); }
      call.check();
      const result = await call.request('/api/run-commands', command, command);
      return result.status === 'unavailable' ? result : result.value === null ? unavailable('invalid-response') : available(result.value);
    },
    async receipt(value, caller) {
      const input = parseRunCommandReceiptQueryV1(value); const call = operation(caller);
      if (!call.permitted(input.repo)) return unavailable('forbidden');
      return call.request(`/api/run-commands/${encodeURIComponent(input.requestId)}?${new URLSearchParams({ repo: input.repo })}`, input);
    },
    async acknowledge(value) {
      const input = parseRunCommandReceiptQueryV1(value); const call = operation();
      if (!call.permitted(input.repo)) throw new TypeError('Command is outside the current scope');
      await abortable(journal.acknowledge(input), call.signal); call.check();
    },
    async pending() {
      const call = operation(); const entries = await abortable(journal.pending(), call.signal); call.check();
      return Object.freeze(entries.filter(entry => call.permitted(entry.command.repo)));
    },
  });
}
