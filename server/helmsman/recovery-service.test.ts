// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type RunRow } from './db';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { openOperationStore } from './operations';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceRegistry } from './task-sources/registry';
import { createSourceAdmissionCoordinator } from './task-sources/admission';
import { createTaskSourceService } from './task-source-service';
import { todosProvider } from '../../src/plugins/todos/provider';
import { createRecoveryService, readRecoverySnapshot, type RecoveryCallbacks } from './recovery-service';

const roots: string[] = [];
const connections = new Set<Persistence>();
afterEach(() => {
  for (const connection of connections) connection.close(); connections.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const artifact = { pluginId: 'example.host', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
const helper = { pluginId: 'example.helper', artifactHash: 'b'.repeat(64), packageVersion: '1', requires: [] };
const binding = { role: 'host' as const, capability: 'host', contractVersion: 1, contributionId: 'example.host/detached',
  pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: 'private-connection', credentialHandle: 'private-credential' };
function run(id = 'voyage1', repo = 'org/a'): RunRow {
  return { id, repo, attempt: 1, status: 'running', ticketId: 'private-ticket', adapter: 'test',
    prNumber: null, costUsd: null, startedAt: new Date().toISOString(), endedAt: null, worktreePath: '/private/work', taskJson: '{"private":"task"}' };
}
function fixture(callbacks: RecoveryCallbacks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recovery-service-')); roots.push(root);
  const path = join(root, 'state.sqlite');
  const persistence = openPersistence(path); connections.add(persistence);
  const db = openDb(persistence.sql);
  const executions = openExecutionStore(persistence);
  const admissions = openAdmissionStore(persistence, executions);
  const operations = openOperationStore(persistence, executions);
  const lifecycle = { list: () => [{ pluginId: artifact.pluginId, artifactHash: artifact.artifactHash,
    desiredEnabled: false, health: 'inactive' as const, state: 'draining' as const, diagnostic: null, revision: 1, obligationsOnly: true }] };
  function prepare(id = 'voyage1', repo = 'org/a') {
    db.insertRun(run(id, repo));
    const snapshot: ExecutionSnapshotInput = { version: 1, runId: id, attempt: 1, repo,
      logicalWork: { source: 'todo', instance: 'local', taskId: 'private-ticket' }, task: { body: 'private-task' },
      workflowSnapshotId: null, artifacts: [artifact, helper], bindings: [binding], settings: { internal: 'private-settings' },
      schemas: [], provenance: { kind: 'admission', evidence: { value: 'private-provenance' } } };
    return executions.prepare({ snapshot, launchId: `${id}-launch`, maxConcurrency: 10,
      paths: { worktree: '/private/work', log: '/private/log', exit: '/private/exit', spec: '/private/spec' } });
  }
  function operation(runId: string | null = 'voyage1') {
    return operations.enqueue({ version: 1, key: `${runId}-review`, kind: 'github.review',
      origin: { kind: 'run', id: runId ?? 'manual', revision: '1', runId, attempt: runId ? 1 : null }, binding: { ...binding, role: 'effect' },
      artifacts: [artifact], target: { repo: 'org/a', secret: 'private-target' }, payload: { body: 'private-payload' } });
  }
  const taskSources = openTaskSourceStore(persistence);
  const service = createRecoveryService({ db, executions, admissions, operations, lifecycle, callbacks, taskSources });
  return { root, path, persistence, db, executions, admissions, operations, taskSources, service, prepare, operation,
    close() { persistence.close(); connections.delete(persistence); } };
}

it('projects terminal unfinished executions, legacy rows, retained obligations, and redacted evidence', () => {
  const f = fixture({ retryAttachment: vi.fn(), reconcileOperation: vi.fn(), retireCheckpoint: vi.fn() });
  const attempt = f.prepare(); const lease = f.executions.lease(attempt, 60_000)!;
  f.executions.recordAttachment(lease, 'blocked', { code: 'host-unavailable', message: 'private-message', retryable: true, details: { token: 'private-token' } });
  f.executions.recordOutcome(lease, { status: 'failed', endedAt: new Date().toISOString(), evidence: { secret: 'private-exit-evidence' } });
  f.executions.retainCheckpoint({ id: 'checkpoint1', runId: 'voyage1', attempt: 1, snapshotId: attempt.snapshotId,
    format: 'pre-pr', formatVersion: 1, state: 'resumable', artifacts: { path: '/private/checkpoint' } });
  f.db.insertRun(run('legacy1', 'org/legacy'));
  f.operation();
  const value = f.service.snapshot();
  expect(value.errors).toEqual([]);
  expect(value.attempts).toMatchObject([{ runId: 'voyage1', processStatus: 'failed', protected: true, actions: ['retry-attachment'] }]);
  expect(value.runs.find(item => item.id === 'legacy1')).toMatchObject({ attachment: 'blocked', actions: [] });
  expect(value.checkpoints).toHaveLength(1);
  expect(value.operations[0]).toMatchObject({ providerId: 'example.host/detached', evidence: [{ kind: 'enqueued', hasEvidence: true }] });
  expect(value.lifecycle[0]?.blockers).toHaveLength(3);
  expect(JSON.stringify(value)).not.toMatch(/private-|\/private\//);
});

it('scopes executions, snapshot pins, admissions, operations, and lifecycle obligations to the selected galleon', () => {
  const f = fixture(); const first = f.prepare(); f.prepare('voyage2', 'org/b');
  f.operation(); f.operation('voyage2');
  f.admissions.admit({ runId: 'admission1', repo: 'org/c', request: {}, settings: {}, artifacts: [artifact] }, 10);
  const selected = f.service.snapshot('ORG/A');
  expect(selected.errors).toEqual([]);
  expect(selected.runs.map(item => item.id)).toEqual(['voyage1']);
  expect(selected.admissions).toEqual([]);
  expect(selected.pins.filter(item => item.kind === 'execution').map(item => item.ownerId)).toEqual([first.snapshotId, first.snapshotId]);
  expect(selected.operations.map(item => item.runId)).toEqual(['voyage1']);
  expect(JSON.stringify(selected)).not.toMatch(/voyage2|admission1/);
  expect(() => f.service.snapshot('bad')).toThrow('Invalid galleon');
});

it('routes narrow callbacks and rejects rebinding, unsupported actions, and non-JSON evidence', async () => {
  const callbacks = { retryAttachment: vi.fn(), reconcileOperation: vi.fn(), cancelAdmission: vi.fn(), retireCheckpoint: vi.fn(), resolveOperation: vi.fn() };
  const f = fixture(callbacks); const attempt = f.prepare();
  const op = f.operation(); const lease = f.operations.lease(op.id, 60_000)!;
  f.operations.settle(lease, { status: 'unknown', reason: 'Uncertain', evidence: {} });
  f.admissions.admit({ runId: 'admission1', repo: 'org/b', request: {}, settings: {}, artifacts: [artifact] }, 10);
  f.executions.retainCheckpoint({ id: 'checkpoint1', runId: 'voyage1', attempt: 1, snapshotId: attempt.snapshotId,
    format: 'pre-pr', formatVersion: 1, state: 'resumable', artifacts: {} });
  const resolution = { actor: 'operator', reason: 'Verified remotely', evidence: { receipt: 1 } };
  await f.service.act({ action: 'retry-attachment', runId: 'voyage1' });
  await f.service.act({ action: 'reconcile-operation', id: op.id });
  await f.service.act({ action: 'cancel-admission', runId: 'admission1', ...resolution });
  await f.service.act({ action: 'retire-checkpoint', id: 'checkpoint1', ...resolution });
  await f.service.act({ action: 'resolve-operation', id: op.id, ...resolution, outcome: 'acknowledged' });
  expect(callbacks.retryAttachment).toHaveBeenCalledExactlyOnceWith('voyage1');
  expect(callbacks.reconcileOperation).toHaveBeenCalledExactlyOnceWith(op.id);
  expect(callbacks.cancelAdmission).toHaveBeenCalledExactlyOnceWith('admission1', resolution);
  expect(callbacks.retireCheckpoint).toHaveBeenCalledExactlyOnceWith('checkpoint1', resolution);
  expect(callbacks.resolveOperation).toHaveBeenCalledExactlyOnceWith(op.id, { ...resolution, outcome: 'acknowledged' });
  await expect(f.service.act({ action: 'resolve-operation', id: op.id, ...resolution, outcome: 'acknowledged', binding: {} })).rejects.toMatchObject({ status: 400 });
  await expect(f.service.act({ action: 'retire-checkpoint', id: 'checkpoint1', ...resolution, evidence: null })).rejects.toMatchObject({ status: 400 });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await expect(f.service.act({ action: 'retire-checkpoint', id: 'checkpoint1', ...resolution, evidence: cycle })).rejects.toMatchObject({ status: 400 });
  const getter = vi.fn(() => 'oops');
  await expect(f.service.act(Object.defineProperty({}, 'action', { get: getter }))).rejects.toMatchObject({ status: 400 });
  expect(getter).not.toHaveBeenCalled();
  await expect(f.service.act({ action: 'migrate-checkpoint', id: 'checkpoint1' })).rejects.toMatchObject({ status: 400 });
  await expect(f.service.act({ action: 'retry-attachment', runId: 'absent' })).rejects.toMatchObject({ status: 409 });
});

it('does not offer mutation callbacks that the host has not provided', async () => {
  const f = fixture(); f.prepare(); f.operation();
  expect(f.service.snapshot().attempts[0]?.actions).toEqual([]);
  expect(f.service.snapshot().operations[0]?.actions).toEqual([]);
  await expect(f.service.act({ action: 'retry-attachment', runId: 'voyage1' })).rejects.toMatchObject({ status: 409 });
});

it('opens safe-start metadata without migrations or modifying files and preserves partial diagnostics', () => {
  const f = fixture(); const attempt = f.prepare(); f.operation();
  const lease = f.executions.lease(attempt, 60_000)!;
  f.executions.recordOutcome(lease, { status: 'failed', endedAt: new Date().toISOString(), evidence: {} });
  f.persistence.sql.prepare('INSERT INTO execution_attempts(runId,attempt,snapshotId,launchId,json) VALUES (?,?,?,?,?)').run('broken', 1, 'broken', 'broken', 'invalid-json');
  f.persistence.sql.pragma('wal_checkpoint(TRUNCATE)'); f.close();
  const before = readFileSync(f.path); const names = readdirSync(f.root);
  const value = readRecoverySnapshot(f.path, 'org/a');
  expect(value.mode).toBe('safe-start'); expect(value.readOnly).toBe(true);
  expect(value.attempts).toMatchObject([{ runId: 'voyage1', processStatus: 'failed', actions: [] }]);
  expect(value.errors).toEqual(['Execution metadata is incomplete or invalid.']);
  expect(value.operations[0]?.actions).toEqual([]);
  expect(JSON.stringify(value)).not.toMatch(/private-|\/private\//);
  expect(readFileSync(f.path)).toEqual(before); expect(readdirSync(f.root)).toEqual(names);
});

it('does not lose scoped records behind unrelated history and reports output truncation', () => {
  const f = fixture();
  f.persistence.transaction(() => {
    for (let index = 0; index < 1002; index++) f.db.insertRun(run(`history${index}`, 'org/history'));
    f.prepare();
  });
  expect(readRecoverySnapshot(f.path, 'org/a').runs.map(item => item.id)).toEqual(['voyage1']);
  expect(readRecoverySnapshot(f.path, 'org/history')).toMatchObject({ truncated: true, runs: expect.any(Array) });
  expect(readRecoverySnapshot(f.path, 'org/history').runs).toHaveLength(1000);
});

it('handles missing and corrupt safe-start databases without creating or replacing files', () => {
  const f = fixture(); const missing = join(f.root, 'missing.sqlite');
  expect(readRecoverySnapshot(missing)).toMatchObject({ readOnly: true, runs: [], errors: [] });
  expect(existsSync(missing)).toBe(false);
  const corrupt = join(f.root, 'corrupt.sqlite'); writeFileSync(corrupt, 'not a database');
  expect(readRecoverySnapshot(corrupt).errors.length).toBeGreaterThan(0);
  expect(readFileSync(corrupt, 'utf8')).toBe('not a database');
});

it('offers stop only for an attached nonterminal process and preserves durable ownership after requesting it', async () => {
  const requestStop = vi.fn(); const f = fixture({ requestStop }); const attempt = f.prepare();
  await expect(f.service.act({ action: 'stop-execution', runId: 'voyage1' })).rejects.toMatchObject({ status: 409 });
  const lease = f.executions.lease(attempt, 60_000)!;
  f.executions.ready(lease); f.executions.markLaunching(lease);
  f.executions.recordLaunch(lease, { kind: 'detached', pid: 123 }, {});
  f.executions.recordAttachment(lease, 'attached', null);
  expect(f.service.snapshot().attempts[0]?.actions).toEqual(['stop-execution']);
  await f.service.act({ action: 'stop-execution', runId: 'voyage1' });
  expect(requestStop).toHaveBeenCalledExactlyOnceWith('voyage1');
  expect(f.executions.reservations()).toHaveLength(1);
  expect(f.executions.attempt(attempt)?.outcome).toBeNull();
  f.executions.recordOutcome(lease, { status: 'stopped', endedAt: new Date().toISOString(), evidence: {} });
  expect(f.service.snapshot().attempts[0]?.actions).toEqual([]);
});

it('reads committed WAL records without changing source database or sidecars', () => {
  const f = fixture(); f.prepare(); f.operation();
  const files = readdirSync(f.root);
  const before = files.map(name => [name, readFileSync(join(f.root, name))] as const);
  const value = readRecoverySnapshot(f.path);
  expect(value.errors).toEqual([]);
  expect(value.attempts).toHaveLength(1); expect(value.operations).toHaveLength(1);
  for (const [name, content] of before) expect(readFileSync(join(f.root, name))).toEqual(content);
  expect(readdirSync(f.root)).toEqual(files);
});


it('scopes manual Slack and review operations through their validated immutable target galleon', () => {
  const f = fixture(); const operation = f.operation(null);
  expect(f.service.snapshot('org/a').operations).toMatchObject([{ id: operation.id, runId: null }]);
  expect(f.service.snapshot('org/b').operations).toEqual([]);
  expect(f.service.snapshot('org/a').pins).toMatchObject([{ kind: 'operation', ownerId: operation.id }]);
  expect(readRecoverySnapshot(f.path, 'org/a').operations).toMatchObject([{ id: operation.id, runId: null }]);
});


it('exposes failed local source settlement without changing successful worker outcomes, and scopes retained source pins', async () => {
  const retrySourceSettlement = vi.fn(); const f = fixture({ retrySourceSettlement });
  const binding = { providerId: 'example.host/todos', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  const provisioned = f.taskSources.provision({ provisioningKey: 'local', label: 'Local work', storageLayout: 'documents', collectionId: 'collection-1',
    identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'collection-1', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: new Date().toISOString(), proof: null }, binding, settings: {}, allowedRepos: ['org/a'] });
  f.persistence.transaction(() => writeTaskSource(f.taskSources, { ...provisioned.source, conversionReady: true }));
  const registry = createTaskSourceRegistry({ eligible: () => true });
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] },
    { ...todosProvider, planCompletion: async () => { throw new Error('Local provider unavailable'); } })]);
  const local = openLocalSourceAdapter(f.taskSources);
  const service = createTaskSourceService({ store: f.taskSources, registry, local, http: () => { throw new Error('Unexpected HTTP'); } });
  const admission = createSourceAdmissionCoordinator({ store: f.taskSources, registry, local, context: service.context });
  const signal = AbortSignal.timeout(1000);
  const created = await service.command({ instanceId: provisioned.instance.id, instanceRevision: 1, repo: 'org/a', commandId: 'create', requestId: 'todo-1', input: { title: 'Implement', description: 'Preserved requirements', repo: 'org/a' } }, signal);
  const reserved = admission.reserve({ ref: created!.ref, repo: 'org/a', admissionId: 'source-voyage', runId: 'source-voyage', instanceId: provisioned.instance.id, expectedInstanceRevision: 1, expectedSourceRevision: 1 }, () => {});
  const prepared = await admission.prepare({ claimId: reserved.id, repo: 'org/a', signal });
  const claim = admission.commit(prepared, value => value);
  f.db.insertRun({ ...run('source-voyage'), status: 'succeeded' });
  f.executions.retainPins([{ kind: 'dependency', ownerId: `source-claim:${claim.id}`, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash }]);
  await expect(admission.prepareSettlement({ claimId: claim.id, repo: 'org/a', signal, purpose: 'completion', request: {
    runId: claim.runId, attempt: 1, task: prepared.task, claimReceipt: claim.receipt!, outcome: 'succeeded', publication: null,
  } })).rejects.toThrow('Local provider unavailable');
  const projection = f.service.snapshot('org/a');
  expect(projection.sourceClaims).toMatchObject([{ claimId: claim.id, runId: 'source-voyage', repo: 'org/a', sourceId: provisioned.source.id,
    providerId: binding.providerId, state: 'settling', processStatus: 'succeeded', settlementReason: expect.stringContaining('pending'), actions: ['retry-source-settlement'] }]);
  expect(projection.pins).toMatchObject([{ kind: 'dependency', ownerId: `source-claim:${claim.id}` }]);
  expect(f.service.snapshot('org/b').sourceClaims).toEqual([]); expect(f.service.snapshot('org/b').pins).toEqual([]);
  await f.service.act({ action: 'retry-source-settlement', claimId: claim.id });
  expect(retrySourceSettlement).toHaveBeenCalledExactlyOnceWith(claim.id);
  expect(f.db.getRun(claim.runId)?.status).toBe('succeeded');
  expect(f.taskSources.claim(claim.id)?.state).toBe('settling');
  await expect(f.service.act({ action: 'retry-source-settlement', claimId: claim.id, outcome: 'failed' })).rejects.toMatchObject({ status: 400 });
  const files = readdirSync(f.root); const before = files.map(name => [name, readFileSync(join(f.root, name))] as const);
  const readonly = readRecoverySnapshot(f.path, 'org/a');
  expect(readonly.sourceClaims).toMatchObject([{ claimId: claim.id, processStatus: 'succeeded', actions: [] }]);
  expect(readonly.pins).toMatchObject([{ kind: 'dependency', ownerId: `source-claim:${claim.id}` }]);
  expect(readRecoverySnapshot(f.path, 'org/b').sourceClaims).toEqual([]);
  for (const [name, bytes] of before) expect(readFileSync(join(f.root, name))).toEqual(bytes);
  expect(readdirSync(f.root)).toEqual(files);
});

function retainedSourceClaim(f: ReturnType<typeof fixture>, runId: string) {
  const source = f.taskSources.provision({ provisioningKey: 'source', label: 'Source', storageLayout: 'documents', collectionId: 'retained-collection',
    identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'retained-collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: new Date().toISOString(), proof: null },
    binding: { providerId: 'example.host/todos', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null }, settings: {}, allowedRepos: ['org/a'] });
  writeTaskSource(f.taskSources, { ...source.source, conversionReady: true });
  return f.taskSources.reserveWork({ ref: { sourceId: source.source.id, externalId: 'task-1' }, admissionId: runId, runId, instanceId: source.instance.id, expectedSourceRevision: 1, expectedInstanceRevision: 1 });
}
it('offers source recovery for failed unstarted admissions while retaining source ownership', async () => {
  const retrySourceSettlement = vi.fn(); const f = fixture({ retrySourceSettlement });
  f.admissions.admit({ runId: 'unstarted-source', repo: 'org/a', request: {}, settings: {}, artifacts: [artifact] }, 10);
  const claim = retainedSourceClaim(f, 'unstarted-source');
  expect(f.service.snapshot('org/a').sourceClaims[0]?.actions).toEqual([]);
  f.admissions.fail('unstarted-source', 'Preflight failed before settlement planning');
  expect(f.service.snapshot('org/a').sourceClaims).toMatchObject([{ claimId: claim.id, processStatus: null, actions: ['retry-source-settlement'] }]);
  await f.service.act({ action: 'retry-source-settlement', claimId: claim.id });
  expect(retrySourceSettlement).toHaveBeenCalledExactlyOnceWith(claim.id);
  expect(f.taskSources.claim(claim.id)?.state).toBe('reserved');
});
it('withholds source retry actions while a worker is running or a checkpoint remains resumable', () => {
  const f = fixture({ retrySourceSettlement: vi.fn() }); const attempt = f.prepare();
  const claim = retainedSourceClaim(f, 'voyage1'); f.taskSources.beginSettlement(claim.id, claim.revision);
  expect(f.service.snapshot().sourceClaims[0]?.actions).toEqual([]);
  f.db.updateRun('voyage1', { status: 'succeeded' });
  f.executions.retainCheckpoint({ id: 'voyage1:1:pre-pr', runId: 'voyage1', attempt: 1, snapshotId: attempt.snapshotId, format: 'pre-pr', formatVersion: 1, state: 'resumable', artifacts: {} });
  expect(f.service.snapshot().sourceClaims[0]?.actions).toEqual([]);
});
it('flags conflicting source claim indexes in safe-start instead of projecting misleading ownership', () => {
  const f = fixture(); f.db.insertRun(run('source-run')); const claim = retainedSourceClaim(f, 'source-run');
  f.persistence.sql.prepare('UPDATE work_claims SET externalId=? WHERE id=?').run('another-task', claim.id);
  const snapshot = readRecoverySnapshot(f.path, 'org/a');
  expect(snapshot.sourceClaims).toEqual([]); expect(snapshot.errors).toContain('Source claim metadata is incomplete or invalid.');
});

it('rejects tampered source snapshot scope during safe-start recovery', () => {
  const f = fixture(); const claim = retainedSourceClaim(f, 'missing-run');
  const snapshot = f.taskSources.retainTaskSnapshot({ version: 1, ref: claim.ref, revision: '1', displayKey: 'TASK-1', title: 'Work', repo: 'org/a', url: null, state: 'ready', priority: 2,
    requirements: { description: 'Do work', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } }, claim.instance);
  f.taskSources.acknowledgeClaim({ claimId: claim.id, expectedRevision: 1, taskSnapshotHash: snapshot.hash, localRecordRevision: null, operations: [] });
  expect(readRecoverySnapshot(f.path, 'org/a').sourceClaims).toHaveLength(1);
  f.persistence.sql.prepare("UPDATE source_task_snapshots SET json=json_set(json,'$.task.repo',?) WHERE hash=?").run('org/b', snapshot.hash);
  const projected = readRecoverySnapshot(f.path, 'org/b');
  expect(projected.sourceClaims).toEqual([]); expect(projected.errors).toContain('Source claim metadata is incomplete or invalid.');
});
