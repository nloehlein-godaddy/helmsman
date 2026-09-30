import { sourceJson } from './source-contract-validation';
import { isContributionId } from './manifest';
import { SOURCE_REMOTE_ACTION_LIMITS as LIMITS, parseSourceRemoteActionInputV1, parseSourceRemoteActionReceiptQueryV1, parseSourceRemoteActionReceiptV1, parseSourceRemoteActionCommandV1 } from './task-actions';
import type { SourceRemoteActionInputV1, SourceRemoteActionPendingV1, SourceRemoteActionReceiptQueryV1, SourceRemoteActionReceiptV1, SourceRemoteActionCommandV1 } from './task-actions';

interface Entry extends SourceRemoteActionPendingV1 { readonly key: string; readonly caller: string; }
export class TaskActionJournalValidationError extends Error {}
export class TaskActionJournalConflictError extends Error {}
export interface TaskActionJournal {
  reserve(input: SourceRemoteActionInputV1, signal?: AbortSignal): Promise<SourceRemoteActionCommandV1>;
  retained(query: SourceRemoteActionReceiptQueryV1, signal?: AbortSignal): Promise<SourceRemoteActionCommandV1 | null>;
  record(receipt: SourceRemoteActionReceiptV1): Promise<SourceRemoteActionReceiptV1>;
  acknowledge(query: SourceRemoteActionReceiptQueryV1, signal?: AbortSignal): Promise<void>;
  pending(signal?: AbortSignal): Promise<readonly SourceRemoteActionPendingV1[]>;
}

export function createTaskActionJournal(caller: string, options: { indexedDB?: IDBFactory; databaseName?: string; uuid?: () => string } = {}): TaskActionJournal {
  if (!isContributionId(caller)) throw new TypeError('Invalid command contribution');
  const identity = (input: SourceRemoteActionInputV1) => JSON.stringify([caller, input.selection.repo, input.target.ref.sourceId, input.target.ref.externalId, input.action]);
  async function transaction<T>(execute: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
    mode: IDBTransactionMode, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('Durable command storage is unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? 'helmsman.task-actions', 1);
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
    if (!value || typeof value !== 'object') throw new TaskActionJournalValidationError('Invalid saved command');
    const data = value as Partial<Entry>;
    const command = parseSourceRemoteActionCommandV1(data.command);
    const { requestId: _requestId, ...input } = command;
    const key = identity(parseSourceRemoteActionInputV1(input));
    if (data.caller !== caller || data.key !== key) throw new TaskActionJournalValidationError('Saved command identity changed');
    return { caller, key, command, receipt: data.receipt === null ? null : parseSourceRemoteActionReceiptV1(data.receipt, command) };
  }
  return {
    retained(value, signal) {
      const query = parseSourceRemoteActionReceiptQueryV1(value);
      return transaction<SourceRemoteActionCommandV1 | null>((table, done, fail) => {
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
      const intent = parseSourceRemoteActionInputV1(input); const key = identity(intent);
      return transaction<SourceRemoteActionCommandV1>((table, done, fail) => {
        const read = table.get(key);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result).command; const { requestId: _requestId, ...original } = saved;
              if (JSON.stringify(sourceJson(original)) !== JSON.stringify(sourceJson(intent))) throw new TaskActionJournalConflictError('Resolve the original assignment before submitting changed input');
              done(saved); return;
            }
            const count = table.index('caller').getAll(caller, LIMITS.pending + 1);
            count.onsuccess = () => {
              try {
                if (count.result.length >= LIMITS.pending) throw new Error('Reconcile pending commands before starting more');
                const command = parseSourceRemoteActionCommandV1({ ...intent, requestId: (options.uuid ?? (() => crypto.randomUUID()))() });
                const next = { key, caller, command, receipt: null } satisfies Entry;
                if (new TextEncoder().encode(JSON.stringify([...count.result, next])).byteLength > LIMITS.aggregateBytes) throw new Error('Reconcile pending source commands before saving more');
                table.add(next); done(command);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      }, 'readwrite', signal);
    },
    record(value) {
      const receipt = parseSourceRemoteActionReceiptV1(value);
      return transaction<SourceRemoteActionReceiptV1>((table, done, fail) => {
        const read = table.index('request').get([caller, receipt.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result); parseSourceRemoteActionReceiptV1(receipt, saved.command);
              if (saved.receipt?.status === 'recovery-required' && receipt.status === 'rejected' && !receipt.resolution) {
                throw new TaskActionJournalValidationError('Uncertain command cannot become rejected');
              }
              if (saved.receipt?.status === 'succeeded' || saved.receipt?.status === 'rejected') {
                if (receipt.status === 'succeeded' || receipt.status === 'rejected') {
                  if (JSON.stringify(saved.receipt) !== JSON.stringify(receipt)) throw new TaskActionJournalValidationError('Definite command receipt changed');
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
    acknowledge(value, signal) {
      const query = parseSourceRemoteActionReceiptQueryV1(value);
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
      }, 'readwrite', signal);
    },
    pending(signal) {
      return transaction<readonly SourceRemoteActionPendingV1[]>((table, done, fail) => {
        const read = table.index('caller').getAll(caller, LIMITS.pending + 1);
        read.onsuccess = () => {
          try {
            if (read.result.length > LIMITS.pending) throw new Error('Too many pending commands');
            done(Object.freeze(read.result.map(value => { const saved = entry(value); return Object.freeze({ command: saved.command, receipt: saved.receipt }); })));
          } catch (error) { fail(error); }
        };
      }, 'readonly', signal);
    },
  };
}
