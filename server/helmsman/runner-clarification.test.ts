// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, persistedJson, type Persistence } from './persistence';
import { openDb } from './db';
import { openExecutionStore } from './execution-store';
import { openClarificationStore } from './clarifications';
import { createClarificationChannel, parseClarificationChannel, type ClarificationChannel } from './clarification-protocol-store';
import { createClarificationRuntime } from './clarification-runtime';
import { createRunnerDurability } from './runner-durability';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { detachedHost, readExitEvidence, type LaunchSpec, type RunHost } from './run-host';
import * as runHost from './run-host';
import { RunBus } from './event-bus';
import type { AgentTask } from './agents/adapter';

const roots: string[] = []; const connections = new Set<Persistence>();
afterEach(() => { vi.restoreAllMocks(); for (const p of connections) p.close(); connections.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const task: AgentTask = { ticketId: 'task', title: 'Task', repo: 'org/galleon', jiraBaseUrl: '', task: 'Work' };
const artifact = { pluginId: 'example.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runner-clarification-')); roots.push(root);
  const host = detachedHost(join(import.meta.dirname, 'run-wrapper.mjs'));
  function open(runtimeHost: RunHost = host) {
    const persistence = openPersistence(join(root, 'state.sqlite')); connections.add(persistence);
    const db = openDb(persistence.sql); const executions = openExecutionStore(persistence);
    const store = openClarificationStore(persistence.sql, { getRun: id => db.getRun(id) });
    const coordinator = createRunnerDurability({ persistence, db, executions, runsDir: root, maxConcurrency: 1, clarificationProtocol: store.protocol,
      snapshot: (row, task) => ({ version: 1, runId: row.id, attempt: row.attempt, repo: row.repo,
        logicalWork: { source: 'test', instance: 'test', taskId: 'task' }, task: persistedJson(task),
        workflowSnapshotId: null, artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
        bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId,
          artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] }), verify: async () => {} });
    const runtime = createClarificationRuntime(store, root, { resolve(id, expectedAttempt) {
      const row = db.getRun(id); if (!row || expectedAttempt !== undefined && expectedAttempt !== row.attempt) throw new Error('Attempt changed');
      const attempt = executions.attempt({ runId: id, attempt: row.attempt }); const snapshot = attempt && executions.snapshot(attempt.snapshotId);
      if (!snapshot) throw new Error('Snapshot unavailable'); return { attempt: row.attempt, channel: store.protocol.verify(snapshot) };
    } });
    const deps: RunnerDeps = { db, durable: coordinator, host: runtimeHost, runsDir: root, bus: new RunBus(), now: () => new Date().toISOString(), genId: () => 'run-1', pollIntervalMs: 5,
      pollClarifications: (runId, attempt, terminal) => runtime.poll(runId, attempt, undefined, terminal),
      hasRequiredUnanswered: runtime.hasUnanswered, onRunComplete: row => runtime.complete(row.id, row.attempt),
      adapter: { id: 'test', buildCommand: () => ({ cmd: process.execPath, args: ['-e', 'process.exit(0)'] }), parseLine: () => null },
      createWorktree: async () => ({ path: root, branch: 'agent/run-1' }), removeWorktree: async () => {} };
    return { persistence, db, executions, store, coordinator, deps, close() { persistence.close(); connections.delete(persistence); } };
  }
  return { root, host, open, task: () => ({ ...task, clarification: createClarificationChannel(root, { runId: 'run-1', attempt: 1 }) }) };
}

it('pins each automatic retry channel before building its worker command and does not deliver previous answers', async () => {
  const f = fixture(); const state = f.open(); state.deps.maxAttempts = 2;
  const channels: ClarificationChannel[] = [];
  state.deps.adapter.buildCommand = value => {
    const channel = parseClarificationChannel(value.clarification)!; channels.push(channel);
    expect(state.store.protocol.channel('run-1', channel.attempt)).toEqual(channel);
    const record = { kind: 'question', id: `question-${channel.attempt}`, required: false, prompt: 'Proceed?' };
    return { cmd: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(channel.questionsPath)},${JSON.stringify(`${JSON.stringify(record)}\n`)});process.exit(${channel.attempt === 1 ? 1 : 0})`] };
  };
  await startRun(f.task(), state.deps);
  expect(state.db.getRun('run-1'), JSON.stringify(state.db.listEvents('run-1'))).toMatchObject({ status: 'succeeded', attempt: 2 });
  expect(channels).toHaveLength(2); expect(channels[0]?.channelId).not.toBe(channels[1]?.channelId);
  expect(state.store.listForChannel(channels[0]!)).toHaveLength(1); expect(state.store.listForChannel(channels[1]!)).toHaveLength(1);
  expect(state.store.protocol.provenance('question-1')?.attempt).toBe(1); expect(state.store.protocol.provenance('question-2')?.attempt).toBe(2);
  expect(JSON.parse(state.db.getRun('run-1')!.taskJson!).clarification).toEqual(channels[1]);
});

it('recovers the exact immutable channel after a lost worker launch response and restart', async () => {
  const f = fixture(); let spec!: LaunchSpec;
  const launch = vi.fn(async (value: LaunchSpec) => { spec = value; await f.host.launch(value); throw new Error('Response lost'); });
  const first = f.open({ ...f.host, launch }); const preparedTask = f.task();
  await startRun(preparedTask, first.deps);
  await vi.waitFor(async () => expect(await readExitEvidence(spec)).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
  const before = first.executions.snapshot(first.executions.attempt({ runId: 'run-1', attempt: 1 })!.snapshotId)!;
  first.close(); const second = f.open();
  const result = await reattachRun(second.db.getRun('run-1')!, second.deps);
  expect(result?.status).toBe('attached'); if (result?.status === 'attached') await result.completion;
  expect(second.store.protocol.verify(before)).toEqual(preparedTask.clarification); expect(launch).toHaveBeenCalledOnce();
  expect(second.executions.snapshot(before.id)).toEqual(before);
});

it.each([1, 2])('ingests the final required question observed during exit reading with %i allowed attempts', async maxAttempts => {
  const f = fixture(); const state = f.open(); const preparedTask = f.task();
  state.deps.maxAttempts = maxAttempts;
  state.deps.adapter.buildCommand = value => ({ cmd: process.execPath,
    args: ['-e', `process.exit(${maxAttempts === 2 && value.clarification?.attempt === 1 ? 1 : 0})`] });
  const originalRead = runHost.readExitEvidence;
  let injected = false;
  vi.spyOn(runHost, 'readExitEvidence').mockImplementation(async spec => {
    const exit = await originalRead(spec);
    if (exit && spec.attempt === 1 && !injected) {
      injected = true;
      writeFileSync(preparedTask.clarification.questionsPath,
        `${JSON.stringify({ kind: 'question', id: 'last-required', required: true, prompt: 'Authorize publication?' })}\n`);
    }
    return exit;
  });
  await startRun(preparedTask, state.deps);
  expect(injected).toBe(true);
  expect(state.db.getRun('run-1')).toMatchObject({ status: 'failed', attempt: maxAttempts });
  expect(state.store.listForChannel(preparedTask.clarification)).toHaveLength(1);
  expect(state.store.protocol.provenance('last-required')).toMatchObject({ attempt: 1, channelId: preparedTask.clarification.channelId });
  if (maxAttempts === 2) expect(state.store.hasRequiredUnanswered('run-1')).toBe(true);
});

it.each([
  ['complete JSON without newline', JSON.stringify({ kind: 'question', id: 'unfinished', required: true, prompt: 'Proceed?' }), false],
  ['malformed suffix', '{"kind":"question",', false],
  ['whitespace suffix', ' \t\r', true],
] as const)('drains terminal clarification files with %s before allowing retry', async (_name, suffix, valid) => {
  const f = fixture(); const state = f.open(); const preparedTask = f.task(); state.deps.maxAttempts = 2;
  state.deps.adapter.buildCommand = value => ({ cmd: process.execPath,
    args: ['-e', `process.exit(${value.clarification?.attempt === 1 ? 1 : 0})`] });
  const originalRead = runHost.readExitEvidence;
  let injected = false;
  vi.spyOn(runHost, 'readExitEvidence').mockImplementation(async spec => {
    const exit = await originalRead(spec);
    if (exit && spec.attempt === 1 && !injected) {
      injected = true;
      writeFileSync(preparedTask.clarification.questionsPath,
        `${JSON.stringify({ kind: 'question', id: 'complete', required: false, prompt: 'Proceed?' })}\n${suffix}`);
    }
    return exit;
  });
  await startRun(preparedTask, state.deps);
  expect(injected).toBe(true);
  expect(state.store.listForChannel(preparedTask.clarification)).toHaveLength(1);
  if (valid) expect(state.db.getRun('run-1')).toMatchObject({ status: 'succeeded', attempt: 2 });
  else {
    expect(state.db.getRun('run-1')).toMatchObject({ status: 'running', attempt: 1 });
    expect(state.executions.attempt({ runId: 'run-1', attempt: 2 })).toBeNull();
    expect(state.store.protocol.channel('run-1', 1)).toEqual(preparedTask.clarification);
    expect(state.db.listEvents('run-1')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'error', text: expect.stringContaining('incomplete record') })]));
  }
});

it('binds a fresh continuation channel without rewriting the failed pre-PR checkpoint', async () => {
  const f = fixture(); const state = f.open(); const firstTask = f.task();
  const initial = { id: 'run-1', repo: task.repo, ticketId: task.ticketId, adapter: 'pre-pr:codex', status: 'running' as const, attempt: 1,
    startedAt: new Date().toISOString(), endedAt: null, prNumber: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(firstTask) };
  const first = await state.coordinator.prepare(initial, firstTask); first.ready(f.root);
  first.terminal({ status: 'failed', exitCode: 1, evidence: { launchId: first.launchId } });
  first.finalize({ ...state.db.getRun('run-1')!, status: 'failed' }); first.close();
  const checkpoint = state.executions.checkpoint('run-1:1:pre-pr')!; const retained = state.executions.snapshot(checkpoint.snapshotId)!;
  const nextTask = { ...firstTask, clarification: createClarificationChannel(f.root, { runId: 'run-1', attempt: 2 }),
    prePrResume: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), branch: 'agent/run-1', round: 1, reviewerReports: {}, metadataPath: '/metadata' } };
  const next = await state.coordinator.prepare({ ...state.db.getRun('run-1')!, status: 'running', attempt: 2, taskJson: JSON.stringify(nextTask) }, nextTask); next.close();
  expect(state.store.protocol.channel('run-1', 2)).toEqual(nextTask.clarification);
  expect(state.executions.snapshot(checkpoint.snapshotId)).toEqual(retained);
  expect(state.store.protocol.verify(retained)).toEqual(firstTask.clarification);
});

it('rolls channel binding and prepared execution back together when admission fails', async () => {
  const f = fixture(); const state = f.open(); const original = state.store.protocol.bind;
  state.store.protocol.bind = snapshot => { original(snapshot); throw new Error('Admission failed'); };
  await expect(startRun(f.task(), state.deps)).rejects.toThrow('Admission failed');
  expect(state.store.protocol.channel('run-1', 1)).toBeNull(); expect(state.executions.attempt({ runId: 'run-1', attempt: 1 })).toBeNull(); expect(state.db.getRun('run-1')).toBeNull();
});
