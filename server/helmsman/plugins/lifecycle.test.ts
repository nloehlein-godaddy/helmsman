// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExecutionStore, type ArtifactBinding, type ExecutionSnapshotInput, type ExecutionStore } from '../execution-store';
import { acknowledgePersistenceIntent, openPersistence, pendingPersistenceIntents, persistenceHash, type Persistence } from '../persistence';
import { openPluginLifecycle, type PluginLifecycle } from './lifecycle';
import { migrateOwned, schemaVersion, validateTableColumns } from '../migrations';

let root: string;
let persistence: Persistence;
let executions: ExecutionStore;
let lifecycle: PluginLifecycle;
const host: ArtifactBinding = { pluginId: 'example.host', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: ['example.helper'] };
const helper: ArtifactBinding = { pluginId: 'example.helper', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] };
const host2: ArtifactBinding = { ...host, artifactHash: 'c'.repeat(64), packageVersion: '2.0.0' };
const helper2: ArtifactBinding = { ...helper, artifactHash: 'd'.repeat(64), packageVersion: '2.0.0' };
function snapshot(): ExecutionSnapshotInput {
  return { version: 1, runId: 'run-1', attempt: 1, repo: 'org/galleon', logicalWork: { source: 'todo', instance: 'local', taskId: 'todo-1' },
    task: { title: 'work' }, workflowSnapshotId: 'workflow-1', artifacts: [host, helper],
    bindings: [{ role: 'host', capability: 'helmsman/host', contractVersion: 1, contributionId: 'example.host/detached', pluginId: host.pluginId, artifactHash: host.artifactHash, connectionId: null, credentialHandle: null }],
    settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null } };
}
function project() { for (const intent of pendingPersistenceIntents(persistence)) for (const target of intent.targets) acknowledgePersistenceIntent(persistence, intent.id, target); }
function enable(artifact: ArtifactBinding) {
  const row = lifecycle.list().find(row => row.pluginId === artifact.pluginId)!;
  lifecycle.apply({ id: `${artifact.pluginId}-enable-${row.revision}`, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, expectedRevision: row.revision, desiredEnabled: true, drainDependents: [] });
  project(); lifecycle.recordHealth(artifact.pluginId, artifact.artifactHash, 'active', null);
}
function prepare() {
  return persistence.transaction(() => {
    lifecycle.assertAdmission(snapshot());
    return executions.prepare({ snapshot: snapshot(), launchId: 'launch-1', paths: { worktree: '/tmp/work', log: '/tmp/log', exit: '/tmp/exit', spec: '/tmp/spec' }, maxConcurrency: 1 });
  });
}
function checkpoint() {
  const attempt = prepare(); const lease = executions.lease(attempt, 60_000)!;
  persistence.transaction(() => {
    executions.recordOutcome(lease, { status: 'succeeded', endedAt: new Date().toISOString(), evidence: { exit: 0 } });
    executions.retainCheckpoint({ id: 'checkpoint-1', runId: attempt.runId, attempt: attempt.attempt, snapshotId: attempt.snapshotId, format: 'pre-pr', formatVersion: 1, artifacts: { file: 'checkpoint.json', hash: 'e'.repeat(64) }, state: 'resumable' });
    executions.releasePins('execution', attempt.snapshotId);
    executions.releaseReservation(attempt.runId, { exit: 0 });
  });
  return attempt;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helmsman-lifecycle-')); persistence = openPersistence(join(root, 'state.sqlite'));
  executions = openExecutionStore(persistence); lifecycle = openPluginLifecycle(persistence, executions);
  for (const artifact of [helper, host, helper2, host2]) lifecycle.registerArtifact({ artifact, schemas: [] });
  enable(helper); enable(host);
});
afterEach(() => { persistence.close(); rmSync(root, { recursive: true, force: true }); });

describe('plugin lifecycle and retained bindings', () => {
  it('denies admission before cross-database projections settle and requires the preparation transaction', () => {
    expect(() => lifecycle.assertAdmission(snapshot())).toThrow('transaction');
    lifecycle.apply({ id: 'disable', pluginId: host.pluginId, artifactHash: host.artifactHash, expectedRevision: 1, desiredEnabled: false, drainDependents: [] });
    lifecycle.apply({ id: 'enable-again', pluginId: host.pluginId, artifactHash: host.artifactHash, expectedRevision: 2, desiredEnabled: true, drainDependents: [] });
    expect(() => prepare()).toThrow('denies new admissions');
    project(); expect(prepare().runId).toBe('run-1');
  });

  it('disables new work while retaining obligation-only service through failure and restart', () => {
    prepare();
    lifecycle.apply({ id: 'disable', pluginId: host.pluginId, artifactHash: host.artifactHash, expectedRevision: 1, desiredEnabled: false, drainDependents: [] });
    expect(lifecycle.list().find(row => row.pluginId === host.pluginId)).toMatchObject({ desiredEnabled: false, state: 'draining', obligationsOnly: true });
    expect(() => lifecycle.assertObligation(snapshot())).not.toThrow();
    expect(() => prepare()).toThrow('denies new admissions');
    lifecycle.recordHealth(host.pluginId, host.artifactHash, 'failed', { code: 'activation-failed', message: 'Unavailable', retryable: true, details: null });
    persistence.close(); persistence = openPersistence(join(root, 'state.sqlite')); executions = openExecutionStore(persistence); lifecycle = openPluginLifecycle(persistence, executions);
    expect(lifecycle.list().find(row => row.pluginId === host.pluginId)).toMatchObject({ desiredEnabled: false, state: 'failed', obligationsOnly: true });
    lifecycle.recordHealth(host.pluginId, host.artifactHash, 'active', null);
    expect(lifecycle.list().find(row => row.pluginId === host.pluginId)?.state).toBe('draining');
  });

  it('requires explicit dependent draining when disabling a provider', () => {
    prepare();
    const change = { id: 'disable-helper', pluginId: helper.pluginId, artifactHash: helper.artifactHash, expectedRevision: 1, desiredEnabled: false, drainDependents: [] };
    expect(lifecycle.plan(change).blockers).toMatchObject([{ kind: 'consumer', ownerId: host.pluginId }]);
    expect(() => lifecycle.apply(change)).toThrow('explicitly drained');
    lifecycle.apply({ ...change, drainDependents: [host.pluginId] });
    expect(lifecycle.list().every(row => !row.desiredEnabled && row.state === 'draining')).toBe(true);
  });

  it('rejects upgrades of completed checkpoint providers and transitive dependencies despite compatible schemas', () => {
    checkpoint();
    for (const [old, next] of [[host, host2], [helper, helper2]] as const) {
      lifecycle.recordHealth(old.pluginId, old.artifactHash, 'inactive', null);
      const change = { id: `upgrade-${old.pluginId}`, pluginId: old.pluginId, artifactHash: next.artifactHash, expectedRevision: 1, desiredEnabled: true, drainDependents: [] };
      expect(lifecycle.plan(change).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'checkpoint', ownerId: 'checkpoint-1' })]));
      expect(() => lifecycle.apply(change)).toThrow('Retained checkpoint');
      expect(lifecycle.canCollect(old.pluginId, old.artifactHash).allowed).toBe(false);
    }
  });

  it('automatically blocks schema migrations incompatible with a retained checkpoint without caller-supplied ranges', () => {
    const ddl = 'CREATE TABLE fixture_schema(id TEXT PRIMARY KEY)';
    const owner = 'example.schema';
    migrateOwned(persistence.sql, { owner, version: 1, checksum: persistenceHash(ddl), tables: ['fixture_schema'],
      validateLegacy: () => null, apply: sql => sql.exec(ddl), validateCurrent: sql => validateTableColumns(sql, 'fixture_schema', ['id']) });
    const input = { ...snapshot(), schemas: [{ owner, minimum: 1, maximum: 1 }] };
    const attempt = executions.prepare({ snapshot: input, launchId: 'launch-schema', paths: { worktree: null, log: '/tmp/log', exit: '/tmp/exit', spec: '/tmp/spec' }, maxConcurrency: 1 });
    executions.retainCheckpoint({ id: 'schema-checkpoint', runId: attempt.runId, attempt: attempt.attempt, snapshotId: attempt.snapshotId, format: 'test', formatVersion: 1, artifacts: {}, state: 'resumable' });
    const lease = executions.lease(attempt, 60_000)!;
    executions.recordOutcome(lease, { status: 'succeeded', endedAt: new Date().toISOString(), evidence: { exit: 0 } });
    executions.releasePins('execution', attempt.snapshotId);
    expect(() => migrateOwned(persistence.sql, { owner, version: 2, checksum: persistenceHash('two'), tables: ['fixture_schema'],
      validateLegacy: () => null, apply: sql => sql.exec('ALTER TABLE fixture_schema ADD COLUMN incompatible TEXT'), validateCurrent: () => {} })).toThrow('Retained consumer');
    expect(schemaVersion(persistence.sql, owner)).toBe(1);
    expect(persistence.sql.pragma('table_info(fixture_schema)')).toHaveLength(1);
  });

  it('records checkpoint migration provenance and atomically transfers closure pins before compatible activation', async () => {
    const attempt = checkpoint();
    const next: ExecutionSnapshotInput = { ...snapshot(), artifacts: [host2, helper], bindings: snapshot().bindings.map(binding => ({ ...binding, artifactHash: host2.artifactHash })), provenance: { kind: 'checkpoint-migration', evidence: { validated: true } } };
    const provider = snapshot().bindings[0]!;
    lifecycle = openPluginLifecycle(persistence, executions, [{ provider, async validate(input) {
      expect(persistence.sql.inTransaction).toBe(false);
      expect(input.checkpoint.artifacts).toEqual({ file: 'checkpoint.json', hash: 'e'.repeat(64) });
      expect(input.previous.id).toBe(attempt.snapshotId);
      expect(input.next).toEqual(next);
      return { checkpointFormat: 1, compatible: true };
    } }]);
    const validation = await lifecycle.validateCheckpointMigration({ checkpointId: 'checkpoint-1', expectedSnapshotId: attempt.snapshotId, next, provider });
    lifecycle.migrateCheckpoint({ checkpointId: 'checkpoint-1', expectedSnapshotId: attempt.snapshotId, next, validation: { provider, ...validation }, actor: 'operator', reason: 'Validated provider checkpoint migration' });
    expect(executions.snapshot(attempt.snapshotId)?.artifacts).toEqual([host, helper]);
    expect(executions.checkpoint('checkpoint-1')?.snapshotId).toBe(persistenceHash(next));
    expect(executions.pins(host.pluginId)).toMatchObject([{ artifactHash: host2.artifactHash, kind: 'checkpoint' }]);
    expect(persistence.sql.prepare('SELECT oldSnapshotId,newSnapshotId FROM binding_migrations').get()).toEqual({ oldSnapshotId: attempt.snapshotId, newSnapshotId: persistenceHash(next) });
    lifecycle.recordHealth(host.pluginId, host.artifactHash, 'inactive', null);
    lifecycle.apply({ id: 'upgrade-host', pluginId: host.pluginId, artifactHash: host2.artifactHash, expectedRevision: 1, desiredEnabled: true, drainDependents: [] });
    project(); lifecycle.recordHealth(host.pluginId, host2.artifactHash, 'active', null);
    expect(lifecycle.canCollect(host.pluginId, host.artifactHash).allowed).toBe(true);
    expect(() => lifecycle.assertObligation(next)).not.toThrow();
  });

  it('requires a registered provider validator and rejects evidence changed while validation is pending', async () => {
    const attempt = checkpoint();
    const next = { ...snapshot(), provenance: { kind: 'checkpoint-migration' as const, evidence: null } };
    const provider = snapshot().bindings[0]!;
    const input = { checkpointId: 'checkpoint-1', expectedSnapshotId: attempt.snapshotId, next, provider };
    await expect(lifecycle.validateCheckpointMigration(input)).rejects.toThrow('does not support');
    lifecycle = openPluginLifecycle(persistence, executions, [{ provider, async validate() {
      executions.retireCheckpoint('checkpoint-1', { actor: 'operator', reason: 'Retired during validation' });
      return { valid: true };
    } }]);
    await expect(lifecycle.validateCheckpointMigration(input)).rejects.toThrow('not its retained provider');
    expect(persistence.sql.prepare('SELECT COUNT(*) AS n FROM checkpoint_migration_validations').get()).toEqual({ n: 0 });
  });

  it('rolls back a compatible package after forward migration without rolling back data and rejects an incompatible package', () => {
    function migrate(version: number) {
      migrateOwned(persistence.sql, { owner: 'example.storage', version, checksum: persistenceHash({ version }), tables: ['example_rows'],
        validateLegacy: () => null,
        apply(sql, prior) { if (!prior) sql.exec('CREATE TABLE example_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); if (version === 2) sql.exec('ALTER TABLE example_rows ADD COLUMN migrated TEXT'); },
        validateCurrent: sql => validateTableColumns(sql, 'example_rows', version === 2 ? ['id', 'value', 'migrated'] : ['id', 'value']),
      });
    }
    migrate(1);
    persistence.sql.exec("INSERT INTO example_rows VALUES('kept','original')");
    const old = { pluginId: 'example.storage', artifactHash: '1'.repeat(64), packageVersion: '1.0.0', requires: [] };
    const upgraded = { ...old, artifactHash: '2'.repeat(64), packageVersion: '2.0.0' };
    const incompatible = { ...old, artifactHash: '3'.repeat(64), packageVersion: '0.1.0' };
    lifecycle.registerArtifact({ artifact: old, schemas: [{ owner: old.pluginId, minimum: 1, maximum: 2 }] }); enable(old);
    lifecycle.recordHealth(old.pluginId, old.artifactHash, 'inactive', null);
    migrate(2);
    persistence.sql.exec("UPDATE example_rows SET migrated='retained'");
    lifecycle.registerArtifact({ artifact: upgraded, schemas: [{ owner: old.pluginId, minimum: 2, maximum: 2 }] }); enable(upgraded);
    lifecycle.recordHealth(old.pluginId, upgraded.artifactHash, 'inactive', null);
    enable(old);
    expect(schemaVersion(persistence.sql, old.pluginId)).toBe(2);
    expect(persistence.sql.prepare('SELECT * FROM example_rows').all()).toEqual([{ id: 'kept', value: 'original', migrated: 'retained' }]);
    lifecycle.recordHealth(old.pluginId, old.artifactHash, 'inactive', null);
    lifecycle.registerArtifact({ artifact: incompatible, schemas: [{ owner: old.pluginId, minimum: 1, maximum: 1 }] });
    expect(() => enable(incompatible)).toThrow('Incompatible schema');
    expect(lifecycle.list().find(row => row.pluginId === old.pluginId)?.artifactHash).toBe(old.artifactHash);
  });

  it('rejects checkpoint migration without matching provider validation and preserves old pins', () => {
    const attempt = checkpoint();
    const next = { ...snapshot(), provenance: { kind: 'checkpoint-migration' as const, evidence: null } };
    expect(() => lifecycle.migrateCheckpoint({ checkpointId: 'checkpoint-1', expectedSnapshotId: attempt.snapshotId, next,
      validation: { provider: snapshot().bindings[0]!, receipt: {}, validationId: 'fake' }, actor: 'operator', reason: 'try migration' })).toThrow('validation does not match');
    expect(executions.checkpoint('checkpoint-1')?.snapshotId).toBe(attempt.snapshotId);
    expect(executions.pins(host.pluginId)[0]?.artifactHash).toBe(host.artifactHash);
  });

  it('rejects raced selection revisions, conflicting immutable metadata and unknown schema requirements', () => {
    expect(() => lifecycle.apply({ id: 'stale', pluginId: host.pluginId, artifactHash: host.artifactHash, expectedRevision: 0, desiredEnabled: false, drainDependents: [] })).toThrow('revision changed');
    expect(() => lifecycle.registerArtifact({ artifact: { ...host, requires: [] }, schemas: [] })).toThrow('metadata changed');
    expect(() => persistence.transaction(() => lifecycle.assertAdmission({ ...snapshot(), schemas: [{ owner: 'missing', minimum: 1, maximum: 2 }] }))).toThrow('Incompatible schema');
  });
});
