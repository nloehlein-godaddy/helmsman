import { randomUUID } from 'node:crypto';
import { commonGitDirectory, withWorktreeMaintenance } from './worktree-maintenance';
export { withWorktreeMaintenance } from './worktree-maintenance';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isGithubRepo } from '../pr-lists';

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

export function repoBasename(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

function parameters(repo: string, runId: string, attempt = 1): void {
  if (!isGithubRepo(repo) || !/^[a-z\d_-]{1,128}$/i.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid managed worktree identity');
}
function intendedWorkspace(repoDir: string, runId: string): string {
  const parent = join(repoDir, '.worktrees'); const path = join(parent, runId);
  for (const candidate of [parent, path]) {
    try {
      if (lstatSync(candidate).isSymbolicLink() || realpathSync(candidate) !== candidate) throw new Error('Managed workspace is a filesystem alias');
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  }
  return path;
}
export function describeLocalCheckout(agentsRoot: string, repo: string, runId: string): { path: string; commonDirectory: string; workspacePath: string } {
  parameters(repo, runId);
  const path = realpathSync(join(agentsRoot, repoBasename(repo)));
  const origin = execFileSync('git', ['-C', path, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin);
  if (match?.[1]?.toLowerCase() !== repo.toLowerCase()) throw new Error('Checkout origin does not match the selected galleon');
  return { path, commonDirectory: commonGitDirectory(path), workspacePath: intendedWorkspace(path, runId) };
}
function assertWorkspaceAvailable(path: string): void {
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; throw error; }
  throw new Error('Managed workspace already exists; reconcile its owner before preparing another attempt');
}
async function fetchOwned(repoDir: string, ref: string, runId: string, attempt: number, use: (commit: string) => Promise<Worktree>): Promise<Worktree> {
  const ownedRef = `refs/helmsman/runs/${runId}/attempt-${attempt}/${randomUUID()}`;
  let commit: string | undefined;
  try {
    await run('git', ['-C', repoDir, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', `${ref}:${ownedRef}`], { maxBuffer: 1024 * 1024 * 16 });
    commit = (await run('git', ['-C', repoDir, 'rev-parse', '--verify', `${ownedRef}^{commit}`])).stdout.trim();
    return await use(commit);
  } finally {
    if (commit) await run('git', ['-C', repoDir, 'update-ref', '-d', ownedRef, commit]);
  }
}
export async function createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree> {
  const checkout = describeLocalCheckout(agentsRoot, repo, runId); const branch = `agent/${runId}`;
  return withWorktreeMaintenance(checkout.path, async () => {
    const current = describeLocalCheckout(agentsRoot, repo, runId);
    if (JSON.stringify(current) !== JSON.stringify(checkout)) throw new Error('Checkout identity changed');
    assertWorkspaceAvailable(checkout.workspacePath);
    await run('git', ['-C', checkout.path, 'worktree', 'add', '-b', branch, checkout.workspacePath], { maxBuffer: 1024 * 1024 * 16 });
    return { path: checkout.workspacePath, branch };
  });
}
export async function createWorktreeFromBranch(agentsRoot: string, repo: string, runId: string, branch: string, expectedHeadSha?: string, attempt = 1): Promise<Worktree> {
  parameters(repo, runId, attempt);
  if (expectedHeadSha !== undefined && !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(expectedHeadSha)) throw new Error('Invalid retained PR head');
  await run('git', ['check-ref-format', `refs/heads/${branch}`]);
  const checkout = describeLocalCheckout(agentsRoot, repo, runId);
  return withWorktreeMaintenance(checkout.path, async () => {
    if (JSON.stringify(describeLocalCheckout(agentsRoot, repo, runId)) !== JSON.stringify(checkout)) throw new Error('Checkout identity changed');
    assertWorkspaceAvailable(checkout.workspacePath);
    return fetchOwned(checkout.path, `refs/heads/${branch}`, runId, attempt, async commit => {
      if (expectedHeadSha && commit.toLowerCase() !== expectedHeadSha.toLowerCase()) throw new Error('PR branch changed after preparation');
      await run('git', ['-C', checkout.path, 'branch', '-f', '--', branch, commit]);
      await run('git', ['-C', checkout.path, 'worktree', 'add', checkout.workspacePath, branch], { maxBuffer: 1024 * 1024 * 16 });
      return { path: checkout.workspacePath, branch };
    });
  });
}
export async function createReviewWorktree(agentsRoot: string, repo: string, runId: string, prNumber: number, headSha: string, attempt = 1): Promise<Worktree> {
  parameters(repo, runId, attempt);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(headSha)) throw new Error('Invalid pinned PR review worktree parameters');
  const checkout = describeLocalCheckout(agentsRoot, repo, runId);
  return withWorktreeMaintenance(checkout.path, async () => {
    if (JSON.stringify(describeLocalCheckout(agentsRoot, repo, runId)) !== JSON.stringify(checkout)) throw new Error('Checkout identity changed');
    assertWorkspaceAvailable(checkout.workspacePath);
    return fetchOwned(checkout.path, `refs/pull/${prNumber}/head`, runId, attempt, async fetchedCommit => {
      const commit = (await run('git', ['-C', checkout.path, 'rev-parse', '--verify', `${headSha}^{commit}`])).stdout.trim();
      if (commit.toLowerCase() !== headSha.toLowerCase()) throw new Error('Pinned PR revision is not a commit');
      if (commit.toLowerCase() !== fetchedCommit.toLowerCase()) await run('git', ['-C', checkout.path, 'merge-base', '--is-ancestor', commit, fetchedCommit]);
      await run('git', ['-C', checkout.path, 'worktree', 'add', '--detach', checkout.workspacePath, headSha], { maxBuffer: 1024 * 1024 * 16 });
      return { path: checkout.workspacePath, branch: headSha };
    });
  });
}

export async function detachRetainedFeedbackWorktree(agentsRoot: string, repo: string, runId: string, path: string, branch: string): Promise<void> {
  if (!isGithubRepo(repo) || !/^[a-z\d_-]{1,128}$/i.test(runId)) throw new Error('Invalid retained feedback workspace');
  const repoDir = await realpath(join(agentsRoot, repoBasename(repo)));
  await withWorktreeMaintenance(repoDir, async () => {
  const retainedPath = await realpath(path);
  if (retainedPath !== join(repoDir, '.worktrees', runId)) throw new Error('Retained feedback workspace is outside the owned run path');
  await run('git', ['check-ref-format', `refs/heads/${branch}`]);
  const [repoCommon, worktreeCommon, registered, ref, head] = await Promise.all([
    run('git', ['-C', repoDir, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    run('git', ['-C', retainedPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain', '-z']),
    run('git', ['-C', retainedPath, 'symbolic-ref', '-q', 'HEAD']).catch(error => {
      if ((error as { code?: unknown })?.code === 1) return { stdout: '' };
      throw error;
    }),
    run('git', ['-C', retainedPath, 'rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (await realpath(repoCommon.stdout.trim()) !== await realpath(worktreeCommon.stdout.trim())
    || !registered.stdout.split('\0').includes(`worktree ${retainedPath}`) || ref.stdout.trim() && ref.stdout.trim() !== `refs/heads/${branch}`
    || !/^[a-f\d]{40,64}$/.test(head.stdout.trim())) throw new Error('Retained feedback workspace identity changed');
  if (ref.stdout.trim()) await run('git', ['-C', retainedPath, 'update-ref', '--no-deref', 'HEAD', head.stdout.trim(), head.stdout.trim()]);
  });
}

async function assertManagedWorktree(repoDir: string, worktreePath: string): Promise<void> {
  const canonicalRepo = await realpath(repoDir); const canonicalPath = await realpath(worktreePath);
  if (canonicalPath !== resolve(worktreePath) || dirname(canonicalPath) !== join(canonicalRepo, '.worktrees')
    || commonGitDirectory(canonicalRepo) !== commonGitDirectory(canonicalPath)) throw new Error('Worktree ownership identity changed');
  const registered = (await run('git', ['-C', canonicalRepo, 'worktree', 'list', '--porcelain', '-z'])).stdout;
  if (!registered.split('\0').includes(`worktree ${canonicalPath}`)) throw new Error('Worktree is no longer registered');
}
export interface ManagedWorktreeIdentity {
  version: 1;
  workspace: { path: string; device: string; inode: string; birthtime: string };
  administration: { path: string; device: string; inode: string; birthtime: string };
  commonDirectory: string;
}
export async function captureManagedWorktreeIdentity(repoDir: string, worktreePath: string): Promise<ManagedWorktreeIdentity> {
  await assertManagedWorktree(repoDir, worktreePath);
  const workspace = await realpath(worktreePath); const commonDirectory = commonGitDirectory(repoDir);
  const administration = await realpath((await run('git', ['-C', workspace, 'rev-parse', '--absolute-git-dir'])).stdout.trim());
  if (dirname(administration) !== join(commonDirectory, 'worktrees')) throw new Error('Worktree administration is outside its owning Git directory');
  const describe = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worktree directory identity changed');
    return { path, device: stat.dev.toString(), inode: stat.ino.toString(), birthtime: stat.birthtimeNs.toString() };
  };
  return { version: 1, workspace: describe(workspace), administration: describe(administration), commonDirectory };
}
export async function assertManagedWorktreeIdentity(repoDir: string, worktreePath: string, expected: ManagedWorktreeIdentity): Promise<void> {
  const actual = await captureManagedWorktreeIdentity(repoDir, worktreePath);
  if (!expected || expected.version !== 1 || expected.commonDirectory !== actual.commonDirectory
    || expected.workspace?.path !== actual.workspace.path || expected.workspace?.device !== actual.workspace.device || expected.workspace?.inode !== actual.workspace.inode || expected.workspace?.birthtime !== actual.workspace.birthtime
    || expected.administration?.path !== actual.administration.path || expected.administration?.device !== actual.administration.device || expected.administration?.inode !== actual.administration.inode || expected.administration?.birthtime !== actual.administration.birthtime)
    throw new Error('Managed worktree was replaced; retained ownership no longer proves cleanup authority');
}

export async function verifyWorktreeAbsent(repoDir: string, worktreePath: string): Promise<boolean> {
  const canonicalRepo = await realpath(repoDir); const path = resolve(worktreePath);
  if (dirname(path) !== join(canonicalRepo, '.worktrees')) throw new Error('Worktree is outside the managed workspace directory');
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  const registered = (await run('git', ['-C', canonicalRepo, 'worktree', 'list', '--porcelain', '-z'])).stdout;
  return !registered.split('\0').includes(`worktree ${path}`);
}

export async function verifyWorktreeDetached(repoDir: string, worktreePath: string): Promise<boolean> {
  await assertManagedWorktree(repoDir, worktreePath);
  try {
    await run('git', ['-C', worktreePath, 'symbolic-ref', '-q', 'HEAD']);
    return false;
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 1) throw error;
    await run('git', ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}']);
    return true;
  }
}

export async function removeWorktreeAt(repoDir: string, worktreePath: string): Promise<void> {
  await withWorktreeMaintenance(repoDir, async () => {
    await assertManagedWorktree(repoDir, worktreePath);
  await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]);
    if (!await verifyWorktreeAbsent(repoDir, worktreePath)) throw new Error('Worktree removal was not confirmed');
  });
}

export async function removeCleanWorktreeAt(repoDir: string, worktreePath: string): Promise<void> {
  await withWorktreeMaintenance(repoDir, async () => {
  const [canonicalRepo, canonicalWorktree] = await Promise.all([realpath(repoDir), realpath(worktreePath)]);
  if (dirname(canonicalWorktree) !== join(canonicalRepo, '.worktrees')) throw new Error('Worktree is outside the managed workspace directory');
  const [repoCommon, worktreeCommon, registered, status] = await Promise.all([
    run('git', ['-C', canonicalRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    run('git', ['-C', canonicalWorktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    run('git', ['-C', canonicalRepo, 'worktree', 'list', '--porcelain', '-z']),
    run('git', ['-C', canonicalWorktree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z']),
  ]);
  if (await realpath(repoCommon.stdout.trim()) !== await realpath(worktreeCommon.stdout.trim())) throw new Error('Worktree belongs to a different galleon');
  const paths = registered.stdout.split('\0').flatMap(record => record.startsWith('worktree ') ? [record.slice('worktree '.length).split('\n')[0] ?? ''] : []);
  if (!paths.some(path => resolve(path) === canonicalWorktree)) throw new Error('Worktree is no longer registered');
  if (status.stdout.length > 0) throw new Error('Worktree contains changes');
  await run('git', ['-C', canonicalRepo, 'worktree', 'remove', '--', canonicalWorktree]);
    if (!await verifyWorktreeAbsent(repoDir, worktreePath)) throw new Error('Worktree removal was not confirmed');
  });
}

export async function removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await removeWorktreeAt(repoDir, worktreePath);
}

export async function listAgentWorktrees(repoDir: string): Promise<string[]> {
  try {
    const result: { stdout: string; stderr: string } = await run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
    const workspace: string = join(await realpath(repoDir), '.worktrees');
    const paths: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path: string = line.slice('worktree '.length).trim();
      if (dirname(resolve(path)) === workspace) paths.push(path);
    }
    return paths;
  } catch (err: unknown) {
    process.stderr.write(`worktree list failed for ${repoDir}: ${String(err)}\n`);
    return [];
  }
}

export async function discoverRepoDirs(agentsRoot: string): Promise<string[]> {
  try {
    const entries: import('node:fs').Dirent[] = await readdir(agentsRoot, { withFileTypes: true });
    return entries
      .filter((entry: import('node:fs').Dirent): boolean => entry.isDirectory())
      .map((entry: import('node:fs').Dirent): string => join(agentsRoot, entry.name))
      .filter((dir: string): boolean => existsSync(join(dir, '.worktrees')));
  } catch (err: unknown) {
    process.stderr.write(`repo-dir discovery failed for ${agentsRoot}: ${String(err)}\n`);
    return [];
  }
}

export interface WorktreeSweepDeps {
  listAgentWorktrees: (repoDir: string) => Promise<string[]>;
  remove: (repoDir: string, path: string) => Promise<void>;
  isActiveRunId: (runId: string) => boolean;
  isEligibleWorktree: (repoDir: string, path: string, runId: string) => Promise<boolean>;
  repoDirs: string[];
}

export async function sweepOrphanedWorktrees(deps: WorktreeSweepDeps): Promise<string[]> {
  const removed: string[] = [];
  for (const repoDir of deps.repoDirs) {
    try {
      const paths: string[] = await deps.listAgentWorktrees(repoDir);
      for (const path of paths) {
        const runId: string = basename(path);
        if (deps.isActiveRunId(runId)) continue;
        if (!await deps.isEligibleWorktree(repoDir, path, runId)) continue;
        try {
          await deps.remove(repoDir, path);
          removed.push(path);
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return removed;
}
