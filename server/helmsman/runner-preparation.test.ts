// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRunLifetime } from './run-lifetime';
import { join } from 'node:path';
import { openPersistence } from './persistence';
import { openDb, type RunRow } from './db';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { createRunnerDurability } from './runner-durability';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { RunBus } from './event-bus';
import type { LaunchSpec } from './run-host';
import { installPluginArtifact } from './plugins/artifacts';
import { loadRetainedAgentProvider } from './agent-retained-loader';
import { parseAgentRetainedProviderV1 } from './agent-providers';
import { agentProviderAdapter } from './agents/provider';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function temporary() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-settlement-'))); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; }

const artifact = { pluginId: 'audit.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
const task = { repo: 'owner/repo', ticketId: 'task-1', title: 'Audit', jiraBaseUrl: '', task: 'local test' };
function snapshot(run: RunRow): ExecutionSnapshotInput {
  return { version: 1, runId: run.id, attempt: run.attempt, repo: run.repo, logicalWork: { source: 'audit', instance: 'local', taskId: task.ticketId }, task, workflowSnapshotId: null,
    artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
    bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] };
}

it('settles a definite checkout failure and retains that evidence after restart', async () => {
  const root = temporary(); const path = join(root, 'state.sqlite'); let persistence = openPersistence(path);
  cleanups.push(() => persistence.close());
  let db = openDb(persistence.sql); let executions = openExecutionStore(persistence); let admissions = openAdmissionStore(persistence, executions);
  let durable = createRunnerDurability({ persistence, db, executions, admissions, runsDir: root, maxConcurrency: 1, snapshot, verify: async () => {} });
  admissions.admit({ runId: 'failed-preparation', repo: task.repo, request: {}, settings: {}, artifacts: [artifact] }, 1);
  const launch = vi.fn(async () => { throw new Error('worker must never launch'); });
  const createWorktree = vi.fn<RunnerDeps['createWorktree']>(async () => { throw new Error('temporary checkout unavailable'); });
  let deps: RunnerDeps = { db, durable, bus: new RunBus(), runsDir: root, genId: () => 'failed-preparation', now: () => new Date().toISOString(), adapter: { id: 'audit', buildCommand: () => ({ cmd: 'fake-worker', args: [] }), parseLine: () => null }, host: { kind: 'detached', launch, stop: vi.fn(async () => {}), isAlive: async () => false }, createWorktree, removeWorktree: async () => {} };
  await startRun(task, deps); expect(launch).not.toHaveBeenCalled(); expect(admissions.get('failed-preparation')?.state).toBe('started');
  persistence.close(); persistence = openPersistence(path); db = openDb(persistence.sql); executions = openExecutionStore(persistence); admissions = openAdmissionStore(persistence, executions);
  durable = createRunnerDurability({ persistence, db, executions, admissions, runsDir: root, maxConcurrency: 1, snapshot, verify: async () => {} });
  createWorktree.mockImplementation(async () => ({ path: root, branch: 'fixed' }));
  deps = { ...deps, db, durable };
  const row = db.getRun('failed-preparation')!;
  expect(row.status).toBe('failed');
  expect(executions.attempt({ runId: row.id, attempt: 1 })?.outcome).toMatchObject({ status: 'failed', evidence: { kind: 'never-launched', reason: 'temporary checkout unavailable' } });
  expect(executions.reservations()).toEqual([]);
  expect(executions.pins()).toEqual([]);
  expect(db.reattachableRuns()).toEqual([]);
  expect(() => admissions.admit({ runId: 'fresh-independent-run', repo: 'owner/other', request: {}, settings: {}, artifacts: [artifact] }, 1)).not.toThrow();
  expect(createWorktree).toHaveBeenCalledTimes(1); expect(launch).not.toHaveBeenCalled();
});

it('drains final retained-provider output after Stop and releases resources without recovery', async () => {
  const root = temporary(); const lifetime = createRunLifetime();
  const defaults = { model: null, effort: null };
  const metadata = { version: 1, label: 'Audit', defaults, review: { low: defaults, medium: defaults, high: defaults }, reviewSkills: [], reviewDelegation: 'none', supportsPrePr: false, docker: null, costReporting: 'delta' };
  const descriptor = { packageVersion: 1, manifest: { manifestVersion: 1, id: 'audit.parser', version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 }, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'agent' }], agents: { agent: { access: ['process-description'] } }, settings: {}, storageVersion: 1 } };
  const source = `export default { activate(context) { context.registerAgent('agent', { metadata: ${JSON.stringify(metadata)}, buildCommand() { return { cmd: 'fake-worker', args: [] }; }, parseLine(line) { return { kind: 'log', text: line, costUsd: 0.25 }; } }); } };`;
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor, files: [{ path: 'backend.js', base64: Buffer.from(source).toString('base64') }] })));
  const record = parseAgentRetainedProviderV1({ version: 1, binding: { pluginId: 'audit.parser', providerId: 'audit.parser/agent', contractVersion: 1, artifactHash: archive.hash }, origin: 'external', settings: {}, metadata });
  const loaded = await loadRetainedAgentProvider({ pluginsRoot: root, runtimeArtifactsRoot: root, record, artifacts: [{ pluginId: 'audit.parser', artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }], signal: lifetime.providerSignal });
  const persistence = openPersistence(':memory:'); const db = openDb(persistence.sql); const executions = openExecutionStore(persistence);
  const durable = createRunnerDurability({ persistence, db, executions, runsDir: root, maxConcurrency: 1, snapshot, verify: async () => {} });
  let stopped = false; let savedSpec: LaunchSpec | undefined; let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const ref = { kind: 'detached' as const, pid: 123 };
  const stop = vi.fn(async () => {
    if (!savedSpec?.receiptPath) throw new Error('Test worker has no launch receipt');
    const receipt = JSON.parse(readFileSync(savedSpec.receiptPath, 'utf8')); writeFileSync(savedSpec.logPath, 'worker stopped cleanly\n'); writeFileSync(savedSpec.exitPath, JSON.stringify({ ...receipt, exitCode: 1 })); });
  const deps: RunnerDeps = { db, durable, bus: new RunBus(), runsDir: root, genId: () => 'parser-stop', now: () => new Date().toISOString(), pollIntervalMs: 5,
      adapter: agentProviderAdapter(record, loaded.provider), createWorktree: async () => ({ path: root, branch: 'agent/parser-stop' }), removeWorktree: async () => {}, isStopped: () => stopped,
      onLaunch() { stopTimer = setTimeout(() => { stopped = true; lifetime.stop(); void stop(); }, 20); },
      host: { kind: 'detached', launch: async spec => { savedSpec = spec; writeFileSync(spec.logPath, ''); writeFileSync(spec.receiptPath!, JSON.stringify({ version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: 123, processStart: 'isolated-fake-worker' })); return ref; }, stop, isAlive: async () => true,
        discover: async spec => ({ status: 'found', ref, evidence: { runId: spec.runId, launchId: spec.launchId!, attempt: spec.attempt!, state: 'running' } }) } };
  try {
    lifetime.startExecution();
    await startRun(task, deps);
    const row = db.getRun('parser-stop')!;
    expect(row.status, JSON.stringify(db.listEvents(row.id))).toBe('stopped');
    expect(row.costUsd).toBe(0.25);
    expect(executions.attempt({ runId: row.id, attempt: row.attempt })?.outcome?.status).toBe('stopped');
    expect(executions.reservations()).toEqual([]);
    expect(executions.pins()).toEqual([]);
    expect(db.listEvents(row.id).filter(event => event.text === 'worker stopped cleanly')).toHaveLength(1);
    expect(lifetime.admissionSignal.aborted).toBe(true);
    expect(lifetime.providerSignal.aborted).toBe(false);
  } finally { clearTimeout(stopTimer); lifetime.dispose(); await loaded.dispose(); persistence.close(); }
});

function interruptedFixture() {
  const root = temporary();
  const path = join(root, 'state.sqlite');
  const open = () => {
    const persistence = openPersistence(path);
    cleanups.push(() => persistence.close());
    const db = openDb(persistence.sql);
    const executions = openExecutionStore(persistence);
    const admissions = openAdmissionStore(persistence, executions);
    const durable = createRunnerDurability({ persistence, db, executions, admissions, runsDir: root, maxConcurrency: 1, snapshot, verify: async () => {} });
    const launch = vi.fn(async () => { throw new Error('Must not launch a worker'); });
    const deps: RunnerDeps = { db, durable, bus: new RunBus(), runsDir: root, genId: () => 'interrupted', now: () => new Date().toISOString(),
      adapter: { id: 'audit', buildCommand: () => ({ cmd: 'worker', args: [] }), parseLine: () => null },
      host: { kind: 'detached', launch, stop: vi.fn(async () => {}), isAlive: async () => false },
      createWorktree: vi.fn(async () => { throw new Error('Do not recreate an interrupted worktree'); }), removeWorktree: vi.fn(async () => {}) };
    return { persistence, db, executions, admissions, durable, deps, launch };
  };
  const row: RunRow = { id: 'interrupted', repo: task.repo, ticketId: task.ticketId, adapter: 'audit', status: 'running', attempt: 1,
    startedAt: new Date().toISOString(), endedAt: null, prNumber: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(task) };
  return { root, open, row };
}

it('settles interrupted preparation after reopening stores without recreating or deleting uncertain workspace files', async () => {
  const f = interruptedFixture();
  const first = f.open();
  first.admissions.admit({ runId: f.row.id, repo: task.repo, request: {}, settings: {}, artifacts: [artifact] }, 1);
  const session = await first.durable.prepare(f.row, task);
  const orphan = join(f.root, 'interrupted-checkout.txt');
  writeFileSync(orphan, 'preserve interrupted preparation');
  session.close(); first.persistence.close();
  const next = f.open();
  const result = await reattachRun(next.db.getRun(f.row.id)!, next.deps);
  expect(result?.status).toBe('attached');
  if (result?.status === 'attached') await result.completion;
  expect(next.db.getRun(f.row.id)?.status).toBe('failed');
  expect(next.executions.reservations()).toEqual([]);
  expect(next.executions.pins()).toEqual([]);
  expect(next.deps.createWorktree).not.toHaveBeenCalled();
  expect(next.deps.removeWorktree).not.toHaveBeenCalled();
  expect(readFileSync(orphan, 'utf8')).toBe('preserve interrupted preparation');
  expect(next.launch).not.toHaveBeenCalled();
});

it('retries unlaunched finalization after restart without losing pins when obligations fail', async () => {
  const f = interruptedFixture();
  const first = f.open();
  const session = await first.durable.prepare(f.row, task); session.ready(f.root); session.close();
  const prepare = vi.fn(async () => { throw new Error('Finalization unavailable'); });
  const initial = await reattachRun(first.db.getRun(f.row.id)!, { ...first.deps, isStopped: () => true, prepareFinalization: prepare });
  expect(initial).toEqual({ status: 'blocked', reason: 'Finalization unavailable' });
  expect(first.executions.attempt({ runId: f.row.id, attempt: f.row.attempt })?.outcome).toMatchObject({ status: 'stopped', evidence: { kind: 'never-launched' } });
  expect(first.db.getRun(f.row.id)?.status).toBe('running');
  expect(first.executions.reservations()).toHaveLength(1);
  expect(first.executions.pins()).toHaveLength(1);
  first.persistence.close();
  const next = f.open();
  const finalized = vi.fn(async () => {});
  const result = await reattachRun(next.db.getRun(f.row.id)!, { ...next.deps, prepareFinalization: finalized });
  expect(result?.status).toBe('attached');
  expect(next.db.getRun(f.row.id)?.status).toBe('stopped');
  expect(finalized).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  expect(next.executions.reservations()).toEqual([]);
  expect(next.executions.pins()).toEqual([]);
  expect(next.launch).not.toHaveBeenCalled();
});

it('keeps a stopped ambiguous launch reserved after restart', async () => {
  const f = interruptedFixture();
  const first = f.open();
  const session = await first.durable.prepare(f.row, task); session.ready(f.root); session.launching(); session.close();
  first.persistence.close();
  const next = f.open();
  next.deps.host.discover = async () => ({ status: 'unknown', reason: 'Ownership unavailable' });
  const result = await reattachRun(next.db.getRun(f.row.id)!, { ...next.deps, isStopped: () => true });
  expect(result).toEqual({ status: 'blocked', reason: 'Ownership unavailable' });
  expect(next.executions.attempt({ runId: f.row.id, attempt: f.row.attempt })?.outcome).toBeNull();
  expect(next.db.getRun(f.row.id)?.status).toBe('running');
  expect(next.executions.reservations()).toHaveLength(1);
  expect(next.executions.pins()).toHaveLength(1);
  expect(next.deps.removeWorktree).not.toHaveBeenCalled();
  expect(next.launch).not.toHaveBeenCalled();
});
