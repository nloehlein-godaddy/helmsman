// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { RunRow } from './db';
import { proveLegacyTerminalProcessInactive } from './legacy-execution-process-proof';

const task = { repo: 'org/repo', ticketId: 'TASK-1', title: 'Task', jiraBaseUrl: '' };
const row: RunRow = { id: 'run-1', repo: 'org/repo', ticketId: 'TASK-1', adapter: 'codex', status: 'failed', attempt: 1,
  startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:01:00.000Z', costUsd: null, prNumber: null,
  worktreePath: '/tmp/repo/.worktrees/run-1', hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 1234 }),
  taskJson: JSON.stringify(task), logPath: '/tmp/run-1.log', exitPath: '/tmp/run-1.exit', specPath: '/tmp/run-1.spec' };
const failure = (code: string) => Object.assign(new Error('private diagnostic'), { code });
function deps() { return { probePid: vi.fn<(pid: number) => void>(() => { throw failure('ESRCH'); }), readExit: vi.fn(async () => '1\n') }; }

it('requires an absent PID and numeric recorded exit evidence for a detached legacy process', async () => {
  const dependencies = deps();
  expect(await proveLegacyTerminalProcessInactive(row, dependencies)).toEqual({ inactive: true, kind: 'detached-exited', pid: 1234, exitCode: 1 });
  expect(dependencies.probePid).toHaveBeenCalledWith(1234); expect(dependencies.readExit).toHaveBeenCalledWith(row.exitPath);
});
it('accepts an absent detached PID when no exit path was ever recorded', async () => {
  const dependencies = deps();
  expect(await proveLegacyTerminalProcessInactive({ ...row, exitPath: null }, dependencies)).toMatchObject({ inactive: true, exitCode: null });
  expect(dependencies.readExit).not.toHaveBeenCalled();
});
it('accepts valid task JSON longer than 4096 bytes while retaining individual field checks', async () => {
  const taskJson = JSON.stringify({ ...task, task: 'x'.repeat(4096), title: 'y'.repeat(4096) });
  expect(await proveLegacyTerminalProcessInactive({ ...row, taskJson }, deps())).toMatchObject({ inactive: true });
  expect(await proveLegacyTerminalProcessInactive({ ...row, taskJson: JSON.stringify({ ...task, task: 'x'.repeat(4097) }) }, deps())).toMatchObject({ inactive: false });
});
it('blocks task JSON larger than one MiB before probing the process', async () => {
  const dependencies = deps();
  expect(await proveLegacyTerminalProcessInactive({ ...row, taskJson: JSON.stringify({ ...task, extra: 'x'.repeat(1024 * 1024) }) }, dependencies)).toMatchObject({ inactive: false });
  expect(dependencies.probePid).not.toHaveBeenCalled();
});
it.each(['present', 'EPERM', 'EACCES', 'unknown'])('blocks process probe result %s without reading exit evidence', async code => {
  const dependencies = deps(); dependencies.probePid.mockImplementation(() => { if (code !== 'present') throw failure(code); });
  expect(await proveLegacyTerminalProcessInactive(row, dependencies)).toMatchObject({ inactive: false });
  expect(dependencies.readExit).not.toHaveBeenCalled();
});
it.each(['', ' ', '1.0', '-1', '256', '{"exitCode":0}', '0\nprivate detail', '9'.repeat(129)])('blocks invalid numeric exit evidence %j', async value => {
  const dependencies = deps(); dependencies.readExit.mockResolvedValue(value);
  expect(await proveLegacyTerminalProcessInactive(row, dependencies)).toMatchObject({ inactive: false });
});
it.each(['ENOENT', 'EACCES'])('blocks unavailable recorded exit evidence %s', async code => {
  const dependencies = deps(); dependencies.readExit.mockRejectedValue(failure(code));
  expect(await proveLegacyTerminalProcessInactive(row, dependencies)).toMatchObject({ inactive: false });
});
it.each([
  { status: 'running' }, { endedAt: null }, { endedAt: 'invalid' }, { hostKind: 'cmux' }, { hostKind: 'wezterm' }, { hostKind: 'docker' },
  { hostKind: null }, { hostRef: '{' }, { hostRef: JSON.stringify({ kind: 'detached', pid: 0 }) },
  { hostRef: JSON.stringify({ kind: 'detached', pid: 1, ownership: {} }) },
  { taskJson: null }, { taskJson: '{' }, { taskJson: 'null' }, { taskJson: '{}' }, { exitPath: '../exit' },
  ...['executionHost', 'hostIsolation', 'dockerExecution'].map(key => ({ taskJson: JSON.stringify({ ...task, [key]: {} }) })),
] satisfies Partial<RunRow>[])('blocks unsafe terminal runtime metadata %j', async patch => {
  const dependencies = deps();
  expect(await proveLegacyTerminalProcessInactive({ ...row, ...patch }, dependencies)).toMatchObject({ inactive: false });
  expect(dependencies.probePid).not.toHaveBeenCalled(); expect(dependencies.readExit).not.toHaveBeenCalled();
});
const historical = { ...row, hostKind: null, hostRef: null, taskJson: null, logPath: null, exitPath: null, specPath: null };
it('classifies a terminal historical row with no runtime metadata without probing a guessed PID', async () => {
  const dependencies = deps();
  expect(await proveLegacyTerminalProcessInactive(historical, dependencies)).toEqual({ inactive: true, kind: 'historical-no-runtime', pid: null, exitCode: null });
  expect(dependencies.probePid).not.toHaveBeenCalled(); expect(dependencies.readExit).not.toHaveBeenCalled();
});
it.each([{ logPath: row.logPath }, { exitPath: row.exitPath }, { specPath: row.specPath }, { hostKind: 'detached' },
  { hostRef: row.hostRef }, { taskJson: row.taskJson }, { logOffset: 12 }, { launchJson: '{}' }])('blocks partial historical runtime metadata %j', async patch => {
  expect(await proveLegacyTerminalProcessInactive({ ...historical, ...patch }, deps())).toMatchObject({ inactive: false });
});
