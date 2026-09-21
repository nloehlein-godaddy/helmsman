// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db';
import { RunBus } from './event-bus';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionControls } from './execution-controls';
import { createRunnerDurability } from './runner-durability';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { detachedHost, readExitEvidence, type LaunchSpec, type RunHost } from './run-host';

const roots: string[] = [];
const connections = new Set<Persistence>();
afterEach(() => {
  for (const connection of connections) connection.close(); connections.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const task = { ticketId: 'task1', title: 'work', repo: 'org/a', jiraBaseUrl: '', task: 'work' };
const artifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'runner-persisted-')); roots.push(root);
  const path = join(root, 'state.sqlite');
  const host = detachedHost(join(import.meta.dirname, 'run-wrapper.mjs'));
  function open(runtimeHost: RunHost = host, finalize?: () => void) {
    const persistence = openPersistence(path); connections.add(persistence);
    const db = openDb(persistence.sql);
    const executions = openExecutionStore(persistence);
    const controls = openExecutionControls(persistence);
    const coordinator = createRunnerDurability({ persistence, db, executions, runsDir: root, maxConcurrency: 1,
      snapshot: row => ({ version: 1, runId: row.id, attempt: row.attempt, repo: row.repo,
        logicalWork: { source: 'freeform', instance: 'local', taskId: task.ticketId }, task: JSON.parse(row.taskJson ?? JSON.stringify(task)), workflowSnapshotId: null,
        artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
        bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId,
          artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] } satisfies ExecutionSnapshotInput),
      verify: async () => {}, finalize });
    const deps: RunnerDeps = { db, durable: coordinator, bus: new RunBus(), host: runtimeHost, runsDir: root,
      now: () => new Date().toISOString(), genId: () => 'voyage1', pollIntervalMs: 5,
      adapter: { id: 'test', buildCommand: () => ({ cmd: process.execPath, args: ['-e', 'process.exit(0)'] }), parseLine: () => null },
      createWorktree: vi.fn(async () => ({ path: root, branch: 'agent/voyage1' })), removeWorktree: vi.fn(async () => {}) };
    return { db, executions, controls, deps, close() { persistence.close(); connections.delete(persistence); } };
  }
  return { root, host, open };
}

it('transfers retry pins and retains attempt files until the last real worker is finalized', async () => {
  const f = setup();
  const specs: LaunchSpec[] = [];
  const host: RunHost = { ...f.host, launch: async spec => {
    specs.push(spec);
    if (spec.attempt === 2) {
      expect(state.executions.reservations()).toHaveLength(1);
      expect(state.executions.pins()).toHaveLength(1);
      expect(state.executions.pins()[0]?.ownerId).toBe(state.executions.attempt({ runId: 'voyage1', attempt: 2 })?.snapshotId);
    }
    return f.host.launch({ ...spec, args: ['-e', `process.exit(${spec.attempt === 1 ? 1 : 0})`] });
  } };
  const state = f.open(host); state.deps.maxAttempts = 2;
  await startRun(task, state.deps);
  expect(state.db.getRun('voyage1'), JSON.stringify(state.db.listEvents('voyage1'))).toMatchObject({ status: 'succeeded', attempt: 2 });
  expect(specs[0]?.launchId).not.toBe(specs[1]?.launchId);
  expect(JSON.parse(readFileSync(specs[0]!.exitPath, 'utf8')).exitCode).toBe(1);
  expect(state.executions.pins()).toEqual([]);
  expect(state.executions.reservations()).toEqual([]);
});

it('recovers a real worker spawned before its host reference could be recorded without launching twice', async () => {
  const f = setup();
  let spec!: LaunchSpec;
  const launch = vi.fn(async (input: LaunchSpec) => { spec = input; await f.host.launch(input); throw new Error('lost launch response'); });
  const first = f.open({ ...f.host, launch });
  await startRun(task, first.deps);
  expect(first.db.getRun('voyage1')).toMatchObject({ status: 'running', hostRef: null });
  expect(first.executions.reservations()).toHaveLength(1);
  expect(first.deps.removeWorktree).not.toHaveBeenCalled();
  await vi.waitFor(async () => expect(await readExitEvidence(spec)).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
  first.close();
  const second = f.open();
  const result = await reattachRun(second.db.getRun('voyage1')!, second.deps);
  expect(result?.status).toBe('attached');
  if (result?.status === 'attached') await result.completion;
  expect(launch).toHaveBeenCalledOnce();
  expect(second.db.getRun('voyage1')?.status).toBe('succeeded');
  expect(second.executions.reservations()).toEqual([]);
});

it('replays terminal finalization after an outbox transaction failure and a database restart', async () => {
  const f = setup();
  const first = f.open(f.host, () => { throw new Error('outbox transaction fault'); });
  await startRun(task, first.deps);
  expect(first.db.getRun('voyage1')?.status).toBe('running');
  expect(first.executions.attempt({ runId: 'voyage1', attempt: 1 })?.outcome?.status).toBe('succeeded');
  expect(first.executions.pins()).toHaveLength(1);
  expect(first.executions.reservations()).toHaveLength(1);
  expect(first.deps.removeWorktree).not.toHaveBeenCalled();
  first.close();
  const finalize = vi.fn();
  const second = f.open(f.host, finalize);
  const result = await reattachRun(second.db.getRun('voyage1')!, second.deps);
  expect(result?.status).toBe('attached');
  if (result?.status === 'attached') await result.completion;
  expect(finalize).toHaveBeenCalledOnce();
  expect(second.db.getRun('voyage1')?.status).toBe('succeeded');
  expect(second.executions.pins()).toEqual([]);
  expect(second.executions.reservations()).toEqual([]);
});

it('resumes a ready execution after source-claim reconciliation without preparing another worktree', async () => {
  const f = setup(); const launch = vi.fn(f.host.launch);
  const first = f.open({ ...f.host, launch });
  first.deps.botAccountId = 'bot';
  first.deps.jira = { assign: vi.fn(async () => { throw new Error('assignment uncertainty'); }), transition: vi.fn(async () => true) };
  await startRun({ ...task, task: undefined }, first.deps);
  expect(first.executions.attempt({ runId: 'voyage1', attempt: 1 })).toMatchObject({ preparation: 'ready', attachment: 'blocked', outcome: null });
  expect(launch).not.toHaveBeenCalled();
  expect(first.executions.reservations()).toHaveLength(1);
  first.close();
  const second = f.open({ ...f.host, launch });
  second.deps.botAccountId = 'bot';
  second.deps.jira = { assign: vi.fn(async () => {}), transition: vi.fn(async () => true) };
  const result = await reattachRun(second.db.getRun('voyage1')!, second.deps);
  expect(result?.status).toBe('attached');
  if (result?.status === 'attached') await result.completion;
  expect(second.deps.jira.assign).toHaveBeenCalledExactlyOnceWith(task.ticketId, 'bot');
  expect(launch).toHaveBeenCalledOnce();
  expect(second.deps.createWorktree).not.toHaveBeenCalled();
  expect(second.db.getRun('voyage1')?.status).toBe('succeeded');
  expect(second.executions.reservations()).toEqual([]);
});

it('honors a persisted stop when a real worker exits before the first recovery poll', async () => {
  const f = setup(); let spec!: LaunchSpec;
  const launch = vi.fn(async (input: LaunchSpec) => {
    spec = input; await f.host.launch(input);
    first.controls.requestStop({ runId: input.runId, attempt: input.attempt! });
    throw new Error('lost launch response before restart');
  });
  const first = f.open({ ...f.host, launch });
  await startRun(task, first.deps);
  await vi.waitFor(async () => expect(await readExitEvidence(spec)).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
  expect(first.executions.attempt({ runId: 'voyage1', attempt: 1 })?.outcome).toBeNull(); first.close();
  const second = f.open(); second.deps.isStopped = () => second.controls.isStopRequested({ runId: 'voyage1', attempt: 1 });
  const result = await reattachRun(second.db.getRun('voyage1')!, second.deps);
  expect(result?.status).toBe('attached'); if (result?.status === 'attached') await result.completion;
  expect(second.db.getRun('voyage1')?.status).toBe('stopped');
  expect(second.executions.attempt({ runId: 'voyage1', attempt: 1 })?.outcome?.status).toBe('stopped');
  expect(launch).toHaveBeenCalledOnce(); expect(second.executions.reservations()).toEqual([]);
});

it('preserves a recorded terminal outcome when a later stop intent arrives before finalization replay', async () => {
  const f = setup(); const first = f.open(f.host, () => { throw new Error('outbox transaction fault'); });
  await startRun(task, first.deps);
  const original = first.executions.attempt({ runId: 'voyage1', attempt: 1 })?.outcome;
  expect(original?.status, JSON.stringify(first.db.listEvents('voyage1'))).toBe('succeeded');
  first.controls.requestStop({ runId: 'voyage1', attempt: 1 }); first.close();
  const second = f.open(); second.deps.isStopped = () => second.controls.isStopRequested({ runId: 'voyage1', attempt: 1 });
  const result = await reattachRun(second.db.getRun('voyage1')!, second.deps);
  expect(result?.status).toBe('attached'); if (result?.status === 'attached') await result.completion;
  expect(second.executions.attempt({ runId: 'voyage1', attempt: 1 })?.outcome).toEqual(original);
  expect(second.db.getRun('voyage1')?.status).toBe('succeeded');
  expect(second.executions.reservations()).toEqual([]);
});
