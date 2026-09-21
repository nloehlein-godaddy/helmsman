import { SOURCE_COMMAND_LIMITS } from './source-command';
import { isContributionId } from './manifest';
import { parseSourceCommandInputV1, parseSourceCommandReceiptQueryV1, parseSourceCommandReceiptV1, parseSourceCommandV1 } from './source-command';
import type { SourceCommandInputV1, SourceCommandPendingV1, SourceCommandReceiptQueryV1, SourceCommandReceiptV1, SourceCommandV1 } from './source-command';

interface Entry extends SourceCommandPendingV1 { readonly key: string; readonly caller: string; }
export class SourceCommandJournalValidationError extends Error {}
export interface SourceCommandJournal {
  reserve(input: SourceCommandInputV1, signal?: AbortSignal): Promise<SourceCommandV1>;
  retained(query: SourceCommandReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandV1 | null>;
  record(receipt: SourceCommandReceiptV1): Promise<SourceCommandReceiptV1>;
  acknowledge(query: SourceCommandReceiptQueryV1): Promise<void>;
  pending(): Promise<readonly SourceCommandPendingV1[]>;
}

export function createSourceCommandJournal(caller: string, options: { indexedDB?: IDBFactory; databaseName?: string; uuid?: () => string } = {}): SourceCommandJournal {
  if (!isContributionId(caller)) throw new TypeError('Invalid command contribution');
  async function transaction<T>(execute: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
    mode: IDBTransactionMode, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('Durable command storage is unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? 'helmsman.source-commands', 1);
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
    if (!value || typeof value !== 'object') throw new SourceCommandJournalValidationError('Invalid saved command');
    const data = value as Partial<Entry>;
    const command = parseSourceCommandV1(data.command);
    const { requestId: _requestId, ...input } = command;
    const key = JSON.stringify([caller, parseSourceCommandInputV1(input)]);
    if (data.caller !== caller || data.key !== key) throw new SourceCommandJournalValidationError('Saved command identity changed');
    return { caller, key, command, receipt: data.receipt === null ? null : parseSourceCommandReceiptV1(data.receipt, command) };
  }
  return {
    retained(value, signal) {
      const query = parseSourceCommandReceiptQueryV1(value);
      return transaction<SourceCommandV1 | null>((table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result === undefined) { done(null); return; }
            const saved = entry(read.result);
            done(saved.command.selection.repo === query.repo ? saved.command : null);
          } catch (error) { fail(error); }
        };
      }, 'readonly', signal);
    },
    reserve(input, signal) {
      const intent = parseSourceCommandInputV1(input); const key = JSON.stringify([caller, intent]);
      return transaction<SourceCommandV1>((table, done, fail) => {
        const read = table.get(key);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) { done(entry(read.result).command); return; }
            const count = table.index('caller').getAll(caller, SOURCE_COMMAND_LIMITS.pending + 1);
            count.onsuccess = () => {
              try {
                if (count.result.length >= SOURCE_COMMAND_LIMITS.pending) throw new Error('Reconcile pending commands before starting more');
                const command = parseSourceCommandV1({ ...intent, requestId: (options.uuid ?? (() => crypto.randomUUID()))() });
                const next = { key, caller, command, receipt: null } satisfies Entry;
                if (new TextEncoder().encode(JSON.stringify([...count.result, next])).byteLength > SOURCE_COMMAND_LIMITS.aggregateBytes) throw new Error('Reconcile pending source commands before saving more');
                table.add(next); done(command);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      }, 'readwrite', signal);
    },
    record(value) {
      const receipt = parseSourceCommandReceiptV1(value);
      return transaction<SourceCommandReceiptV1>((table, done, fail) => {
        const read = table.index('request').get([caller, receipt.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result); parseSourceCommandReceiptV1(receipt, saved.command);
              if (saved.receipt?.status === 'recovery-required' && receipt.status === 'rejected' && !receipt.resolution) {
                throw new SourceCommandJournalValidationError('Uncertain command cannot become rejected');
              }
              if (saved.receipt?.status === 'succeeded' || saved.receipt?.status === 'rejected') {
                if (receipt.status === 'succeeded' || receipt.status === 'rejected') {
                  if (JSON.stringify(saved.receipt) !== JSON.stringify(receipt)) throw new SourceCommandJournalValidationError('Definite command receipt changed');
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
      const query = parseSourceCommandReceiptQueryV1(value);
      return transaction<void>((table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result);
              if (saved.command.selection.repo !== query.repo || !saved.receipt || !['succeeded', 'rejected'].includes(saved.receipt.status)) throw new TypeError('Only definite matching receipts can be acknowledged');
              table.delete(saved.key);
            }
            done();
          } catch (error) { fail(error); }
        };
      }, 'readwrite');
    },
    pending() {
      return transaction<readonly SourceCommandPendingV1[]>((table, done, fail) => {
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
