import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

export async function createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  const branch: string = `agent/${runId}`;
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, path], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}


export async function createWorktreeFromBranch(agentsRoot: string, repo: string, runId: string, branch: string, expectedHeadSha?: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  if (expectedHeadSha !== undefined) {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(expectedHeadSha)) throw new Error('Invalid retained PR head');
    await run('git', ['check-ref-format', `refs/heads/${branch}`]);
    await run('git', ['-C', repoDir, 'fetch', '--no-tags', 'origin', `refs/heads/${branch}`], { maxBuffer: 1024 * 1024 * 16 });
    const fetched = await run('git', ['-C', repoDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (fetched.stdout.trim().toLowerCase() !== expectedHeadSha.toLowerCase()) throw new Error('PR branch changed after preparation');
  }
  if (expectedHeadSha !== undefined) await run('git', ['-C', repoDir, 'branch', '-f', '--', branch, expectedHeadSha]);
  else await run('git', ['-C', repoDir, 'fetch', 'origin', `+${branch}:${branch}`], { maxBuffer: 1024 * 1024 * 16 });
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', path, branch], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}

export async function createReviewWorktree(agentsRoot: string, repo: string, runId: string, prNumber: number, headSha: string): Promise<Worktree> {
  if (!isGithubRepo(repo) || !/^[a-z\d_-]{1,128}$/i.test(runId)
    || !Number.isSafeInteger(prNumber) || prNumber < 1 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(headSha)) {
    throw new Error('Invalid pinned PR review worktree parameters');
  }
  const repoDir = join(agentsRoot, repoBasename(repo));
  const path = join(repoDir, '.worktrees', runId);
  const options = { maxBuffer: 1024 * 1024 * 16 };
  await run('git', ['-C', repoDir, 'fetch', '--no-tags', 'origin', `refs/pull/${prNumber}/head`], options);
  const commit = await run('git', ['-C', repoDir, 'rev-parse', '--verify', `${headSha}^{commit}`], options);
  if (commit.stdout.trim().toLowerCase() !== headSha.toLowerCase()) throw new Error('Pinned PR revision is not a commit');
  await run('git', ['-C', repoDir, 'worktree', 'add', '--detach', path, headSha], options);
  return { path, branch: headSha };
}

export async function removeWorktreeAt(repoDir: string, worktreePath: string): Promise<void> {
  await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]);
}

export async function removeCleanWorktreeAt(repoDir: string, worktreePath: string): Promise<void> {
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
}

export async function removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await removeWorktreeAt(repoDir, worktreePath).catch(() => undefined);
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
