import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTask } from './agents/adapter';
import { openAdmissionStore } from './admission-store';
import { openDb, type RunRow } from './db';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { openPersistence, acknowledgePersistenceIntent, pendingPersistenceIntents } from './persistence';
import { createRunnerDurability } from './runner-durability';
import { openTodoStore } from './todos';
import { openOperationStore } from './operations';
import { openPluginLifecycle } from './plugins/lifecycle';

const artifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
const task: AgentTask = { repo: 'owner/repo', ticketId: 'TODO-1', title: 'Durability', jiraBaseUrl: '', task: 'Implement' };
const run: RunRow = { id: 'voyage', repo: task.repo, ticketId: task.ticketId, adapter: 'codex', status: 'running', attempt: 1,
  startedAt: '2026-09-20T00:00:00.000Z', endedAt: null, prNumber: null, costUsd: null, worktreePath: null };
function snapshot(row: RunRow): ExecutionSnapshotInput {
  return { version: 1, runId: row.id, attempt: row.attempt, repo: row.repo, logicalWork: { source: 'todos', instance: 'local', taskId: task.ticketId },
    task: {}, workflowSnapshotId: null, artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
    bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId,
      artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] };
}
const opened: ReturnType<typeof openPersistence>[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
function setup(finalize?: () => void) {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const db = openDb(persistence.sql);
  const executions = openExecutionStore(persistence);
  const admissions = openAdmissionStore(persistence, executions);
  const operations = openOperationStore(persistence, executions);
  const coordinator = createRunnerDurability({ persistence, db, executions, admissions, operations, runsDir: '/runs', maxConcurrency: 1,
    snapshot, verify: async () => {}, finalize });
  return { persistence, db, executions, admissions, operations, coordinator };
}

describe('durable admission and runner integration', () => {
  it('continues an identical retained checkpoint while its plugin drains', async () => {
    const { persistence, db, executions } = setup();
    const lifecycle = openPluginLifecycle(persistence, executions);
    lifecycle.registerArtifact({ artifact, schemas: [] });
    lifecycle.apply({ id: 'enable-runtime', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, expectedRevision: 0, desiredEnabled: true, drainDependents: [] });
    for (const intent of pendingPersistenceIntents(persistence)) for (const target of intent.targets) acknowledgePersistenceIntent(persistence, intent.id, target);
    lifecycle.recordHealth(artifact.pluginId, artifact.artifactHash, 'active', null);
    const coordinator = createRunnerDurability({ persistence, db, executions, lifecycle, runsDir: '/runs', maxConcurrency: 1, snapshot, verify: async () => {} });
    const first = await coordinator.prepare({ ...run, adapter: 'pre-pr:codex' }, task);
    first.ready('/worktree'); first.terminal({ status: 'failed', exitCode: 1, evidence: { launchId: first.launchId } });
    first.finalize({ ...db.getRun(run.id)!, status: 'failed' }); first.close();
    lifecycle.apply({ id: 'disable-runtime', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, expectedRevision: 1, desiredEnabled: false, drainDependents: [] });
    expect(() => persistence.transaction(() => lifecycle.assertAdmission(snapshot(run)))).toThrow('denies new admissions');
    const resumed = await coordinator.prepare({ ...run, adapter: 'pre-pr:codex', attempt: 2 }, { ...task,
      prePrResume: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), branch: 'work', round: 1, reviewerReports: {}, metadataPath: '/metadata' } });
    expect(db.getRun(run.id)?.attempt).toBe(2);
    resumed.close();
  });

  it('commits a source claim with its admission and keeps preflight crashes reserved', () => {
    const { persistence, admissions, executions } = setup();
    const todos = openTodoStore(persistence.sql);
    const todo = todos.create({ repo: task.repo, title: task.title, description: 'Persist the claim' });
    const input = { runId: run.id, repo: run.repo, request: { mode: 'todo', todoId: todo.id }, settings: {}, artifacts: [artifact] };
    expect(() => persistence.transaction(() => {
      admissions.admit(input, 1); todos.claim(todo.id, run.id); throw new Error('fault');
    })).toThrow('fault');
    expect(admissions.get(run.id)).toBeNull();
    expect(executions.reservations()).toEqual([]);
    expect(todos.get(todo.id)?.state).toBe('todo');
    persistence.transaction(() => { admissions.admit(input, 1); todos.claim(todo.id, run.id); });
    admissions.block(run.id, 'Restart interrupted preflight');
    expect(executions.reservations()).toHaveLength(1);
    expect(executions.pins()).toHaveLength(1);
    expect(executions.cleanupEligibility(run.id).allowed).toBe(false);
    expect(() => admissions.admit({ ...input, runId: 'other' }, 1)).toThrow();
    expect(() => admissions.admit({ ...input, request: { mode: 'changed' } }, 1)).toThrow('different content');
    admissions.fail(run.id, 'Operator cancelled preflight; no attempt exists');
    expect(executions.reservations()).toEqual([]);
    expect(executions.pins()).toEqual([]);
  });

  it('transfers admission pins to a prepared execution before exposing launch', async () => {
    const { admissions, executions, coordinator, db } = setup();
    admissions.admit({ runId: run.id, repo: run.repo, request: {}, settings: {}, artifacts: [artifact] }, 1);
    const attempt = await coordinator.prepare(run, task);
    expect(admissions.get(run.id)?.state).toBe('started');
    expect(executions.pins().map(pin => pin.kind)).toEqual(['execution']);
    expect(db.getRun(run.id)?.logPath).toBe('/runs/voyage.attempt-1.log');
    attempt.ready('/worktree'); attempt.launching();
    attempt.attachment('blocked', 'Spawn result was lost');
    attempt.close();
    expect(db.getRun(run.id)?.status).toBe('running');
    expect(executions.reservations()).toHaveLength(1);
    expect(coordinator.cleanupEligibility(run.id).allowed).toBe(false);
    expect(() => admissions.fail(run.id, 'Do not erase ambiguous launch')).toThrow();
  });

  it('leaves pins and terminal projection intact when final obligations fail to commit', async () => {
    let fail = true;
    const { coordinator, executions, db } = setup(() => { if (fail) throw new Error('outbox unavailable'); });
    const attempt = await coordinator.prepare(run, task);
    attempt.ready('/worktree'); attempt.launching();
    attempt.launched({ kind: 'detached', pid: 123 }, { launchId: attempt.launchId });
    attempt.terminal({ status: 'succeeded', exitCode: 0, evidence: { launchId: attempt.launchId } });
    expect(() => attempt.finalize({ ...db.getRun(run.id)!, status: 'succeeded' })).toThrow('outbox unavailable');
    expect(db.getRun(run.id)?.status).toBe('running');
    expect(executions.pins()).toHaveLength(1);
    expect(executions.reservations()).toHaveLength(1);
    fail = false;
    attempt.finalize({ ...db.getRun(run.id)!, status: 'succeeded' });
    expect(db.getRun(run.id)?.status).toBe('succeeded');
    expect(executions.pins()).toEqual([]);
    expect(coordinator.cleanupEligibility(run.id).allowed).toBe(true);
    attempt.close();
  });

  it('retains failed pre-PR checkpoint artifacts after releasing process capacity', async () => {
    const { coordinator, executions, db } = setup();
    const attempt = await coordinator.prepare({ ...run, adapter: 'pre-pr:codex' }, task);
    attempt.ready('/worktree'); attempt.launching();
    attempt.launched({ kind: 'detached', pid: 123 }, { launchId: attempt.launchId });
    attempt.terminal({ status: 'failed', exitCode: 1, evidence: { launchId: attempt.launchId } });
    attempt.finalize({ ...db.getRun(run.id)!, status: 'failed' });
    expect(executions.reservations()).toEqual([]);
    expect(executions.pins().map(pin => pin.kind)).toEqual(['checkpoint']);
    expect(coordinator.cleanupEligibility(run.id).allowed).toBe(false);
    expect(executions.checkpoint('voyage:1:pre-pr')?.format).toBe('helmsman.pre-pr.pending-validation');
    attempt.close();
  });
  it('blocks an attempt advance until its immutable external obligations settle', async () => {
    const { coordinator, executions, db, operations } = setup();
    const first = await coordinator.prepare(run, task);
    first.ready('/worktree');
    first.terminal({ status: 'failed', exitCode: 1, evidence: { launchId: first.launchId } });
    const retained = executions.snapshot(executions.attempt({ runId: run.id, attempt: 1 })!.snapshotId)!;
    const operation = operations.enqueue({ version: 1, key: 'lost-publication', kind: 'github.review',
      origin: { kind: 'run-review', id: retained.id, revision: retained.contentHash, runId: run.id, attempt: 1 },
      artifacts: retained.artifacts, binding: { ...retained.bindings[0]!, role: 'effect' }, target: { repo: run.repo }, payload: {} });
    first.finalize({ ...db.getRun(run.id)!, status: 'failed' }); first.close();
    await expect(coordinator.prepare({ ...run, attempt: 2 }, task)).rejects.toThrow('external operations');
    expect(db.getRun(run.id)?.attempt).toBe(1);
    expect(executions.attempt({ runId: run.id, attempt: 2 })).toBeNull();
    const lease = operations.lease(operation.id, 60_000)!;
    operations.markInvoked(lease);
    operations.settle(lease, { status: 'acknowledged', receipt: { id: 'verified' } });
    const next = await coordinator.prepare({ ...run, attempt: 2 }, task);
    expect(db.getRun(run.id)?.attempt).toBe(2);
    next.close();
  });

});

describe('coordinator shutdown', () => {
  it('releases only its held lease without stopping the worker or releasing reservations and pins', async () => {
    const { persistence, db, executions, coordinator } = setup(); const shutdown = new AbortController();
    const departing = createRunnerDurability({ persistence, db, executions, runsDir: '/runs', maxConcurrency: 1, snapshot, verify: async () => {}, shutdownSignal: shutdown.signal });
    const first = await departing.prepare(run, task); first.ready('/worktree'); first.launching(); first.launched({ kind: 'detached', pid: 123 }, { launchId: first.launchId });
    const before = executions.attempt({ runId: run.id, attempt: run.attempt }); const pins = executions.pins();
    await expect(coordinator.recover(db.getRun(run.id)!)).rejects.toThrow('Another coordinator');
    shutdown.abort(); expect(() => first.assertActive?.()).toThrow(); expect(() => first.renew()).toThrow();
    expect(executions.attempt({ runId: run.id, attempt: run.attempt })).toEqual(before); expect(executions.pins()).toEqual(pins); expect(executions.reservations()).toHaveLength(1);
    const next = await coordinator.recover(db.getRun(run.id)!); expect(next.launchId).toBe(first.launchId); expect(() => next.assertActive?.()).not.toThrow(); next.close();
    expect(() => first.close()).not.toThrow();
  });

  it('never clears a replacement coordinator lease when the old shutdown arrives after expiry', async () => {
    const { persistence, db, executions, coordinator } = setup(); const shutdown = new AbortController();
    const departing = createRunnerDurability({ persistence, db, executions, runsDir: '/runs', maxConcurrency: 1, snapshot, verify: async () => {}, shutdownSignal: shutdown.signal });
    await departing.prepare(run, task);
    persistence.sql.prepare('UPDATE execution_attempts SET leaseExpiresAt=? WHERE runId=?').run('2000-01-01T00:00:00.000Z', run.id);
    const next = await coordinator.recover(db.getRun(run.id)!);
    const lease = persistence.sql.prepare('SELECT leaseToken,leaseGeneration FROM execution_attempts WHERE runId=?').get(run.id);
    expect(() => shutdown.abort()).not.toThrow();
    expect(persistence.sql.prepare('SELECT leaseToken,leaseGeneration FROM execution_attempts WHERE runId=?').get(run.id)).toEqual(lease);
    expect(() => next.renew()).not.toThrow(); next.close();
  });

  it('fences new preparation and recovery awaiting asynchronous verification', async () => {
    const { persistence, db, executions, coordinator } = setup(); const first = await coordinator.prepare(run, task); first.close();
    const shutdown = new AbortController(); let verified!: () => void;
    const pending = new Promise<void>(resolve => { verified = resolve; });
    const departing = createRunnerDurability({ persistence, db, executions, runsDir: '/runs', maxConcurrency: 1, snapshot, verify: () => pending, shutdownSignal: shutdown.signal });
    const recovery = expect(departing.recover(db.getRun(run.id)!)).rejects.toThrow(); shutdown.abort(); verified(); await recovery;
    expect(persistence.sql.prepare('SELECT leaseToken FROM execution_attempts WHERE runId=?').get(run.id)).toEqual({ leaseToken: null });
    await expect(departing.prepare({ ...run, id: 'never-created', repo: 'owner/other' }, task)).rejects.toThrow(); expect(db.getRun('never-created')).toBeNull();
  });

  it('does not acquire a lease when the prepared snapshot is unavailable', async () => {
    const { persistence, db, executions } = setup();
    const unavailable = createRunnerDurability({ persistence, db, executions: { ...executions, snapshot: () => null }, runsDir: '/runs', maxConcurrency: 1, snapshot, verify: async () => {} });
    await expect(unavailable.prepare(run, task)).rejects.toThrow('snapshot is unavailable');
    expect(persistence.sql.prepare('SELECT leaseToken FROM execution_attempts WHERE runId=?').get(run.id)).toEqual({ leaseToken: null });
  });
});
