import { isContributionId } from './manifest';
import { clarificationJson } from './clarification-validation';

export class ClarificationJournalConflictError extends Error {}
export class ClarificationJournalValidationError extends Error {}
export interface ClarificationJournalOptions { indexedDB?: IDBFactory; databaseName?: string; uuid?: () => string; }
export interface ClarificationJournal<Input, Command, Receipt, Query> {
  reserve(input: Input, signal?: AbortSignal): Promise<Command>;
  retained(query: Query, signal?: AbortSignal): Promise<Command | null>;
  record(receipt: Receipt): Promise<Receipt>;
  acknowledge(query: Query, signal?: AbortSignal): Promise<void>;
  pending(signal?: AbortSignal): Promise<readonly { readonly command: Command; readonly receipt: Receipt | null }[]>;
}
interface Entry<Command, Receipt> { readonly key: string; readonly caller: string; readonly command: Command; readonly receipt: Receipt | null; }
const equal = (left: unknown, right: unknown) => JSON.stringify(clarificationJson(left, 8 * 1024 * 1024)) === JSON.stringify(clarificationJson(right, 8 * 1024 * 1024));

export function createClarificationJournal<Input, Command extends { readonly requestId: string }, Receipt extends { readonly requestId: string }, Query extends { readonly requestId: string }>(caller: string, options: ClarificationJournalOptions, contract: {
  database: string; parseInput(value: unknown): Input; parseCommand(value: unknown): Command; parseReceipt(value: unknown, command?: Command): Receipt; parseQuery(value: unknown): Query;
  terminal?(receipt: Receipt): boolean;
  key(input: Input): readonly unknown[]; input(command: Command): Input; create(input: Input, uuid: () => string): Command; matches(command: Command, query: Query): boolean;
}): ClarificationJournal<Input, Command, Receipt, Query> {
  if (!isContributionId(caller)) throw new TypeError('Invalid command contribution');
  const limit = 256; const maximum = 8 * 1024 * 1024;
  const terminal = contract.terminal ?? (() => true);
  const key = (input: Input) => JSON.stringify([caller, ...contract.key(input)]);
  function entry(value: unknown): Entry<Command, Receipt> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClarificationJournalValidationError('Invalid saved command');
    const data = value as Partial<Entry<Command, Receipt>>; const command = contract.parseCommand(data.command);
    if (data.caller !== caller || data.key !== key(contract.input(command))) throw new ClarificationJournalValidationError('Saved command identity changed');
    return { key: data.key, caller, command, receipt: data.receipt === null ? null : contract.parseReceipt(data.receipt, command) };
  }
  function bounded(entries: readonly unknown[]): void {
    if (entries.length > limit || new TextEncoder().encode(JSON.stringify(entries)).byteLength > maximum) throw new Error('Reconcile pending commands before saving more');
  }
  async function transaction<T>(mode: IDBTransactionMode, signal: AbortSignal | undefined,
    execute: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    signal?.throwIfAborted(); const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('Durable command storage is unavailable');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? contract.database, 1); let rejected = false;
      const cancel = () => { rejected = true; reject(signal?.reason ?? new DOMException('Command cancelled', 'AbortError')); };
      signal?.addEventListener('abort', cancel, { once: true });
      request.onupgradeneeded = () => {
        const table = request.result.createObjectStore('pending', { keyPath: 'key' });
        table.createIndex('caller', 'caller'); table.createIndex('request', ['caller', 'command.requestId'], { unique: true });
      };
      request.onerror = () => { signal?.removeEventListener('abort', cancel); reject(request.error ?? new Error('Command storage unavailable')); };
      request.onblocked = () => { signal?.removeEventListener('abort', cancel); rejected = true; reject(new Error('Command storage is blocked')); };
      request.onsuccess = () => { signal?.removeEventListener('abort', cancel); if (rejected) request.result.close(); else resolve(request.result); };
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        signal?.throwIfAborted(); const tx = database.transaction('pending', mode); let result: T; let failure: unknown;
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
  return {
    retained(value, signal) {
      const query = contract.parseQuery(value);
      return transaction<Command | null>('readonly', signal, (table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result === undefined) { done(null); return; }
            const saved = entry(read.result);
            done(contract.matches(saved.command, query) ? saved.command : null);
          } catch (error) { fail(error); }
        };
      });
    },
    reserve(value, signal) {
      const input = contract.parseInput(value); const identity = key(input);
      return transaction<Command>('readwrite', signal, (table, done, fail) => {
        const read = table.get(identity);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result);
              if (!equal(contract.input(saved.command), input)) throw new ClarificationJournalConflictError('Resolve the original command before submitting changed input');
              done(saved.command); return;
            }
            const all = table.index('caller').getAll(caller, limit + 1);
            all.onsuccess = () => {
              try {
                const command = contract.create(input, options.uuid ?? (() => crypto.randomUUID()));
                const next: Entry<Command, Receipt> = { caller, key: identity, command, receipt: null };
                bounded([...all.result, next]); table.add(next); done(command);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      });
    },
    record(value) {
      const receipt = contract.parseReceipt(value);
      return transaction<Receipt>('readwrite', undefined, (table, done, fail) => {
        const read = table.index('request').get([caller, receipt.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result === undefined) { done(receipt); return; }
            const saved = entry(read.result); contract.parseReceipt(receipt, saved.command);
            if (saved.receipt && terminal(saved.receipt)) {
              if (!terminal(receipt)) { done(saved.receipt); return; }
              if (!equal(saved.receipt, receipt)) throw new ClarificationJournalValidationError('Recorded terminal receipt changed');
              done(saved.receipt); return;
            }
            const all = table.index('caller').getAll(caller, limit + 1);
            all.onsuccess = () => {
              try {
                const next = { ...saved, receipt }; bounded(all.result.map(value => value?.key === saved.key ? next : value));
                table.put(next); done(receipt);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      });
    },
    acknowledge(value, signal) {
      const query = contract.parseQuery(value);
      return transaction<void>('readwrite', signal, (table, done, fail) => {
        const read = table.index('request').get([caller, query.requestId]);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) {
              const saved = entry(read.result);
              if (!saved.receipt || !terminal(saved.receipt) || !contract.matches(saved.command, query)) throw new ClarificationJournalValidationError('Only matching recorded terminal receipts can be acknowledged');
              table.delete(saved.key);
            }
            done();
          } catch (error) { fail(error); }
        };
      });
    },
    pending(signal) {
      return transaction('readonly', signal, (table, done, fail) => {
        const read = table.index('caller').getAll(caller, limit + 1);
        read.onsuccess = () => {
          try { bounded(read.result); done(Object.freeze(read.result.map(value => { const saved = entry(value); return Object.freeze({ command: saved.command, receipt: saved.receipt }); }))); }
          catch (error) { fail(error); }
        };
      });
    },
  };
}
