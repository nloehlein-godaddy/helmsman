import { isContributionId } from './manifest';
import { parseRunCommandInputV1, parseRunCommandReceiptQueryV1, parseRunCommandReceiptV1, parseRunCommandV1 } from './run-command';
import type { RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptQueryV1, RunCommandReceiptV1, RunCommandV1 } from './run-command';

interface Entry extends RunCommandPendingV1 { readonly key: string; readonly caller: string; }
export class RunCommandJournalValidationError extends Error {}
export interface RunCommandJournal {
  reserve(input: RunCommandInputV1, signal?: AbortSignal): Promise<RunCommandV1>;
  record(receipt: RunCommandReceiptV1): Promise<RunCommandReceiptV1>;
  acknowledge(query: RunCommandReceiptQueryV1): Promise<void>;
  pending(): Promise<readonly RunCommandPendingV1[]>;
}

export function createRunCommandJournal(caller: string, options: { indexedDB?: IDBFactory; databaseName?: string; uuid?: () => string } = {}): RunCommandJournal {
  if (!isContributionId(caller)) throw new TypeError('Invalid command contribution');
  async function transaction<T>(execute: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
    mode: IDBTransactionMode, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('Durable command storage is unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? 'helmsman.run-commands', 1);
      let rejected = false;
      const cancel = () => { rejected = true; reject(signal?.reason ?? new DOMException('Command cancelled', 'AbortError')); };
      signal?.addEventListener('abort', cancel, { once: true });
      request.onupgradeneeded = () => {
        const table = request.result.createObjectStore('pending', { keyPath: 'key' });
        table.createIndex('caller', 'caller');
        table.createIndex('request', ['caller', 'command.requestId'], { unique: true });
      };
      request.onerror = () => { signal?.removeEventListener('abort', cancel); reject(request.error ?? new Error('Command storage unavailable')); };
      request.onblocked = () => { signal?.removeEventListener('abort', cancel); rejected = true; reject(new Error('Command storage is blocked')); };
      request.onsuccess = () => { signal?.removeEventListener('abort', cancel); if (rejected) request.result.close(); else resolve(request.result); };
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        signal?.throwIfAborted();
        const tx = database.transaction('pending', mode); let result: T; let failure: unknown;
        const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
        const cancel = () => fail(signal?.reason ?? new DOMException('Command cancelled', 'AbortError'));
        tx.oncomplete = () => { signal?.removeEventListener('abort', cancel); resolve(result); };
        tx.onabort = () => { signal?.removeEventListener('abort', cancel); reject(failure ?? tx.error ?? new Error('Command storage aborted')); };
        tx.onerror = () => { failure ??= tx.error; };
        signal?.addEventListener('abort', cancel, { once: true });
        try { execute(tx.objectStore('pending'), value => { result = value; }, fail); } catch (error) { fail(error); }
      });
    } finally { database.close(); }
  }
  function entry(value: unknown): Entry {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid saved command');
    const data = value as Partial<Entry>;
    const command = parseRunCommandV1(data.command);
    const { requestId: _requestId, ...input } = command;
    const key = JSON.stringify([caller, parseRunCommandInputV1(input)]);
    if (data.caller !== caller || data.key !== key) throw new TypeError('Saved command identity changed');
    return { caller, key, command, receipt: data.receipt === null ? null : parseRunCommandReceiptV1(data.receipt, command) };
  }
  return {
    reserve(input, signal) {
      const intent = parseRunCommandInputV1(input); const key = JSON.stringify([caller, intent]);
      return transaction<RunCommandV1>((table, done, fail) => {
        const read = table.get(key);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) { done(entry(read.result).command); return; }
            const count = table.index('caller').count(caller);
            count.onsuccess = () => {
              try {
                if (count.result >= 256) throw new Error('Reconcile pending commands before starting more');
                const command = parseRunCommandV1({ ...intent, requestId: (options.uuid ?? (() => crypto.randomUUID()))() });
                table.add({ key, caller, command, receipt: null } satisfies Entry); done(command);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      }, 'readwrite', signal);
    },
    record(value) {
      const receipt = parseRunCommandReceiptV1(value);
      return transaction<RunCommandReceiptV1>((table, done, fail) => {
        const read = table.index('request').get([caller, receipt.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result); parseRunCommandReceiptV1(receipt, saved.command);
              if (saved.receipt?.runId != null && (receipt.runId !== null || receipt.status !== 'rejected')
                && (saved.receipt.runId !== receipt.runId || saved.receipt.attempt !== receipt.attempt)) {
                throw new RunCommandJournalValidationError('Command receipt execution identity changed');
              }
              if (saved.receipt?.status === 'recovery-required' && receipt.status === 'rejected') {
                throw new RunCommandJournalValidationError('Uncertain command cannot become rejected');
              }
              if (saved.receipt?.status === 'accepted' || saved.receipt?.status === 'rejected') {
                if (receipt.status === 'accepted' || receipt.status === 'rejected') {
                  if (JSON.stringify(saved.receipt) !== JSON.stringify(receipt)) throw new RunCommandJournalValidationError('Definite command receipt changed');
                }
                done(saved.receipt); return;
              } else if (saved.receipt?.status === 'recovery-required' && receipt.status === 'pending') {
                done(saved.receipt); return;
              } else table.put({ ...saved, receipt });
            }
            done(receipt);
          } catch (error) { fail(error); }
        };
      }, 'readwrite');
    },
    acknowledge(value) {
      const query = parseRunCommandReceiptQueryV1(value);
      return transaction<void>((table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result);
              if (saved.command.repo !== query.repo || !saved.receipt || !['accepted', 'rejected'].includes(saved.receipt.status)) throw new TypeError('Only definite matching receipts can be acknowledged');
              table.delete(saved.key);
            }
            done();
          } catch (error) { fail(error); }
        };
      }, 'readwrite');
    },
    pending() {
      return transaction<readonly RunCommandPendingV1[]>((table, done, fail) => {
        const read = table.index('caller').getAll(caller, 257);
        read.onsuccess = () => {
          try {
            if (read.result.length > 256) throw new Error('Too many pending commands');
            done(Object.freeze(read.result.map(value => { const saved = entry(value); return Object.freeze({ command: saved.command, receipt: saved.receipt }); })));
          } catch (error) { fail(error); }
        };
      }, 'readonly');
    },
  };
}
