// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { executionMigrationReadiness } from './execution-schema';
import { schemaVersion } from './migrations';

const databases: Persistence[] = [];
afterEach(() => { databases.splice(0).forEach(database => database.close()); });
const database = () => { const value = openPersistence(':memory:'); databases.push(value); return value; };
const hash = 'a'.repeat(64);
const snapshot = (maximum = 1): ExecutionSnapshotInput => ({ version: 1, runId: 'one', attempt: 1, repo: 'org/repo',
  logicalWork: { source: 'source', instance: 'one', taskId: 'task' }, task: {}, workflowSnapshotId: null,
  artifacts: [{ pluginId: 'example.host', artifactHash: hash, packageVersion: '1.0.0', requires: [] }],
  bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'example.host/local', pluginId: 'example.host', artifactHash: hash, connectionId: null, credentialHandle: null }],
  settings: {}, schemas: [{ owner: 'core.execution', minimum: 1, maximum }], provenance: { kind: 'admission', evidence: {} } });
const paths = { worktree: '/tmp/one', log: '/tmp/one.log', exit: '/tmp/one.exit', spec: '/tmp/one.json' };

it('creates a compatible new schema without enabling parallel admission', () => {
  const db = database(); const store = openExecutionStore(db, Date.now, { preferSchema: 2 });
  expect(schemaVersion(db.sql, 'core.execution')).toBe(2);
  store.reserveAdmission({ runId: 'one', repo: 'org/repo', maxConcurrency: 3, evidence: {} });
  expect(() => store.reserveAdmission({ runId: 'two', repo: 'ORG/REPO', maxConcurrency: 3, evidence: {} })).toThrow('capacity');
  expect(() => openExecutionStore(db)).not.toThrow();
});

it('keeps version 1 recovery and admission operational when retained consumers block migration', () => {
  const db = database(); const first = openExecutionStore(db);
  const attempt = first.prepare({ snapshot: snapshot(), paths, launchId: 'one-launch', maxConcurrency: 3 });
  const before = first.pins();
  const compatible = openExecutionStore(db, Date.now, { preferSchema: 2 });
  expect(executionMigrationReadiness(db.sql)).toMatchObject({ currentVersion: 1, ready: false,
    blockers: [{ source: 'execution-snapshot', identity: attempt.snapshotId, range: { owner: 'core.execution', minimum: 1, maximum: 1 } }] });
  expect(compatible.pins()).toEqual(before); expect(compatible.attempt({ runId: 'one', attempt: 1 })).toEqual(attempt);
  compatible.reserveAdmission({ runId: 'other', repo: 'org/other', maxConcurrency: 3, evidence: {} });
  expect(compatible.reservations()).toHaveLength(2);
});

it('reports historical snapshots sharing a retained artifact, not only active execution pins', () => {
  const db = database(); const store = openExecutionStore(db);
  const attempt = store.prepare({ snapshot: snapshot(), paths, launchId: 'one-launch', maxConcurrency: 3 });
  const lease = store.lease({ runId: 'one', attempt: 1 }, 60_000)!;
  store.recordOutcome(lease, { status: 'succeeded', endedAt: new Date().toISOString(), evidence: { kind: 'exit', code: 0 } });
  store.releaseReservation('one', {}); store.releasePins('execution', attempt.snapshotId);
  store.retainPins([{ kind: 'dependency', ownerId: 'another-obligation', pluginId: 'example.host', artifactHash: hash }]);
  expect(executionMigrationReadiness(db.sql).blockers.map(item => item.identity)).toEqual([attempt.snapshotId]);
  openExecutionStore(db, Date.now, { preferSchema: 2 });
  expect(schemaVersion(db.sql, 'core.execution')).toBe(1);
});

it('migrates compatible reservations without dropping identity or ownership evidence', () => {
  const db = database(); const store = openExecutionStore(db);
  const attempt = store.prepare({ snapshot: snapshot(2), paths, launchId: 'one-launch', maxConcurrency: 3 });
  const pins = store.pins();
  const next = openExecutionStore(db, Date.now, { preferSchema: 2 });
  expect(next.attempt({ runId: 'one', attempt: 1 })).toEqual(attempt); expect(next.pins()).toEqual(pins);
  expect(next.reservations()).toEqual(store.reservations());
  expect(db.sql.prepare('SELECT json FROM execution_footprints WHERE runId=?').get('one')).toMatchObject({ json: expect.stringContaining('"completeness":"exclusive"') });
});

it('rejects a damaged ownership index rather than silently continuing', () => {
  const db = database(); openExecutionStore(db, Date.now, { preferSchema: 2 });
  db.sql.exec('DROP INDEX execution_reservations_repo; CREATE INDEX execution_reservations_repo ON execution_reservations(reason)');
  expect(() => openExecutionStore(db)).toThrow('Invalid execution ownership schema');
});

it('rolls back migration when preserved execution evidence is incomplete', () => {
  const db = database(); const store = openExecutionStore(db);
  store.prepare({ snapshot: snapshot(2), paths, launchId: 'one-launch', maxConcurrency: 3 });
  db.sql.prepare('UPDATE execution_attempts SET json=?').run('{}');
  expect(() => openExecutionStore(db, Date.now, { preferSchema: 2 })).toThrow('integrity check failed');
  expect(schemaVersion(db.sql, 'core.execution')).toBe(1);
  expect(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='execution_footprints'").get()).toBeUndefined();
  expect(db.sql.prepare('SELECT count(*) AS count FROM execution_reservations').get()).toEqual({ count: 1 });
});

it('keeps existing legacy workspaces on the compatible reader after execution pins settle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-legacy-workspace-'));
  const db = database(); const store = openExecutionStore(db);
  const attempt = store.prepare({ snapshot: snapshot(), paths: { ...paths, worktree: directory }, launchId: 'launch', maxConcurrency: 2 });
  const lease = store.lease({ runId: 'one', attempt: 1 }, 60_000)!;
  store.recordOutcome(lease, { status: 'failed', endedAt: new Date().toISOString(), evidence: { kind: 'never-launched' } });
  store.releaseReservation('one', {}); store.releasePins('execution', attempt.snapshotId);
  try {
    expect(store.pins()).toEqual([]);
    expect(executionMigrationReadiness(db.sql)).toMatchObject({ ready: false, blockers: [{ source: 'execution-snapshot', identity: attempt.snapshotId }] });
    openExecutionStore(db, Date.now, { preferSchema: 2 }); expect(schemaVersion(db.sql, 'core.execution')).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  openExecutionStore(db, Date.now, { preferSchema: 2 }); expect(schemaVersion(db.sql, 'core.execution')).toBe(2);
});
