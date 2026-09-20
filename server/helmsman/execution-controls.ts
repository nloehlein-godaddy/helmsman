import type { AttemptKey } from './execution-store';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceValidationError, type Persistence } from './persistence';

export interface ExecutionControls {
  requestStop(attempt: AttemptKey): void;
  isStopRequested(attempt: AttemptKey): boolean;
}
const DDL = `CREATE TABLE execution_controls (
  runId TEXT NOT NULL,attempt INTEGER NOT NULL,action TEXT NOT NULL,createdAt TEXT NOT NULL,
  PRIMARY KEY(runId,attempt,action)
)`;
function validate(value: AttemptKey): void {
  if (typeof value?.runId !== 'string' || !/^[a-z\d][a-z\d_.:/@-]{0,255}$/i.test(value.runId)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new PersistenceValidationError('Invalid execution control identity');
}

export function openExecutionControls(persistence: Persistence): ExecutionControls {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.execution-controls', version: 1, checksum: persistenceHash(DDL), tables: ['execution_controls'],
    validateLegacy: () => null, apply: () => { sql.exec(DDL); },
    validateCurrent: () => validateTableColumns(sql, 'execution_controls', ['runId', 'attempt', 'action', 'createdAt']) });
  return {
    requestStop(attempt) {
      validate(attempt);
      persistence.transaction(() => {
        sql.prepare("INSERT INTO execution_controls VALUES(?,?,'stop',?) ON CONFLICT(runId,attempt,action) DO NOTHING")
          .run(attempt.runId, attempt.attempt, new Date().toISOString());
      });
    },
    isStopRequested(attempt) {
      validate(attempt);
      return Boolean(sql.prepare("SELECT 1 FROM execution_controls WHERE runId=? AND attempt=? AND action='stop'").get(attempt.runId, attempt.attempt));
    },
  };
}
