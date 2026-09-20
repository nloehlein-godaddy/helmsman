// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgePersistenceIntent, assertMaintenanceAvailable, claimApplicationStartup, openPersistence, pendingPersistenceIntents, persistedJson, persistenceHash, registerPersistenceWriter, writePersistenceIntent, type Persistence } from './persistence';
import { migrateOwned, recordMigrationStep, schemaVersion, validateTableColumns, type OwnedMigration } from './migrations';

let root: string;
let persistence: Persistence;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'helmsman-persistence-')); persistence = openPersistence(join(root, 'state.sqlite')); });
afterEach(() => { persistence.close(); rmSync(root, { recursive: true, force: true }); });

function migration(version = 1): OwnedMigration {
  return { owner: 'fixture', version, checksum: persistenceHash({ version }), tables: ['fixture_rows'],
    validateLegacy(sql) {
      if (!sql.prepare("SELECT name FROM sqlite_master WHERE name='fixture_rows'").get()) return null;
      validateTableColumns(sql, 'fixture_rows', ['id', 'value']);
      return 1;
    },
    apply(sql, prior) { if (prior === 0) sql.exec('CREATE TABLE fixture_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); if (version === 2) sql.exec('ALTER TABLE fixture_rows ADD COLUMN optional TEXT'); },
    validateCurrent: sql => validateTableColumns(sql, 'fixture_rows', version === 2 ? ['id', 'value', 'optional'] : ['id', 'value']),
  };
}

describe('coordinated persistence', () => {
  it('claims application startup before setup and atomically promotes the same writer without a maintenance gap', () => {
    const second = openPersistence(join(root, 'state.sqlite'));
    const startup = claimApplicationStartup(persistence);
    const token = persistence.sql.prepare('SELECT token FROM persistence_writers').get();
    try {
      migrateOwned(persistence.sql, migration());
      expect(() => claimApplicationStartup(second)).toThrow('active database writer');
      expect(() => migrateOwned(second.sql, migration(2))).toThrow('active database writer');
      expect(() => second.transaction(() => second.sql.prepare('INSERT INTO fixture_rows VALUES(?,?)').run('foreign', 'startup'))).toThrow('application-startup');
      expect(() => registerPersistenceWriter(second, 'plugin-cli')).toThrow('application-startup');
      expect(() => claimApplicationStartup(persistence)).toThrow('already claimed');
      startup.ready(); startup.ready();
      expect(persistence.sql.prepare('SELECT token FROM persistence_writers').get()).toEqual(token);
      expect(persistence.sql.prepare('SELECT owner FROM persistence_writers').get()).toEqual({ owner: 'application' });
      expect(() => migrateOwned(persistence.sql, migration(2))).toThrow('active database writer');
      expect(() => claimApplicationStartup(second)).toThrow('active database writer');
      startup.close(); startup.close();
      const replacement = claimApplicationStartup(second);
      try { migrateOwned(second.sql, migration(2)); } finally { replacement.close(); }
      expect(() => startup.ready()).toThrow('closed');
    } finally { startup.close(); second.close(); }
  });

  it('refuses startup while an application or CLI writer is active and exposes no exemption to another connection', () => {
    const release = registerPersistenceWriter(persistence, 'plugin-cli');
    expect(() => claimApplicationStartup(persistence)).toThrow('active database writer');
    release();
    const startup = claimApplicationStartup(persistence);
    const second = openPersistence(join(root, 'state.sqlite'));
    try {
      expect(() => second.transaction(() => assertMaintenanceAvailable(second.sql))).toThrow('active database writer');
      expect(() => persistence.transaction(() => assertMaintenanceAvailable(persistence.sql))).not.toThrow();
    } finally { second.close(); startup.close(); }
  });

  it('rolls back nested shared-connection state and rejects asynchronous transaction callbacks', () => {
    migrateOwned(persistence.sql, migration());
    expect(() => persistence.transaction(() => {
      persistence.sql.prepare('INSERT INTO fixture_rows VALUES (?,?)').run('outer', 'value');
      persistence.transaction(() => persistence.sql.prepare('INSERT INTO fixture_rows VALUES (?,?)').run('inner', 'value'));
      throw new Error('crash');
    })).toThrow('crash');
    expect(persistence.sql.prepare('SELECT * FROM fixture_rows').all()).toEqual([]);
    expect(() => persistence.transaction(() => Promise.resolve(1))).toThrow('synchronous');
  });

  it('adopts only validated legacy schemas and preserves original rows', () => {
    persistence.sql.exec("CREATE TABLE fixture_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO fixture_rows VALUES('old','preserved')");
    migrateOwned(persistence.sql, migration(2));
    expect(schemaVersion(persistence.sql, 'fixture')).toBe(2);
    expect(persistence.sql.prepare('SELECT * FROM fixture_rows').all()).toEqual([{ id: 'old', value: 'preserved', optional: null }]);
    expect(persistence.sql.prepare('SELECT version,baseline FROM migration_ledger WHERE owner=? ORDER BY version').all('fixture')).toEqual([{ version: 1, baseline: 1 }, { version: 2, baseline: 0 }]);
    expect(() => migrateOwned(persistence.sql, migration())).toThrow('downgrade');
  });

  it('does not stamp corrupt existing tables as a supported baseline', () => {
    persistence.sql.exec('CREATE TABLE fixture_rows(wrong TEXT)');
    expect(() => migrateOwned(persistence.sql, migration())).toThrow('Invalid owned table');
    expect(schemaVersion(persistence.sql, 'fixture')).toBeNull();
  });

  it('commits schema and ledger together, rejects checksum drift and retained-incompatible upgrades', () => {
    const broken = migration();
    broken.validateCurrent = () => { throw new Error('bad schema'); };
    expect(() => migrateOwned(persistence.sql, broken)).toThrow('bad schema');
    expect(persistence.sql.prepare("SELECT name FROM sqlite_master WHERE name='fixture_rows'").get()).toBeUndefined();
    expect(schemaVersion(persistence.sql, 'fixture')).toBeNull();
    migrateOwned(persistence.sql, migration());
    expect(() => migrateOwned(persistence.sql, { ...migration(), checksum: 'b'.repeat(64) })).toThrow('checksum');
    expect(() => migrateOwned(persistence.sql, migration(2), [{ owner: 'fixture', minimum: 1, maximum: 1 }])).toThrow('Retained consumer');
    expect(schemaVersion(persistence.sql, 'fixture')).toBe(1);
  });

  it('blocks migrations while a registered writer holds the database, including another connection', () => {
    migrateOwned(persistence.sql, migration());
    const release = registerPersistenceWriter(persistence, 'running-host');
    const second = openPersistence(join(root, 'state.sqlite'));
    try {
      migrateOwned(second.sql, migration());
      expect(() => migrateOwned(second.sql, migration(2))).toThrow('active database writer');
      release();
      migrateOwned(second.sql, migration(2));
      expect(schemaVersion(persistence.sql, 'fixture')).toBe(2);
    } finally { second.close(); }
  });

  it('records resumable migration preparation and prevents mutation after completion', () => {
    const step = { owner: 'fixture', migration: 'two', step: 'stage-artifact', checksum: 'a'.repeat(64), payload: { path: 'staged' }, state: 'prepared' as const };
    recordMigrationStep(persistence.sql, step);
    recordMigrationStep(persistence.sql, { ...step, state: 'completed' });
    expect(() => recordMigrationStep(persistence.sql, { ...step, state: 'failed' })).toThrow('completed step');
    expect(() => recordMigrationStep(persistence.sql, { ...step, checksum: 'b'.repeat(64) })).toThrow('completed step');
  });

  it('replays cross-database intent projections without changing logical identity or losing pending targets', () => {
    const input = { id: 'change-1', owner: 'plugin:example.costs', revision: 1, payload: { enabled: false }, targets: ['catalog', 'plugin-data'] };
    const first = writePersistenceIntent(persistence, input);
    acknowledgePersistenceIntent(persistence, first.id, 'catalog');
    expect(pendingPersistenceIntents(persistence)).toMatchObject([{ id: first.id, acknowledged: ['catalog'] }]);
    expect(writePersistenceIntent(persistence, input).acknowledged).toEqual(['catalog']);
    expect(() => writePersistenceIntent(persistence, { ...input, payload: { enabled: true } })).toThrow('different content');
    expect(() => acknowledgePersistenceIntent(persistence, first.id, 'other')).toThrow('Unknown');
    acknowledgePersistenceIntent(persistence, first.id, 'plugin-data');
    expect(pendingPersistenceIntents(persistence)).toEqual([]);
  });

  it('takes a WAL-consistent SQLite backup without losing committed rows', async () => {
    migrateOwned(persistence.sql, migration());
    persistence.sql.prepare('INSERT INTO fixture_rows VALUES (?,?)').run('wal', 'committed');
    const target = join(root, 'backup.sqlite');
    await persistence.sql.backup(target);
    const backup = new Database(target, { readonly: true });
    try { expect(backup.prepare('SELECT * FROM fixture_rows').get()).toEqual({ id: 'wal', value: 'committed' }); } finally { backup.close(); }
  });

  it('rejects nullable, non-finite, cyclic, sparse, and accessor-bearing persisted data', () => {
    expect(persistedJson(null)).toBeNull();
    expect(() => persistedJson(undefined)).toThrow();
    expect(() => persistedJson({ value: Infinity })).toThrow();
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => persistedJson(cyclic)).toThrow();
    expect(() => persistedJson(new Array(2))).toThrow();
    expect(() => persistedJson({ get secret() { throw new Error('getter executed'); } })).toThrow('property');
  });
});
