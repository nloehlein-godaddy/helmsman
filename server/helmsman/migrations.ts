import type Database from 'better-sqlite3';
import type { PluginJson } from '../../src/plugins/backend';
import { assertMaintenanceAvailable, ensurePersistenceMetadata, immediateTransaction, persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';

export interface SchemaRange { owner: string; minimum: number; maximum: number }
export interface OwnedMigration {
  owner: string;
  version: number;
  checksum: string;
  tables: readonly string[];
  validateLegacy(sql: Database.Database): number | null;
  apply(sql: Database.Database, fromVersion: number): void;
  validateCurrent(sql: Database.Database): void;
}

export function schemaVersion(sql: Database.Database, owner: string): number | null {
  const row = sql.prepare('SELECT MAX(version) AS version FROM migration_ledger WHERE owner = ?').get(owner) as { version: number | null };
  return row.version;
}

export function assertSchemaRanges(sql: Database.Database, ranges: readonly SchemaRange[]): void {
  for (const range of ranges) {
    if (!range?.owner || !Number.isSafeInteger(range.minimum) || !Number.isSafeInteger(range.maximum) || range.minimum < 0 || range.maximum < range.minimum) throw new PersistenceValidationError('Invalid schema compatibility range');
    const version = schemaVersion(sql, range.owner);
    if (version === null || version < range.minimum || version > range.maximum) throw new PersistenceConflictError(`Incompatible schema: ${range.owner}`);
  }
}

function retainedSchemaRanges(sql: Database.Database): SchemaRange[] {
  const exists = (table: string) => Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if (!exists('artifact_pins')) return [];
  const pins = sql.prepare('SELECT DISTINCT pluginId,artifactHash FROM artifact_pins').all() as { pluginId: string; artifactHash: string }[];
  const ranges: SchemaRange[] = [];
  const pinned = (item: unknown): boolean => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    return !!value && pins.some(pin => pin.pluginId === value.pluginId && pin.artifactHash === value.artifactHash);
  };
  function append(value: unknown): void {
    if (!Array.isArray(value) || value.some(range => !range?.owner || !Number.isSafeInteger(range.minimum) || !Number.isSafeInteger(range.maximum) || range.minimum < 0 || range.maximum < range.minimum)) throw new PersistenceValidationError('Invalid retained schema compatibility');
    ranges.push(...value as SchemaRange[]);
  }
  if (exists('execution_snapshots')) for (const row of sql.prepare('SELECT id,contentHash,json FROM execution_snapshots').all() as { id: string; contentHash: string; json: string }[]) {
    const value = persistedJson(JSON.parse(row.json)) as { artifacts?: unknown; schemas?: unknown } | null;
    if (!value || !Array.isArray(value.artifacts)) throw new PersistenceValidationError('Invalid retained execution snapshot');
    if (!value.artifacts.some(pinned)) continue;
    if (row.id !== row.contentHash || persistenceHash(value) !== row.contentHash) throw new PersistenceValidationError('Retained execution snapshot integrity check failed');
    append(value.schemas);
  }
  if (exists('plugin_artifacts')) for (const row of sql.prepare('SELECT json FROM plugin_artifacts').all() as { json: string }[]) {
    const value = persistedJson(JSON.parse(row.json)) as { artifact?: unknown; schemas?: unknown } | null;
    if (pinned(value?.artifact)) append(value?.schemas);
  }
  return ranges;
}

export function migrateOwned(sql: Database.Database, migration: OwnedMigration, retainedConsumers: readonly SchemaRange[] = []): void {
  if (!migration?.owner || !Number.isSafeInteger(migration.version) || migration.version < 1 || !/^[a-f\d]{64}$/.test(migration.checksum)
    || !Array.isArray(migration.tables) || !migration.tables.length || migration.tables.some(table => !/^[a-z][a-z_0-9]*$/.test(table))) throw new PersistenceValidationError('Invalid owned migration');
  ensurePersistenceMetadata(sql);
  immediateTransaction(sql, () => {
    const prior = sql.prepare('SELECT version, checksum FROM migration_ledger WHERE owner = ? ORDER BY version DESC LIMIT 1').get(migration.owner) as { version: number; checksum: string } | undefined;
    if (prior?.version === migration.version) {
      if (prior.checksum !== migration.checksum) throw new PersistenceConflictError(`Migration checksum changed: ${migration.owner}@${migration.version}`);
      migration.validateCurrent(sql);
      assertSchemaRanges(sql, retainedConsumers);
      return;
    }
    assertMaintenanceAvailable(sql);
    retainedConsumers = [...retainedConsumers, ...retainedSchemaRanges(sql)];
    if (prior && prior.version > migration.version) throw new PersistenceConflictError(`Schema downgrade is unsupported: ${migration.owner}`);
    for (const range of retainedConsumers) {
      if (range.owner === migration.owner && (migration.version < range.minimum || migration.version > range.maximum)) throw new PersistenceConflictError(`Retained consumer blocks schema migration: ${migration.owner}`);
    }
    const existingTables = migration.tables.filter(table => sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const legacy = prior ? prior.version : migration.validateLegacy(sql);
    if (legacy === null && existingTables.length || legacy !== null && (!Number.isSafeInteger(legacy) || legacy < 0 || legacy > migration.version)) throw new PersistenceValidationError(`Unrecognized schema baseline: ${migration.owner}`);
    const baseline = legacy ?? 0;
    if (!prior && baseline > 0 && baseline < migration.version) sql.prepare('INSERT INTO migration_ledger VALUES (?, ?, ?, ?, 1)').run(migration.owner, baseline, 'legacy-validated', new Date().toISOString());
    migration.apply(sql, baseline);
    migration.validateCurrent(sql);
    sql.prepare('INSERT INTO migration_ledger VALUES (?, ?, ?, ?, 0)').run(migration.owner, migration.version, migration.checksum, new Date().toISOString());
    assertSchemaRanges(sql, retainedConsumers);
  });
}

export function validateTableColumns(sql: Database.Database, table: string, columns: readonly string[]): void {
  if (!/^[a-z][a-z_0-9]*$/.test(table)) throw new PersistenceValidationError('Invalid schema table name');
  const actual = sql.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!actual.length || columns.some(name => !actual.some(column => column.name === name))) throw new PersistenceValidationError(`Invalid owned table: ${table}`);
}

export function recordMigrationStep(sql: Database.Database, input: {
  owner: string; migration: string; step: string; checksum: string;
  state: 'prepared' | 'completed' | 'failed'; payload: PluginJson;
}): void {
  if (!input?.owner || !input.migration || !input.step || !/^[a-f\d]{64}$/.test(input.checksum)
    || !['prepared', 'completed', 'failed'].includes(input.state)) throw new PersistenceValidationError('Invalid migration step');
  ensurePersistenceMetadata(sql);
  immediateTransaction(sql, () => {
    assertMaintenanceAvailable(sql);
    const prior = sql.prepare('SELECT checksum, state, payload FROM migration_steps WHERE owner = ? AND migration = ? AND step = ?').get(input.owner, input.migration, input.step) as { checksum: string; state: string; payload: string } | undefined;
    const payload = stableJson(input.payload);
    if (prior && (prior.checksum !== input.checksum || prior.state === 'completed' && (input.state !== 'completed' || prior.payload !== payload))) throw new PersistenceConflictError('Migration preparation cannot change a completed step');
    sql.prepare(`INSERT INTO migration_steps VALUES (@owner,@migration,@step,@checksum,@state,@payload)
      ON CONFLICT(owner,migration,step) DO UPDATE SET state=excluded.state,payload=excluded.payload`).run({ ...input, payload });
  });
}
