// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type RunRow } from './db';
import { RunBus } from './event-bus';
import { reattachRun, startRun, type DurableRunnerAttempt, type RunnerDeps } from './runner';
import type { HostDiscovery, HostRef, LaunchSpec } from './run-host';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const task = { ticketId: 'task1', title: 'work', repo: 'org/a', jiraBaseUrl: '', task: 'work' };
const ref: HostRef = { kind: 'detached', pid: 123 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runner-durable-'));
  const db: Db = openDb(':memory:');
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const order: string[] = [];
  const sessions: DurableRunnerAttempt[] = [];
  const outcomes = new Map<number, unknown>();
  const specs: LaunchSpec[] = [];
  let resultCode = 0;
  const create = (row: RunRow): DurableRunnerAttempt => {
    const base = join(root, `run1-${row.attempt}`);
    const paths = { logPath: `${base}.log`, exitPath: `${base}.exit`, specPath: `${base}.json`, receiptPath: `${base}.receipt` };
    const next = { ...row, ...paths };
    if (db.getRun(row.id)) db.updateRun(row.id, next); else db.insertRun(next);
    const session: DurableRunnerAttempt = {
      launchId: `launch-${row.attempt}`, attempt: row.attempt, paths, preparation: 'launched', hostRef: ref,
      ready: vi.fn(path => { order.push('ready'); db.updateRun(row.id, { worktreePath: path }); }),
      launching: vi.fn(() => { order.push('launching'); }),
      launched: vi.fn(() => { order.push('launched'); }),
      attachment: vi.fn(state => { order.push(state); }),
      terminal: vi.fn(value => { order.push('terminal'); outcomes.set(row.attempt, value); }),
      finalize: vi.fn(final => { expect(outcomes.has(row.attempt)).toBe(true); order.push('finalize'); db.updateRun(row.id, final); }),
      renew: vi.fn(), close: vi.fn(),
    };
    sessions.push(session); return session;
  };
  const exit = (spec: LaunchSpec, code = resultCode) => {
    const receipt = { version: 1, launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, pid: 123, processStart: 'verified-test-process' };
    writeFileSync(spec.receiptPath!, JSON.stringify(receipt));
    writeFileSync(spec.exitPath, JSON.stringify({ ...receipt, exitCode: code }));
  };
  const deps: RunnerDeps = {
    db, bus: new RunBus(), runsDir: root, genId: () => 'run1', now: () => '2026-09-20T12:00:00.000Z', pollIntervalMs: 1,
    adapter: { id: 'test', buildCommand: () => ({ cmd: 'node', args: [] }), parseLine: () => null },
    createWorktree: vi.fn(async () => { expect(db.getRun('run1')).not.toBeNull(); order.push('worktree'); return { path: root, branch: 'agent/run1' }; }),
    removeWorktree: vi.fn(async () => { order.push('cleanup'); }),
    host: {
      kind: 'detached', isAlive: vi.fn(async () => false), stop: vi.fn(async () => {}),
      launch: vi.fn(async spec => { order.push('launch'); specs.push(spec); writeFileSync(spec.logPath, ''); exit(spec); return ref; }),
      discover: vi.fn(async spec => ({ status: 'found', ref, evidence: { launchId: spec.launchId!, runId: spec.runId, attempt: spec.attempt!, state: 'running' } } as HostDiscovery)),
    },
    durable: {
      prepare: vi.fn(async row => { order.push('prepare'); return create(row); }),
      recover: vi.fn(async () => sessions.at(-1)!),
      cleanupEligibility: () => ({ allowed: true }),
    },
  };
  return { root, db, deps, order, sessions, specs, exit, setCode: (value: number) => { resultCode = value; }, create };
}

it('persists preparation before worktree effects and finalizes only after matching process evidence', async () => {
  const f = fixture();
  expect(await startRun(task, f.deps)).toBe('run1');
  expect(f.order).toEqual(['prepare', 'worktree', 'ready', 'launching', 'launch', 'launched', 'attached', 'terminal', 'finalize', 'cleanup']);
  expect(f.db.getRun('run1')?.status).toBe('succeeded');
  expect(f.specs[0]).toMatchObject({ launchId: 'launch-1', attempt: 1 });
});

it('projects a provider-declared failure even when the durable worker exits zero', async () => {
  const f = fixture();
  f.deps.adapter = { id: 'test', buildCommand: () => ({ cmd: 'node', args: [] }), parseLine: line => JSON.parse(line) };
  f.deps.host.launch = vi.fn(async spec => {
    f.specs.push(spec);
    writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', outcome: 'failure', text: 'provider failed' }) + '\n');
    f.exit(spec, 0);
    return ref;
  });
  await startRun(task, f.deps);
  expect(f.db.getRun('run1')?.status).toBe('failed');
  expect(f.sessions[0]?.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 0 }));
});

it('restores a journaled provider failure while attaching a durable execution after its log was consumed', async () => {
  const f = fixture();
  const row: RunRow = { id: 'run1', ticketId: task.ticketId, repo: task.repo, adapter: 'test', status: 'running', attempt: 1,
    prNumber: null, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, costUsd: null, worktreePath: f.root, taskJson: JSON.stringify(task), logOffset: 128 };
  const session = f.create(row);
  writeFileSync(session.paths.logPath, 'already consumed provider result\n');
  f.db.appendEvent(row.id, 'agent-result-failure:1', 'already consumed provider result', '2026-09-20T12:00:00.000Z');
  const handshake = await reattachRun(f.db.getRun(row.id)!, f.deps);
  f.exit({ ...session.paths, runId: row.id, launchId: session.launchId, attempt: 1, cmd: 'node', args: [], cwd: f.root }, 0);
  if (handshake?.status === 'attached') await handshake.completion;
  expect(f.db.getRun(row.id)?.status).toBe('failed');
  expect(session.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 0 }));
});

it('preserves execution and worktree when launch fails with unknown remote success', async () => {
  const f = fixture();
  f.deps.host.launch = vi.fn(async () => { throw new Error('response lost after remote launch'); });
  await startRun(task, f.deps);
  expect(f.db.getRun('run1')).toMatchObject({ status: 'running', endedAt: null, worktreePath: f.root });
  expect(f.sessions[0]?.attachment).toHaveBeenCalledWith('blocked', 'response lost after remote launch');
  expect(f.sessions[0]?.terminal).not.toHaveBeenCalled();
  expect(f.deps.host.stop).not.toHaveBeenCalled();
  expect(f.deps.removeWorktree).not.toHaveBeenCalled();
});

it('preserves prior attempt files and reservation across retries until finalization', async () => {
  const f = fixture(); f.deps.maxAttempts = 2;
  f.deps.host.launch = vi.fn(async spec => { f.specs.push(spec); writeFileSync(spec.logPath, `attempt ${spec.attempt}`); f.exit(spec, spec.attempt === 1 ? 1 : 0); return ref; });
  await startRun(task, f.deps);
  expect(f.specs.map(spec => spec.launchId)).toEqual(['launch-1', 'launch-2']);
  expect(readFileSync(f.specs[0]!.logPath, 'utf8')).toBe('attempt 1');
  expect(f.sessions[0]?.finalize).not.toHaveBeenCalled();
  expect(f.sessions[1]?.finalize).toHaveBeenCalledOnce();
  expect(f.deps.removeWorktree).toHaveBeenCalledOnce();
});

it('returns an attachment handshake before completion and leaves unknown hosts untouched', async () => {
  const f = fixture();
  const row: RunRow = { id: 'run1', ticketId: task.ticketId, repo: task.repo, adapter: 'test', status: 'running', attempt: 1,
    prNumber: null, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, costUsd: null, worktreePath: f.root, taskJson: JSON.stringify(task) };
  const session = f.create(row);
  writeFileSync(session.paths.logPath, '');
  const handshake = await reattachRun(f.db.getRun('run1')!, f.deps);
  expect(handshake?.status).toBe('attached');
  expect(f.db.getRun('run1')?.status).toBe('running');
  f.exit({ ...session.paths, runId: row.id, launchId: session.launchId, attempt: 1, cmd: 'node', args: [], cwd: f.root });
  if (handshake?.status === 'attached') await handshake.completion;
  expect(f.db.getRun('run1')?.status).toBe('succeeded');

  f.deps.host.discover = vi.fn(async () => ({ status: 'unknown' as const, reason: 'host unavailable' }));
  expect(await reattachRun({ ...f.db.getRun('run1')!, status: 'running' }, f.deps)).toEqual({ status: 'blocked', reason: 'host unavailable' });
  expect(f.deps.host.stop).not.toHaveBeenCalled();
});

it('does not clean retained resources even after verified process completion', async () => {
  const f = fixture();
  f.deps.durable!.cleanupEligibility = () => ({ allowed: false, reasons: ['Checkpoint remains resumable'] });
  await startRun(task, f.deps);
  expect(f.db.getRun('run1')?.status).toBe('succeeded');
  expect(f.deps.removeWorktree).not.toHaveBeenCalled();
});

it('prepares durable final obligations before terminal projection and skips direct legacy publication effects', async () => {
  const f = fixture();
  f.deps.enqueueCreatedPrReview = vi.fn();
  f.deps.requestCopilotReview = vi.fn(async () => ({ ok: true as const }));
  f.deps.prepareFinalization = vi.fn(async row => {
    expect(row).toMatchObject({ status: 'succeeded', prNumber: 3 });
    expect(f.db.getRun(row.id)?.status).toBe('running');
    expect(f.sessions[0]?.terminal).toHaveBeenCalledOnce();
    f.order.push('prepare-effects');
  });
  await startRun({ ...task, prNumber: 3 }, f.deps);
  expect(f.order.indexOf('prepare-effects')).toBeLessThan(f.order.indexOf('finalize'));
  expect(f.deps.enqueueCreatedPrReview).not.toHaveBeenCalled();
  expect(f.deps.requestCopilotReview).not.toHaveBeenCalled();
});

it('blocks launch until durable Jira source claim is settled', async () => {
  const f = fixture();
  f.deps.botAccountId = 'bot';
  f.deps.jira = { assign: vi.fn(async () => { throw new Error('assignment outcome is uncertain'); }), transition: vi.fn(async () => true) };
  await startRun({ ...task, task: undefined }, f.deps);
  expect(f.deps.host.launch).not.toHaveBeenCalled();
  expect(f.deps.removeWorktree).not.toHaveBeenCalled();
  expect(f.db.getRun('run1')?.status).toBe('running');
  expect(f.sessions[0]?.attachment).toHaveBeenCalledWith('blocked', 'assignment outcome is uncertain');
});

it('does not launch a recovered ready execution stopped during source claim reconciliation', async () => {
  const f = fixture();
  let stopped = false;
  f.deps.isStopped = () => stopped;
  f.deps.botAccountId = 'bot';
  f.deps.jira = { assign: vi.fn(async () => {}), transition: vi.fn(async () => { stopped = true; return true; }) };
  const row: RunRow = { id: 'run1', ticketId: task.ticketId, repo: task.repo, adapter: 'test', status: 'running', attempt: 1,
    prNumber: null, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, costUsd: null, worktreePath: f.root,
    taskJson: JSON.stringify({ ...task, task: undefined }) };
  const session = f.create(row);
  f.deps.durable!.recover = vi.fn(async () => ({ ...session, preparation: 'ready' as const, hostRef: null }));

  expect(await reattachRun(f.db.getRun('run1')!, f.deps)).toEqual({ status: 'blocked', reason: 'Execution cancelled before launch; ownership requires reconciliation' });
  expect(f.deps.jira.transition).toHaveBeenCalledOnce();
  expect(f.deps.host.launch).not.toHaveBeenCalled();
  expect(session.launching).not.toHaveBeenCalled();
  expect(session.terminal).not.toHaveBeenCalled();
  expect(f.deps.removeWorktree).not.toHaveBeenCalled();
  expect(f.db.getRun('run1')?.status).toBe('running');
});

it('does not relaunch a recovered absent host stopped during discovery', async () => {
  const f = fixture();
  let stopped = false;
  f.deps.isStopped = () => stopped;
  const row: RunRow = { id: 'run1', ticketId: task.ticketId, repo: task.repo, adapter: 'test', status: 'running', attempt: 1,
    prNumber: null, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, costUsd: null, worktreePath: f.root, taskJson: JSON.stringify(task) };
  const session = f.create(row);
  f.deps.durable!.recover = vi.fn(async () => ({ ...session, preparation: 'launching' as const, hostRef: null }));
  f.deps.host.discover = vi.fn(async () => { stopped = true; return { status: 'absent' as const, evidence: 'No matching worker was launched' }; });

  expect(await reattachRun(f.db.getRun('run1')!, f.deps)).toEqual({ status: 'blocked', reason: 'Execution cancelled before launch; ownership requires reconciliation' });
  expect(f.deps.host.launch).not.toHaveBeenCalled();
  expect(session.terminal).not.toHaveBeenCalled();
  expect(f.deps.removeWorktree).not.toHaveBeenCalled();
  expect(f.db.getRun('run1')?.status).toBe('running');
});
