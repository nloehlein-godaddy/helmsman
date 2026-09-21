import { parseClarificationCommandReceiptV1, type ClarificationCommandReceiptV1 } from '../../src/plugins/clarification-command';
import { parseSuggestedContactAdminReceiptV1, type SuggestedContactAdminReceiptV1 } from '../../src/plugins/suggested-contact-admin';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';
import { validateRunCommandCaller } from './run-command-store';

export interface ClarificationReceiptStore {
  readonly persistence: Persistence;
  answer(caller: string, requestId: string): ClarificationCommandReceiptV1 | null;
  saveAnswer(caller: string, receipt: ClarificationCommandReceiptV1): ClarificationCommandReceiptV1;
  contact(caller: string, requestId: string): SuggestedContactAdminReceiptV1 | null;
  saveContact(caller: string, receipt: SuggestedContactAdminReceiptV1): SuggestedContactAdminReceiptV1;
}
const DDL = `CREATE TABLE public_clarification_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(caller,requestId)
);
CREATE TABLE public_suggested_contact_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(caller,requestId)
);
CREATE INDEX public_clarification_listing ON clarifications(repo,createdAt DESC,id DESC);
CREATE INDEX public_suggested_contact_listing ON trusted_contacts(createdAt DESC,id DESC)`;
type Receipt = ClarificationCommandReceiptV1 | SuggestedContactAdminReceiptV1;
type Table = 'public_clarification_receipts' | 'public_suggested_contact_receipts';
export function openClarificationReceiptStore(persistence: Persistence): ClarificationReceiptStore {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.public-clarification-receipts', version: 1, checksum: persistenceHash(DDL),
    tables: ['public_clarification_receipts', 'public_suggested_contact_receipts'], validateLegacy: () => null,
    apply: () => sql.exec(DDL), validateCurrent() {
      for (const table of ['public_clarification_receipts', 'public_suggested_contact_receipts']) validateTableColumns(sql, table, ['caller', 'requestId', 'hash', 'json']);
      for (const name of ['public_clarification_listing', 'public_suggested_contact_listing']) {
        if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name)) throw new PersistenceValidationError('Clarification listing index is unavailable');
      }
    } });
  function get<T extends Receipt>(table: Table, caller: string, requestId: string, parse: (value: unknown) => T): T | null {
    validateRunCommandCaller(caller);
    const row = sql.prepare(`SELECT hash,json FROM ${table} WHERE caller=? AND requestId=?`).get(caller, requestId) as { hash: string; json: string } | undefined;
    if (!row) return null;
    const receipt = parse(JSON.parse(row.json));
    if (receipt.requestId !== requestId || row.hash !== persistenceHash({ caller, receipt })) throw new PersistenceValidationError('Clarification receipt integrity failed');
    return receipt;
  }
  function save<T extends Receipt>(table: Table, caller: string, input: T, parse: (value: unknown) => T): T {
    if (!sql.inTransaction) throw new PersistenceConflictError('Clarification receipts require the mutation transaction');
    validateRunCommandCaller(caller); const receipt = parse(input); const previous = get(table, caller, receipt.requestId, parse);
    if (previous) {
      if (stableJson(previous) !== stableJson(receipt)) throw new PersistenceConflictError('Clarification receipt is immutable');
      return previous;
    }
    sql.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(caller, receipt.requestId, persistenceHash({ caller, receipt }), stableJson(receipt));
    return get(table, caller, receipt.requestId, parse)!;
  }
  return {
    persistence,
    answer: (caller, requestId) => get('public_clarification_receipts', caller, requestId, parseClarificationCommandReceiptV1),
    saveAnswer: (caller, receipt) => save('public_clarification_receipts', caller, receipt, parseClarificationCommandReceiptV1),
    contact: (caller, requestId) => get('public_suggested_contact_receipts', caller, requestId, parseSuggestedContactAdminReceiptV1),
    saveContact: (caller, receipt) => save('public_suggested_contact_receipts', caller, receipt, parseSuggestedContactAdminReceiptV1),
  };
}
