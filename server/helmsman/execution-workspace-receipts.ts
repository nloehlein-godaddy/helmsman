import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export function openExecutionWorkspaceReceipts(persistence: Persistence) {
  const sql = persistence.sql;
  const ddl = 'CREATE TABLE execution_workspace_receipts (runId TEXT NOT NULL,path TEXT NOT NULL,contentHash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(runId,path))';
  migrateOwned(sql, { owner: 'core.execution-workspaces', version: 1, checksum: persistenceHash(ddl), tables: ['execution_workspace_receipts'],
    validateLegacy: () => null, apply: () => sql.exec(ddl), validateCurrent: () => {
      validateTableColumns(sql, 'execution_workspace_receipts', ['runId', 'path', 'contentHash', 'json']);
      const row = sql.prepare("SELECT sql FROM sqlite_master WHERE name='execution_workspace_receipts'").get() as { sql: string } | undefined;
      if (row?.sql.replace(/\s+/g, '') !== ddl.replace(/\s+/g, '')) throw new PersistenceValidationError('Invalid workspace receipt schema');
    } });
  function get(runId: string, path: string): unknown | null {
    const row = sql.prepare('SELECT contentHash,json FROM execution_workspace_receipts WHERE runId=? AND path=?').get(runId, path) as { contentHash: string; json: string } | undefined;
    if (!row) return null;
    const value = persistedJson(JSON.parse(row.json));
    if (persistenceHash(value) !== row.contentHash) throw new PersistenceValidationError('Execution workspace receipt integrity failed');
    return value;
  }
  for (const row of sql.prepare('SELECT runId,path FROM execution_workspace_receipts').all() as { runId: string; path: string }[]) get(row.runId, row.path);
  return { get,
    record(runId: string, path: string, identity: unknown): void {
      const value = persistedJson(identity);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistenceValidationError('Execution workspace identity is required');
      persistence.transaction(() => {
        if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_footprints'").get()) {
          const owner = sql.prepare("SELECT state FROM execution_footprints WHERE runId=?").get(runId) as { state: string } | undefined;
          if (owner?.state !== 'held') throw new PersistenceConflictError('Execution no longer owns workspace preparation');
        } else if (!sql.prepare('SELECT 1 FROM execution_reservations WHERE runId=?').get(runId)) throw new PersistenceConflictError('Execution no longer reserves workspace preparation');
        const previous = get(runId, path);
        if (previous && persistenceHash(previous) !== persistenceHash(value)) throw new PersistenceConflictError('Execution workspace allocation identity changed');
        if (!previous) sql.prepare('INSERT INTO execution_workspace_receipts VALUES (?,?,?,?)').run(runId, path, persistenceHash(value), stableJson(value));
      });
    },
  };
}
