// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExecutionStore, type AttemptLease, type ExecutionSnapshotInput, type ExecutionStore } from './execution-store';
import { openPersistence, type Persistence } from './persistence';

let root: string;
let persistence: Persistence;
let store: ExecutionStore;
let timestamp: number;
const hash = 'a'.repeat(64);
const dependency = 'b'.repeat(64);
const paths = { worktree: '/tmp/work', log: '/tmp/log', exit: '/tmp/exit', spec: '/tmp/spec' };
function snapshot(runId = 'run-1', attempt = 1): ExecutionSnapshotInput {
  return { version: 1, runId, attempt, repo: 'org/galleon', logicalWork: { source: 'jira', instance: 'tenant-1', taskId: 'T-1' },
    task: { ticketId: 'T-1', title: 'work' }, workflowSnapshotId: 'workflow-1',
    artifacts: [{ pluginId: 'example.host', artifactHash: hash, packageVersion: '1.0.0', requires: ['example.helper'] }, { pluginId: 'example.helper', artifactHash: dependency, packageVersion: '1.0.0', requires: [] }],
    bindings: [{ role: 'host', capability: 'helmsman/host', contractVersion: 1, contributionId: 'example.host/detached', pluginId: 'example.host', artifactHash: hash, connectionId: null, credentialHandle: null }],
    settings: { enabled: true }, schemas: [], provenance: { kind: 'admission', evidence: null } };
}
function prepare(runId = 'run-1', attempt = 1) { return store.prepare({ snapshot: snapshot(runId, attempt), launchId: `${runId}-${attempt}`, paths, maxConcurrency: 2 }); }
function lease(runId = 'run-1', attempt = 1): AttemptLease { return store.lease({ runId, attempt }, 60_000)!; }
function completed(owned: AttemptLease) { store.recordOutcome(owned, { status: 'succeeded', endedAt: new Date(timestamp).toISOString(), evidence: { kind: 'exit', launchId: `${owned.runId}-${owned.attempt}`, code: 0 } }); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helmsman-execution-')); timestamp = Date.parse('2026-09-20T00:00:00Z');
  persistence = openPersistence(join(root, 'state.sqlite')); store = openExecutionStore(persistence, () => timestamp);
});
afterEach(() => { persistence.close(); rmSync(root, { recursive: true, force: true }); });

describe('durable execution admission and recovery', () => {
  it('preserves unadopted legacy capacity and artifacts without inventing executable bindings', () => {
    persistence.sql.exec(`CREATE TABLE legacy_execution_obligations(runId TEXT PRIMARY KEY,repo TEXT,status TEXT,state TEXT,protected INTEGER);
      INSERT INTO legacy_execution_obligations VALUES('legacy-active','ORG/GALLEON','running','blocked',1);
      INSERT INTO legacy_execution_obligations VALUES('legacy-checkpoint','org/other','failed','blocked',1)`);
    expect(store.reservations()).toEqual([{ runId: 'legacy-active', repo: 'ORG/GALLEON', reason: 'unresolved' }]);
    expect(store.pins()).toEqual([]);
    expect(store.cleanupEligibility('legacy-active')).toMatchObject({ allowed: false });
    expect(store.cleanupEligibility('legacy-checkpoint')).toMatchObject({ allowed: false });
    expect(() => prepare('legacy-active')).toThrow('verified adoption');
    expect(() => prepare('legacy-checkpoint')).toThrow('verified adoption');
    expect(() => prepare()).toThrow('already reserves');
    expect(() => store.reserveAdmission({ runId: 'new', repo: 'org/galleon', maxConcurrency: 2, evidence: {} })).toThrow('capacity');
    expect(() => store.reserveAdmission({ runId: 'new', repo: 'org/new', maxConcurrency: 1, evidence: {} })).toThrow('capacity');
    expect(() => store.abandonAdmission('legacy-active', {})).toThrow('verified adoption');
    persistence.sql.exec("UPDATE legacy_execution_obligations SET protected=0 WHERE runId='legacy-active'");
    expect(store.reservations()).toEqual([]);
    expect(prepare().runId).toBe('run-1');
  });

  it('reserves before async admission work and refuses to abandon a prepared execution', () => {
    store.reserveAdmission({ runId: 'run-1', repo: 'org/galleon', maxConcurrency: 1, evidence: { request: 'request-1' } });
    expect(() => store.reserveAdmission({ runId: 'run-2', repo: 'org/other', maxConcurrency: 1, evidence: { request: 'request-2' } })).toThrow('capacity');
    prepare();
    expect(store.reservations()).toHaveLength(1);
    expect(() => store.abandonAdmission('run-1', { cancelled: true })).toThrow('Attempted execution');
  });

  it('allows evidence-backed cancellation only before an execution attempt exists', () => {
    store.reserveAdmission({ runId: 'run-1', repo: 'org/galleon', maxConcurrency: 1, evidence: { request: 'request-1' } });
    store.abandonAdmission('run-1', { cancelled: true });
    expect(store.reservations()).toEqual([]);
  });

  it('records one prepared worktree identity and rejects changing it or writing it after launch', () => {
    store.prepare({ snapshot: snapshot(), launchId: 'run-1-1', paths: { ...paths, worktree: null }, maxConcurrency: 1 });
    const owned = lease(); store.setWorktree(owned, '/tmp/prepared'); store.setWorktree(owned, '/tmp/prepared');
    expect(() => store.setWorktree(owned, '/tmp/other')).toThrow('cannot change');
    store.ready(owned); store.markLaunching(owned);
    expect(() => store.setWorktree(owned, '/tmp/prepared')).toThrow('cannot change');
  });

  it('retains admission pins through blocked preparation until the admission is started or failed', () => {
    persistence.sql.exec('CREATE TABLE execution_admissions(runId TEXT PRIMARY KEY,state TEXT)');
    persistence.sql.prepare('INSERT INTO execution_admissions VALUES (?,?)').run('run-1', 'blocked');
    store.retainPins([{ kind: 'admission', ownerId: 'run-1', pluginId: 'example.host', artifactHash: hash }]);
    expect(() => store.releasePins('admission', 'run-1')).toThrow('Pending');
    expect(store.cleanupEligibility('run-1')).toMatchObject({ allowed: false });
    persistence.sql.prepare('UPDATE execution_admissions SET state=?').run('started');
    store.releasePins('admission', 'run-1'); expect(store.pins()).toEqual([]);
  });

  it('atomically persists exact closure, prepared attempt and durable reservation before launch', () => {
    const prepared = prepare();
    expect(prepared).toMatchObject({ preparation: 'prepared', hostRef: null, outcome: null });
    expect(store.snapshot(prepared.snapshotId)).toMatchObject(snapshot());
    expect(store.pins().map(pin => pin.artifactHash).sort()).toEqual([hash, dependency]);
    expect(store.reservations()).toEqual([{ runId: 'run-1', repo: 'org/galleon', reason: 'prepared' }]);
    expect(prepare()).toEqual(prepared);
    expect(() => store.prepare({ snapshot: { ...snapshot(), task: { title: 'changed' } }, launchId: 'run-1-1', paths, maxConcurrency: 2 })).toThrow('different preparation');
    expect(() => prepare('run-2')).toThrow('already reserves');
  });

  it('rolls back all admission records when the source transaction fails', () => {
    expect(() => persistence.transaction(() => { prepare(); throw new Error('source claim failed'); })).toThrow('source claim failed');
    expect(store.recoverable()).toEqual([]); expect(store.reservations()).toEqual([]); expect(store.pins()).toEqual([]);
  });

  it('recovers prepared and uncertain launch records after restart with resources still protected', () => {
    prepare(); const owned = lease(); store.ready(owned); store.markLaunching(owned);
    store.recordAttachment(owned, 'blocked', { code: 'host-unavailable', message: 'Host cannot be reached', retryable: true, details: null });
    persistence.close(); persistence = openPersistence(join(root, 'state.sqlite')); store = openExecutionStore(persistence, () => timestamp);
    expect(store.recoverable()).toMatchObject([{ preparation: 'launching', attachment: 'blocked', outcome: null }]);
    expect(store.cleanupEligibility('run-1')).toMatchObject({ allowed: false });
    expect(() => store.releaseReservation('run-1', { unavailable: true })).toThrow('unresolved');
    expect(store.pins()).toHaveLength(2);
  });

  it('keeps attachment failure separate from execution terminal state and refuses a blind relaunch', () => {
    const attempt = prepare(); const owned = lease(); store.ready(owned); store.markLaunching(owned);
    store.recordLaunch(owned, { kind: 'detached', pid: 123 }, { launchId: attempt.launchId, startIdentity: 'owned-process' });
    store.recordAttachment(owned, 'failed', { code: 'log-unavailable', message: 'Log unavailable', retryable: true, details: null });
    expect(store.attempt(owned)?.outcome).toBeNull();
    expect(() => store.markLaunching(owned)).toThrow('cannot launch again');
    expect(() => prepare('run-1', 2)).toThrow('unresolved');
    expect(store.reservations()).toHaveLength(1);
  });

  it('rejects expired and superseded lease acknowledgments', () => {
    prepare(); const old = lease();
    expect(store.lease(old, 1000)).toBeNull();
    timestamp += 60_001;
    const current = lease();
    expect(current.generation).toBe(old.generation + 1);
    expect(() => store.ready(old)).toThrow('stale');
    expect(store.renew(old, 1000)).toBeNull();
    store.ready(current);
    expect(store.attempt(current)?.preparation).toBe('ready');
  });

  it('retains checkpoint pins after process completion and reservation release until explicit retirement', () => {
    const attempt = prepare(); const owned = lease();
    completed(owned);
    store.retainCheckpoint({ id: 'checkpoint-1', runId: owned.runId, attempt: 1, snapshotId: attempt.snapshotId, format: 'pre-pr', formatVersion: 1, artifacts: { checkpoint: '/tmp/checkpoint' }, state: 'resumable' });
    store.releasePins('execution', attempt.snapshotId);
    store.releaseReservation(owned.runId, { exited: true });
    expect(store.pins()).toHaveLength(2);
    expect(store.cleanupEligibility(owned.runId)).toMatchObject({ allowed: false });
    expect(() => store.releasePins('checkpoint', 'checkpoint-1')).toThrow('Resumable');
    store.retireCheckpoint('checkpoint-1', { actor: 'operator', reason: 'No longer needed' });
    expect(store.pins()).toEqual([]);
    expect(store.cleanupEligibility(owned.runId)).toEqual({ allowed: true });
  });

  it('only releases external operation pins after the obligation settles', () => {
    persistence.sql.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,runId TEXT,status TEXT)');
    persistence.sql.prepare('INSERT INTO operations VALUES (?,?,?)').run('operation-1', 'run-1', 'uncertain');
    store.retainPins([{ kind: 'operation', ownerId: 'operation-1', pluginId: 'example.host', artifactHash: hash }]);
    expect(() => store.releasePins('operation', 'operation-1')).toThrow('Unsettled');
    expect(store.cleanupEligibility('run-1')).toMatchObject({ allowed: false });
    persistence.sql.prepare('UPDATE operations SET status=?').run('completed');
    store.releasePins('operation', 'operation-1'); expect(store.pins()).toEqual([]);
  });

  it('rejects corrupt immutable snapshot content rather than substituting a current provider', () => {
    const attempt = prepare();
    persistence.sql.prepare('UPDATE execution_snapshots SET json=? WHERE id=?').run(JSON.stringify({ ...snapshot(), task: { title: 'tampered' } }), attempt.snapshotId);
    expect(() => store.snapshot(attempt.snapshotId)).toThrow('integrity');
  });

  it('rejects missing closure dependencies, dependency cycles, nullable bindings and credential values', () => {
    const input = snapshot();
    for (const value of [
      { ...input, artifacts: [input.artifacts[0]] },
      { ...input, artifacts: [input.artifacts[0], { ...input.artifacts[1], requires: ['example.host'] }] },
      { ...input, bindings: [null] },
      { ...input, settings: { apiToken: 'raw-credential' } },
    ]) expect(() => store.prepare({ snapshot: value as ExecutionSnapshotInput, launchId: 'invalid', paths, maxConcurrency: 1 })).toThrow();
    expect(store.pins()).toEqual([]);
  });

  it('does not let completion overwrite conflicting terminal evidence or release unresolved pins', () => {
    const attempt = prepare(); const owned = lease();
    expect(() => store.releasePins('execution', attempt.snapshotId)).toThrow('Unresolved');
    completed(owned);
    expect(() => store.recordOutcome(owned, { status: 'failed', endedAt: new Date(timestamp).toISOString(), evidence: { code: 1 } })).toThrow('different terminal');
  });

  it('recovers terminal process evidence until core finalization and resource obligations settle', () => {
    const attempt = prepare(); const owned = lease(); completed(owned);
    expect(store.recoverable()).toMatchObject([{ outcome: { status: 'succeeded' } }]);
    store.releasePins('execution', attempt.snapshotId);
    expect(store.recoverable()).toHaveLength(1);
    store.releaseReservation(owned.runId, { exit: 0 });
    expect(store.recoverable()).toEqual([]);
    persistence.sql.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,attempt INTEGER,status TEXT)');
    persistence.sql.prepare('INSERT INTO runs VALUES(?,?,?)').run(owned.runId, owned.attempt, 'running');
    expect(store.recoverable()).toHaveLength(1);
    persistence.sql.prepare("UPDATE runs SET status='succeeded'").run();
    expect(store.recoverable()).toEqual([]);
  });

  it('validates the finalization lease within its shared transaction', () => {
    prepare(); const stale = lease(); timestamp += 60_001; lease();
    expect(() => persistence.transaction(() => store.assertLease(stale))).toThrow('stale');
  });
});
