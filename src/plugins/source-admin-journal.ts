import { SOURCE_ADMIN_LIMITS } from './source-admin';
import { isContributionId } from './manifest';
import { parseSourceAdminInputV1, parseSourceAdminReceiptQueryV1, parseSourceAdminReceiptV1, parseSourceAdminCommandV1 } from './source-admin';
import type { SourceAdminInputV1, SourceAdminPendingV1, SourceAdminReceiptQueryV1, SourceAdminReceiptV1, SourceAdminCommandV1 } from './source-admin';

interface Entry extends SourceAdminPendingV1 { readonly key: string; readonly caller: string; }
export class SourceAdminJournalValidationError extends Error {}
export interface SourceAdminJournal {
  reserve(input: SourceAdminInputV1, signal?: AbortSignal): Promise<SourceAdminCommandV1>;
  retained(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<SourceAdminCommandV1 | null>;
  record(receipt: SourceAdminReceiptV1): Promise<SourceAdminReceiptV1>;
  acknowledge(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<void>;
  pending(): Promise<readonly SourceAdminPendingV1[]>;
}

export function createSourceAdminJournal(caller: string, options: { indexedDB?: IDBFactory; databaseName?: string; uuid?: () => string } = {}): SourceAdminJournal {
  if (!isContributionId(caller)) throw new TypeError('Invalid command contribution');
  async function transaction<T>(execute: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
    mode: IDBTransactionMode, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('Durable command storage is unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? 'helmsman.source-admin', 1);
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
    if (!value || typeof value !== 'object') throw new SourceAdminJournalValidationError('Invalid saved command');
    const data = value as Partial<Entry>;
    const command = parseSourceAdminCommandV1(data.command);
    const { requestId: _requestId, ...input } = command;
    const key = JSON.stringify([caller, parseSourceAdminInputV1(input)]);
    if (data.caller !== caller || data.key !== key) throw new SourceAdminJournalValidationError('Saved command identity changed');
    return { caller, key, command, receipt: data.receipt === null ? null : parseSourceAdminReceiptV1(data.receipt, command) };
  }
  return {
    retained(value, signal) {
      const query = parseSourceAdminReceiptQueryV1(value);
      return transaction<SourceAdminCommandV1 | null>((table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result === undefined) { done(null); return; }
            const saved = entry(read.result);
            done(saved.command.repo === query.repo ? saved.command : null);
          } catch (error) { fail(error); }
        };
      }, 'readonly', signal);
    },
    reserve(input, signal) {
      const intent = parseSourceAdminInputV1(input); const key = JSON.stringify([caller, intent]);
      return transaction<SourceAdminCommandV1>((table, done, fail) => {
        const read = table.get(key);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) { done(entry(read.result).command); return; }
            const count = table.index('caller').getAll(caller, SOURCE_ADMIN_LIMITS.pending + 1);
            count.onsuccess = () => {
              try {
                if (count.result.length >= SOURCE_ADMIN_LIMITS.pending) throw new Error('Reconcile pending commands before starting more');
                const command = parseSourceAdminCommandV1({ ...intent, requestId: (options.uuid ?? (() => crypto.randomUUID()))() });
                const next = { key, caller, command, receipt: null } satisfies Entry;
                if (new TextEncoder().encode(JSON.stringify([...count.result, next])).byteLength > SOURCE_ADMIN_LIMITS.aggregateBytes) throw new Error('Reconcile pending source commands before saving more');
                table.add(next); done(command);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      }, 'readwrite', signal);
    },
    record(value) {
      const receipt = parseSourceAdminReceiptV1(value);
      return transaction<SourceAdminReceiptV1>((table, done, fail) => {
        const read = table.index('request').get([caller, receipt.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result); parseSourceAdminReceiptV1(receipt, saved.command);
              if (saved.receipt) {
                if (saved.receipt.status !== 'expired' && receipt.status === 'expired') { done(saved.receipt); return; }
                if (JSON.stringify(saved.receipt) !== JSON.stringify(receipt)) throw new SourceAdminJournalValidationError('Definite administration receipt changed');
                done(saved.receipt); return;
              }
              table.put({ ...saved, receipt });
            }
            done(receipt);
          } catch (error) { fail(error); }
        };
      }, 'readwrite');
    },
    acknowledge(value, signal) {
      const query = parseSourceAdminReceiptQueryV1(value);
      return transaction<void>((table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result);
              if (saved.command.repo !== query.repo || !saved.receipt || !['succeeded', 'rejected', 'expired'].includes(saved.receipt.status)) throw new TypeError('Only definite matching receipts can be acknowledged');
              table.delete(saved.key);
            }
            done();
          } catch (error) { fail(error); }
        };
      }, 'readwrite', signal);
    },
    pending() {
      return transaction<readonly SourceAdminPendingV1[]>((table, done, fail) => {
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
