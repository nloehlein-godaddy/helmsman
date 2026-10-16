import { apiFetch } from '../data/api-client';
import { legacyTodoPending, parseLegacyTodoCommandQuery, parseLegacyTodoCommandReceipt,
  type LegacyTodoCommandQuery, type TodoLegacyRecoveryResultV1, type TodoLegacyRecoveryServiceV1 } from './todo-legacy-recovery';
import type { TaskReadScopeV1 } from './task-read-service';

const storageKey = 'helmsman.todos.pending-mutations.v1';
type JournalEntry = { key: string; query: LegacyTodoCommandQuery };
type UnavailableReason = Extract<TodoLegacyRecoveryResultV1<never>, { status: 'unavailable' }>['reason'];
const unavailable = (reason: UnavailableReason): TodoLegacyRecoveryResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const available = <T>(value: T): TodoLegacyRecoveryResultV1<T> => Object.freeze({ status: 'available', value });
class RecoveryUnavailable extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason) { super(reason); this.reason = reason; }
}
const cancelled = () => new DOMException('Legacy recovery scope is no longer active', 'AbortError');

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function discard(response: Response | undefined): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > 16 * 1024) throw new RecoveryUnavailable('invalid-response');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0; let complete = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += part.value.byteLength; if (bytes > 16 * 1024) throw new RecoveryUnavailable('invalid-response');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHostTodoLegacyRecoveryService(lifetime: AbortSignal, options: {
  scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}): TodoLegacyRecoveryServiceV1 {
  const fetcher = options.fetch ?? apiFetch;
  const confirmed = new Map<string, string>();
  const storage = () => {
    try { return options.storage ?? globalThis.sessionStorage; } catch { throw new RecoveryUnavailable('storage-unavailable'); }
  };
  function journal(): JournalEntry[] {
    let raw: string | null;
    try { raw = storage().getItem(storageKey); } catch { throw new RecoveryUnavailable('storage-unavailable'); }
    if (raw === null) return [];
    try {
      if (raw.length > 8 * 1024 * 1024) throw new Error();
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > 128) throw new Error();
      const ids = new Set<string>(); const keys = new Set<string>();
      return entries.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error();
        const parts: unknown = JSON.parse(entry[0]);
        if (!Array.isArray(parts) || parts.length !== 3) throw new Error();
        const query = parseLegacyTodoCommandQuery({ requestId: entry[1], path: parts[0], method: parts[1], input: parts[2] });
        if (ids.has(query.requestId) || keys.has(entry[0])) throw new Error();
        ids.add(query.requestId); keys.add(entry[0]); return { key: entry[0], query };
      });
    } catch { throw new RecoveryUnavailable('invalid-storage'); }
  }
  function operation(caller?: AbortSignal) {
    const scope = { ...options.scope() }; const timeout = AbortSignal.timeout(10_000);
    const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const current = options.scope();
      if (!scope.active || !current.active || current.epoch !== scope.epoch || current.repo !== scope.repo || current.signal !== scope.signal) throw cancelled();
    }
    function entries() {
      check(); const entries = journal();
      if (entries.length && scope.repo !== null) throw new RecoveryUnavailable('all-galleons-required');
      return entries;
    }
    function find(id: string) {
      const entry = entries().find(entry => entry.query.requestId === id);
      if (!entry) throw new RecoveryUnavailable('request-changed'); return entry;
    }
    async function run<T>(work: () => T | Promise<T>): Promise<TodoLegacyRecoveryResultV1<T>> {
      try { check(); const value = await work(); check(); signal.throwIfAborted(); return available(value); }
      catch (error) { check(); return unavailable(error instanceof RecoveryUnavailable ? error.reason : timeout.aborted ? 'timeout' : 'service-unavailable'); }
    }
    return { check, signal, entries, find, run };
  }
  return Object.freeze<TodoLegacyRecoveryServiceV1>({ version: 1,
    async pending(signal) {
      const call = operation(signal);
      return call.run(() => Object.freeze(call.entries().map(entry => legacyTodoPending(entry.query))));
    },
    async check(requestId, signal) {
      const call = operation(signal);
      return call.run(async () => {
        const entry = call.find(requestId); let response: Response | undefined;
        try {
          response = await abortable<Response>(fetcher('/api/todo-legacy-recovery/receipt', {
            method: 'POST', credentials: 'same-origin', signal: call.signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(entry.query),
          }).then(value => {
            try { call.check(); call.signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
          }), call.signal);
          if (response.status === 409) throw new RecoveryUnavailable('request-changed');
          if (!response.ok) throw new RecoveryUnavailable('service-unavailable');
          let receipt;
          try { receipt = parseLegacyTodoCommandReceipt(await readBody(response, call.signal), entry.query); }
          catch { call.check(); call.signal.throwIfAborted(); throw new RecoveryUnavailable('invalid-response'); }
          call.check(); call.signal.throwIfAborted();
          if (call.find(requestId).key !== entry.key) throw new RecoveryUnavailable('request-changed');
          if (receipt.status === 'succeeded' || receipt.status === 'rejected') confirmed.set(requestId, entry.key);
          else confirmed.delete(requestId);
          return receipt;
        } finally { discard(response); }
      });
    },
    async acknowledge(requestId, signal) {
      const call = operation(signal);
      return call.run(() => {
        const entry = call.find(requestId);
        if (confirmed.get(requestId) !== entry.key) throw new RecoveryUnavailable('confirmation-required');
        const remaining = call.entries().filter(value => value.key !== entry.key);
        call.check(); call.signal.throwIfAborted();
        try {
          if (remaining.length) storage().setItem(storageKey, JSON.stringify(remaining.map(value => [value.key, value.query.requestId])));
          else storage().removeItem(storageKey);
        } catch { throw new RecoveryUnavailable('storage-unavailable'); }
        confirmed.delete(requestId);
      });
    },
  });
}
