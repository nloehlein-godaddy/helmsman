// @vitest-environment node
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { proveLegacyExecutionWorkspace, withLegacyExecutionWorkspaceProof } from './legacy-execution-workspace-proof';
import { commonGitDirectory } from './worktree-maintenance';

vi.setConfig({ testTimeout: 30_000 });
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const agentsRoot = await realpath(await mkdtemp(join(tmpdir(), 'legacy-proof-'))); roots.push(agentsRoot);
  const repoDir = join(agentsRoot, 'repo'); await mkdir(repoDir);
  const git = (...args: string[]) => run('git', ['-C', repoDir, ...args], { timeout: 10_000 });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com'); await git('config', 'user.name', 'Test');
  await git('config', 'remote.origin.url', 'https://github.com/org/repo.git');
  await writeFile(join(repoDir, 'README'), 'base'); await git('add', 'README'); await git('commit', '-qm', 'base');
  const runId = 'legacy-one'; const workspace = join(repoDir, '.worktrees', runId);
  const input = { agentsRoot, repo: 'org/repo', runId, recordedWorkspacePath: workspace, isolatedRoot: join(agentsRoot, '.helmsman-docker-workspaces') };
  return { agentsRoot, repoDir, runId, workspace, input, git };
}

it('proves an absent managed workspace across current, historical, and isolated paths', async () => {
  const f = await setup();
  const oldRoot = await mkdtemp(join(tmpdir(), 'legacy-old-')); roots.push(oldRoot);
  const recordedWorkspacePath = join(oldRoot, 'repo', '.worktrees', f.runId);
  const proof = await proveLegacyExecutionWorkspace({ ...f.input, recordedWorkspacePath });
  expect(proof).toMatchObject({ kind: 'absent', workspace: f.workspace, checkout: { path: f.repoDir } });
  expect(await proveLegacyExecutionWorkspace(f.input)).toMatchObject({ kind: 'absent' });
});

it('proves only a registered managed worktree with its actual branch', async () => {
  const f = await setup(); await f.git('worktree', 'add', '-b', `agent/${f.runId}`, f.workspace);
  const proof = await proveLegacyExecutionWorkspace(f.input);
  expect(proof).toMatchObject({ kind: 'retained', workspace: f.workspace, branchRef: `refs/heads/agent/${f.runId}` });
  expect((await f.git('worktree', 'list', '--porcelain')).stdout).toContain(f.workspace);
});

it('blocks a detached registered worktree and an unregistered directory', async () => {
  const detached = await setup(); await detached.git('worktree', 'add', '--detach', detached.workspace);
  expect(await proveLegacyExecutionWorkspace(detached.input)).toMatchObject({ kind: 'blocked' });
  const plain = await setup(); await mkdir(plain.workspace, { recursive: true });
  expect(await proveLegacyExecutionWorkspace(plain.input)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('without verified Git registration') });
});

it('retains a workspace-only orphan only with its exact absent Git administration pointer', async () => {
  const f = await setup(); await mkdir(f.workspace, { recursive: true });
  const expectedAdministration = join(commonGitDirectory(f.repoDir), 'worktrees', f.runId);
  await writeFile(join(f.workspace, '.git'), `gitdir: ${expectedAdministration}\n`);
  expect(await proveLegacyExecutionWorkspace(f.input)).toMatchObject({ kind: 'orphan', workspace: f.workspace });
  await writeFile(join(f.workspace, '.git'), 'gitdir: /other/location\n');
  expect(await proveLegacyExecutionWorkspace(f.input)).toMatchObject({ kind: 'blocked' });
});

it('proves a moved orphan with an exact historical /tmp Git pointer and absent old checkout', async () => {
  const f = await setup(); await mkdir(f.workspace, { recursive: true });
  const oldRoot = await mkdtemp('/tmp/legacy-historical-'); roots.push(oldRoot);
  await rm(oldRoot, { recursive: true, force: true });
  const recordedWorkspacePath = join(oldRoot, 'repo', '.worktrees', f.runId);
  const canonicalOldRoot = join(await realpath('/tmp'), basename(oldRoot));
  const historicalAdministration = join(canonicalOldRoot, 'repo', '.git', 'worktrees', f.runId);
  await writeFile(join(f.workspace, '.git'), `gitdir: ${historicalAdministration}\n`);
  expect(await proveLegacyExecutionWorkspace({ ...f.input, recordedWorkspacePath })).toMatchObject({ kind: 'orphan', workspace: f.workspace });
  await mkdir(join(oldRoot, 'repo'), { recursive: true });
  expect(await proveLegacyExecutionWorkspace({ ...f.input, recordedWorkspacePath })).toMatchObject({ kind: 'blocked' });
});

it('holds Git maintenance through the caller reconciliation callback', async () => {
  const f = await setup();
  const lock = join(commonGitDirectory(f.repoDir), 'helmsman-maintenance.lock');
  const kind = await withLegacyExecutionWorkspaceProof(f.input, async proof => {
    expect((await lstat(lock)).isDirectory()).toBe(true);
    return proof.kind;
  });
  expect(kind).toBe('absent');
  await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('blocks stale Git registration even when the workspace directory disappeared', async () => {
  const f = await setup(); await f.git('worktree', 'add', '-b', `agent/${f.runId}`, f.workspace);
  await rm(f.workspace, { recursive: true, force: true });
  expect(await proveLegacyExecutionWorkspace(f.input)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('remains registered') });
});

it('blocks unsafe recorded paths, aliases, and an existing isolated allocation', async () => {
  const f = await setup();
  expect(await proveLegacyExecutionWorkspace({ ...f.input, recordedWorkspacePath: join(f.agentsRoot, 'other', '.worktrees', f.runId) })).toMatchObject({ kind: 'blocked' });
  const oldRoot = await mkdtemp(join(tmpdir(), 'legacy-alias-')); roots.push(oldRoot);
  await symlink(f.repoDir, join(oldRoot, 'repo'));
  expect(await proveLegacyExecutionWorkspace({ ...f.input, recordedWorkspacePath: join(oldRoot, 'repo', '.worktrees', f.runId) })).toMatchObject({ kind: 'blocked' });
  await mkdir(join(f.input.isolatedRoot, f.runId), { recursive: true });
  expect(await proveLegacyExecutionWorkspace(f.input)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('Isolated allocation') });
});
