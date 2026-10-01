import { parseRunInstructionReceiptV1, type RunInstructionReceiptV1 } from '../../src/plugins/run-instructions';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';
import { validateRunCommandCaller } from './run-command-store';

const DDL = `CREATE TABLE public_run_instruction_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, deliveryId TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY(caller,requestId)
)`;
export function openRunInstructionStore(persistence: Persistence) {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.public-run-instructions', version: 1, checksum: persistenceHash(DDL),
    tables: ['public_run_instruction_receipts'], validateLegacy: () => null, apply: () => sql.exec(DDL),
    validateCurrent: () => validateTableColumns(sql, 'public_run_instruction_receipts', ['caller', 'requestId', 'deliveryId', 'hash', 'json']) });
  function read(caller: string, requestId: string) {
    validateRunCommandCaller(caller);
    const row = sql.prepare('SELECT * FROM public_run_instruction_receipts WHERE caller=? AND requestId=?').get(caller, requestId) as { caller: string; requestId: string; deliveryId: string; hash: string; json: string } | undefined;
    if (!row) return null;
    const receipt = parseRunInstructionReceiptV1(JSON.parse(row.json));
    if (receipt.requestId !== requestId || row.hash !== persistenceHash({ caller, deliveryId: row.deliveryId, receipt })) throw new PersistenceValidationError('Instruction receipt integrity failed');
    return { deliveryId: row.deliveryId, receipt };
  }
  return { read, save(caller: string, deliveryId: string, raw: RunInstructionReceiptV1) {
    if (!sql.inTransaction) throw new PersistenceConflictError('Instruction receipt requires a transaction');
    validateRunCommandCaller(caller);
    const receipt = parseRunInstructionReceiptV1(raw); const previous = read(caller, receipt.requestId);
    if (previous && (previous.deliveryId !== deliveryId || stableJson(previous.receipt.input) !== stableJson(receipt.input))) throw new PersistenceConflictError('Instruction request content changed');
    if (previous && ['delivered', 'failed', 'rejected'].includes(previous.receipt.status) && stableJson(previous.receipt) !== stableJson(receipt)) throw new PersistenceConflictError('Terminal instruction receipt changed');
    sql.prepare('INSERT INTO public_run_instruction_receipts VALUES(?,?,?,?,?) ON CONFLICT(caller,requestId) DO UPDATE SET hash=excluded.hash,json=excluded.json')
      .run(caller, receipt.requestId, deliveryId, persistenceHash({ caller, deliveryId, receipt }), stableJson(receipt));
    return receipt;
  } };
}
