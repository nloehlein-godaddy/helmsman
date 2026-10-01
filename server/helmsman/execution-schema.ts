import { lstatSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { exclusiveExecutionFootprint } from './execution-footprint';
import { migrateOwned, retainedSchemaConsumers, schemaVersion, validateTableColumns, type RetainedSchemaConsumer } from './migrations';
import { persistenceHash, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface ExecutionMigrationReadiness {
  currentVersion: 1 | 2;
  targetVersion: 2;
  ready: boolean;
  blockers: readonly RetainedSchemaConsumer[];
}

export const EXECUTION_OWNERSHIP_DDL = `
  CREATE TABLE execution_footprints (
    runId TEXT PRIMARY KEY, repo TEXT NOT NULL COLLATE NOCASE, contentHash TEXT NOT NULL, json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('held','cleanup-pending','released')), cleanupToken TEXT
  );
  CREATE TABLE execution_resource_claims (
    kind TEXT NOT NULL, namespace TEXT NOT NULL, identity TEXT NOT NULL, runId TEXT NOT NULL,
    PRIMARY KEY(kind,namespace,identity), FOREIGN KEY(runId) REFERENCES execution_footprints(runId)
  );
  CREATE INDEX execution_resource_claims_run ON execution_resource_claims(runId);
  CREATE INDEX execution_footprints_repo ON execution_footprints(repo);
`;

const RESERVATIONS_V2 = 'CREATE TABLE execution_reservations (runId TEXT PRIMARY KEY,repo TEXT NOT NULL COLLATE NOCASE,reason TEXT NOT NULL)';
const RESERVATIONS_INDEX = 'CREATE INDEX execution_reservations_repo ON execution_reservations(repo)';
const additionalTables = {
  execution_footprints: ['runId', 'repo', 'contentHash', 'json', 'state', 'cleanupToken'],
  execution_resource_claims: ['kind', 'namespace', 'identity', 'runId'],
};
const workspaceExists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'; }
};
const normalized = (value: string): string => value.replace(/\s+/g, '').replace(/;$/, '');

export function executionMigrationReadiness(sql: Database.Database): ExecutionMigrationReadiness {
  const currentVersion = schemaVersion(sql, 'core.execution');
  if (currentVersion !== 1 && currentVersion !== 2) throw new PersistenceValidationError('Unsupported execution schema');
  const blockers = retainedSchemaConsumers(sql).filter(consumer => consumer.range.owner === 'core.execution'
    && (consumer.range.minimum > 2 || consumer.range.maximum < 2));
  if (currentVersion === 1 && sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_attempts'").get()) {
    for (const row of sql.prepare('SELECT a.runId,a.json AS attempt,s.id,s.json AS snapshot FROM execution_attempts a JOIN execution_snapshots s ON s.id=a.snapshotId').all() as { runId: string; attempt: string; id: string; snapshot: string }[]) {
      const attempt = JSON.parse(row.attempt) as { paths?: { worktree?: string | null } } | null;
      const snapshot = JSON.parse(row.snapshot) as { schemas?: { owner: string; minimum: number; maximum: number }[] } | null;
      const range = snapshot && Array.isArray(snapshot.schemas) ? snapshot.schemas.find(value => value?.owner === 'core.execution') : undefined;
      if (typeof attempt?.paths?.worktree === 'string' && workspaceExists(attempt.paths.worktree) && range && range.maximum < 2
        && !blockers.some(consumer => consumer.source === 'execution-snapshot' && consumer.identity === row.id)) {
        blockers.push({ source: 'execution-snapshot', identity: row.id, range });
      }
    }
  }
  return { currentVersion, targetVersion: 2, ready: blockers.length === 0, blockers };
}

function validateDefinition(sql: Database.Database, name: string, expected: string): void {
  const row = sql.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
  if (!row?.sql || normalized(row.sql) !== normalized(expected)) throw new PersistenceValidationError(`Invalid execution ownership schema: ${name}`);
}

export function openExecutionSchema(persistence: Persistence, legacy: { ddl: string; tables: Record<string, readonly string[]>; validateEvidence(): void }, preferVersion: 1 | 2): 1 | 2 {
  const sql = persistence.sql;
  const metadata = sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_ledger'").get();
  const current = metadata ? schemaVersion(sql, 'core.execution') : null;
  const validateLegacy = () => {
    for (const [table, columns] of Object.entries(legacy.tables)) validateTableColumns(sql, table, columns);
    validateDefinition(sql, 'execution_reservations', 'CREATE TABLE execution_reservations (runId TEXT PRIMARY KEY,repo TEXT NOT NULL COLLATE NOCASE UNIQUE,reason TEXT NOT NULL)');
  };
  if (current !== 2) {
    migrateOwned(sql, { owner: 'core.execution', version: 1, checksum: persistenceHash(legacy.ddl), tables: Object.keys(legacy.tables),
      validateLegacy: () => null, apply: () => sql.exec(legacy.ddl), validateCurrent: validateLegacy });
    if (preferVersion === 1 || !executionMigrationReadiness(sql).ready) return 1;
  }
  const ddl = legacy.ddl.replace('repo TEXT NOT NULL COLLATE NOCASE UNIQUE,reason', 'repo TEXT NOT NULL COLLATE NOCASE,reason')
    + RESERVATIONS_INDEX + ';' + EXECUTION_OWNERSHIP_DDL;
  migrateOwned(sql, { owner: 'core.execution', version: 2, checksum: persistenceHash(ddl), tables: [...Object.keys(legacy.tables), ...Object.keys(additionalTables)],
    validateLegacy: () => null,
    apply: (_database, fromVersion) => {
      if (fromVersion !== 1) throw new PersistenceValidationError('Execution ownership requires a verified version 1 baseline');
      validateLegacy();
      legacy.validateEvidence();
      sql.exec(`ALTER TABLE execution_reservations RENAME TO execution_reservations_v1; ${RESERVATIONS_V2};
        INSERT INTO execution_reservations SELECT * FROM execution_reservations_v1; DROP TABLE execution_reservations_v1;
        ${RESERVATIONS_INDEX}; ${EXECUTION_OWNERSHIP_DDL}`);
      const protectedRuns = new Map<string, string>();
      const protect = (runId: string, repo: string): void => {
        const previous = protectedRuns.get(runId);
        if (previous && previous.toLowerCase() !== repo.toLowerCase()) throw new PersistenceValidationError('Conflicting execution migration galleon');
        protectedRuns.set(runId, repo);
      };
      for (const row of sql.prepare('SELECT runId,repo FROM execution_reservations').all() as { runId: string; repo: string }[]) protect(row.runId, row.repo);
      for (const row of sql.prepare('SELECT runId,json FROM execution_attempts').all() as { runId: string; json: string }[]) {
        const attempt = JSON.parse(row.json) as { snapshotId?: string; paths?: { worktree?: string | null }; outcome?: unknown } | null;
        if (!attempt || !attempt.snapshotId || !attempt.paths) throw new PersistenceValidationError('Invalid execution migration evidence');
        if (attempt.outcome && !attempt.paths.worktree) continue;
        const snapshot = sql.prepare('SELECT json FROM execution_snapshots WHERE id=?').get(attempt.snapshotId) as { json: string } | undefined;
        const value = snapshot ? JSON.parse(snapshot.json) as { repo?: string } | null : null;
        if (!value?.repo) throw new PersistenceValidationError('Missing execution migration snapshot');
        protect(row.runId, value.repo);
      }
      for (const row of sql.prepare("SELECT c.runId,s.json FROM execution_checkpoints c LEFT JOIN execution_snapshots s ON s.id=c.snapshotId WHERE c.state='resumable'").all() as { runId: string; json: string | null }[]) {
        const snapshot = row.json ? JSON.parse(row.json) as { runId?: string; repo?: string } | null : null;
        if (!snapshot?.repo || snapshot.runId !== row.runId) throw new PersistenceValidationError('Missing checkpoint migration evidence');
        protect(row.runId, snapshot.repo);
      }
      if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_execution_obligations'").get()) {
        for (const row of sql.prepare('SELECT runId,repo FROM legacy_execution_obligations WHERE protected=1').all() as { runId: string; repo: string }[]) protect(row.runId, row.repo);
      }
      const hasRuns = sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get();
      if (hasRuns) for (const row of sql.prepare("SELECT id,repo FROM runs WHERE status='running' OR worktreePath IS NOT NULL").all() as { id: string; repo: string }[]) protect(row.id, row.repo);
      for (const [runId, repo] of protectedRuns) {
        const footprint = exclusiveExecutionFootprint(runId, repo);
        sql.prepare("INSERT INTO execution_footprints VALUES (?,?,?,?,'held',NULL)").run(runId, footprint.repo, persistenceHash(footprint), stableJson(footprint));
      }
    },
    validateCurrent: () => {
      legacy.validateEvidence();
      for (const [table, columns] of Object.entries({ ...legacy.tables, ...additionalTables })) validateTableColumns(sql, table, columns);
      validateDefinition(sql, 'execution_reservations', RESERVATIONS_V2);
      validateDefinition(sql, 'execution_reservations_repo', RESERVATIONS_INDEX);
      for (const statement of EXECUTION_OWNERSHIP_DDL.split(';').map(value => value.trim()).filter(Boolean)) {
        const name = /^CREATE (?:TABLE|INDEX) (\w+)/.exec(statement)?.[1];
        if (!name) throw new PersistenceValidationError('Invalid execution ownership definition');
        validateDefinition(sql, name, statement);
      }
    },
  });
  return 2;
}
