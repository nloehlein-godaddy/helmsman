import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachRetainedFeedbackWorktree, createReviewWorktree, createWorktreeFromBranch, sweepOrphanedWorktrees, discoverRepoDirs, listAgentWorktrees, removeCleanWorktreeAt, type Worktree } from './worktree';

const execFileAsync = promisify(execFile);

// These drive real git through several worktree adds and fetches per test.
// Windows git is slow enough to exceed the 5s default, and the work is I/O
// bound, so a generous ceiling costs nothing when the tests pass.
vi.setConfig({ testTimeout: 60_000 });

async function fixtureOrigin(path: string, source: string, repo: string) {
  await execFileAsync('git', ['-C', path, 'config', 'remote.origin.url', `https://github.com/${repo}.git`]);
  await execFileAsync('git', ['-C', path, 'config', `url.${source}.insteadOf`, `https://github.com/${repo}.git`]);
}

describe('createReviewWorktree', () => {
  it('pins the classified commit through the PR ref while preserving existing branch worktrees', async () => {
    const agentsRoot = await mkdtemp(join(tmpdir(), 'review-agents-'));
    try {
      const sourceDir = join(agentsRoot, 'source');
      const repoDir = join(agentsRoot, 'repo');
      await mkdir(sourceDir);
      await execFileAsync('git', ['-C', sourceDir, 'init', '-q', '-b', 'main']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'base']);
      const base = (await execFileAsync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
      await execFileAsync('git', ['clone', '-q', sourceDir, repoDir]);
      await fixtureOrigin(repoDir, sourceDir, 'org/repo');
      const existingPath = join(repoDir, '.worktrees', 'existing');
      await execFileAsync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'fix/x', existingPath]);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'classified revision']);
      const expected = (await execFileAsync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'newer revision']);
      await execFileAsync('git', ['-C', sourceDir, 'update-ref', 'refs/pull/42/head', 'HEAD']);

      const worktree = await createReviewWorktree(agentsRoot, 'org/repo', 'review-one', 42, expected);
      expect((await execFileAsync('git', ['-C', worktree.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(expected);
      expect((await execFileAsync('git', ['-C', worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('HEAD');
      expect(existsSync(existingPath)).toBe(true);
      expect((await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'fix/x'])).stdout.trim()).toBe(base);
      expect((await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'main'])).stdout.trim()).toBe(base);

      await expect(createReviewWorktree(agentsRoot, 'org/repo', 'review-missing', 42, 'f'.repeat(40))).rejects.toThrow();
      expect(existsSync(join(repoDir, '.worktrees', 'review-missing'))).toBe(false);
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['../repo', 'review-one', 42, 'a'.repeat(40)],
    ['org/repo', '../outside', 42, 'a'.repeat(40)],
    ['org/repo', 'review-one', -1, 'a'.repeat(40)],
    ['org/repo', 'review-one', 42, '--help'],
    ['org/repo', 'review-one', 42, 'a'.repeat(41)],
  ])('rejects invalid pinned checkout arguments %j %j %j %j', async (repo, runId, number, sha) => {
    await expect(createReviewWorktree('/unused', repo as string, runId as string, number as number, sha as string)).rejects.toThrow(/Invalid (pinned PR review worktree parameters|managed worktree identity)/);
  });
});

describe('createWorktreeFromBranch', () => {
  it('checks out an existing branch into a run-scoped worktree without creating a new branch', async () => {
    const agentsRoot: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      const sourceDir: string = join(agentsRoot, 'source');
      await mkdir(sourceDir, { recursive: true });
      await execFileAsync('git', ['-C', sourceDir, 'init', '-q', '-b', 'main']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await execFileAsync('git', ['-C', sourceDir, 'branch', 'fix/x']);

      const repoDir: string = join(agentsRoot, 'repo');
      await execFileAsync('git', ['clone', '-q', sourceDir, repoDir]);
      await fixtureOrigin(repoDir, sourceDir, 'o/repo');

      const result: Worktree = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-1', 'fix/x');

      expect(result.branch).toBe('fix/x');
      expect(result.path).toBe(join(await realpath(repoDir), '.worktrees', 'run-1'));
      expect(existsSync(result.path)).toBe(true);
      const head = await execFileAsync('git', ['-C', result.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(head.stdout.trim()).toBe('fix/x');
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });

  it('force-refreshes the local branch ref so a second rerun sees the latest remote commit, not a stale local ref', async () => {
    const agentsRoot: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      const sourceDir: string = join(agentsRoot, 'source');
      await mkdir(sourceDir, { recursive: true });
      await execFileAsync('git', ['-C', sourceDir, 'init', '-q', '-b', 'main']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await execFileAsync('git', ['-C', sourceDir, 'branch', 'fix/x']);

      const repoDir: string = join(agentsRoot, 'repo');
      await execFileAsync('git', ['clone', '-q', sourceDir, repoDir]);
      await fixtureOrigin(repoDir, sourceDir, 'o/repo');

      const first: Worktree = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-1', 'fix/x');
      await execFileAsync('git', ['-C', repoDir, 'worktree', 'remove', '--force', first.path]);

      await execFileAsync('git', ['-C', sourceDir, 'checkout', '-q', 'fix/x']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '--amend', '-m', 'commit B (divergent, not a descendant of the cached local ref)']);
      const expectedSha: { stdout: string; stderr: string } = await execFileAsync('git', ['-C', sourceDir, 'rev-parse', 'fix/x']);

      const second: Worktree = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-2', 'fix/x');

      const actualSha = await execFileAsync('git', ['-C', second.path, 'rev-parse', 'HEAD']);
      expect(actualSha.stdout.trim()).toBe(expectedSha.stdout.trim());
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });
  it('refuses to replace a prior rerun worktree even when it is clean', async () => {
    const agentsRoot: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      const sourceDir: string = join(agentsRoot, 'source');
      await mkdir(sourceDir, { recursive: true });
      await execFileAsync('git', ['-C', sourceDir, 'init', '-q', '-b', 'main']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await execFileAsync('git', ['-C', sourceDir, 'branch', 'fix/x']);

      const repoDir: string = join(agentsRoot, 'repo');
      await execFileAsync('git', ['clone', '-q', sourceDir, repoDir]);
      await fixtureOrigin(repoDir, sourceDir, 'o/repo');

      const first: Worktree = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-1', 'fix/x');
      expect(existsSync(first.path)).toBe(true);

      await expect(createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-2', 'fix/x')).rejects.toThrow();
      expect(existsSync(join(repoDir, '.worktrees', 'run-2'))).toBe(false);
      expect(existsSync(first.path)).toBe(true);
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });
});

describe('sweepOrphanedWorktrees', () => {
  it('removes only orphaned worktrees, leaving active runs untouched', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const removed: string[] = await sweepOrphanedWorktrees({
      repoDirs: ['/agents/r'],
      listAgentWorktrees: async () => ['/agents/r/.worktrees/run-A', '/agents/r/.worktrees/run-B'],
      remove,
      isActiveRunId: (runId: string) => runId === 'run-A',
      isEligibleWorktree: async (_repoDir: string, _path: string, runId: string) => runId === 'run-B',
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-B');
    expect(removed).toEqual(['/agents/r/.worktrees/run-B']);
  });

  it('continues sweeping when one removal rejects', async () => {
    const remove = vi.fn().mockImplementation((_repoDir: string, path: string) => {
      if (path === '/agents/r/.worktrees/run-A') return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });
    const removed: string[] = await sweepOrphanedWorktrees({
      repoDirs: ['/agents/r'],
      listAgentWorktrees: async () => ['/agents/r/.worktrees/run-A', '/agents/r/.worktrees/run-B'],
      remove,
      isActiveRunId: () => false,
      isEligibleWorktree: async () => true,
    });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-A');
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-B');
    expect(removed).toEqual(['/agents/r/.worktrees/run-B']);
  });
});

describe('startup worktree sweep', () => {
  it('removes only a clean retained workspace and preserves dirty or unrelated registered checkouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'startup-worktree-sweep-'));
    try {
      const repo = join(root, 'repo');
      await mkdir(repo);
      const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      await writeFile(join(repo, 'tracked.txt'), 'base');
      await git('add', '.');
      await git('commit', '-qm', 'base');
      const owned = join(repo, '.worktrees', 'run-owned');
      const dirty = join(repo, '.worktrees', 'developer-work');
      const foreign = join(root, 'developer', '.worktrees', 'personal-feature');
      await git('worktree', 'add', '-b', 'agent/run-owned', owned);
      await git('worktree', 'add', '-b', 'developer-work', dirty);
      await git('worktree', 'add', '-b', 'personal-feature', foreign);
      await writeFile(join(dirty, 'tracked.txt'), 'unsaved tracked work');
      await writeFile(join(dirty, 'untracked.txt'), 'untracked work');
      await writeFile(join(foreign, 'tracked.txt'), 'foreign tracked work');
      await writeFile(join(foreign, 'untracked.txt'), 'foreign untracked work');
      const [canonicalOwned, canonicalDirty, canonicalForeign] = await Promise.all([realpath(owned), realpath(dirty), realpath(foreign)]);
      const listed = await listAgentWorktrees(repo);
      expect(listed).toEqual(expect.arrayContaining([canonicalOwned, canonicalDirty]));
      expect(listed).not.toContain(canonicalForeign);

      let removalError: unknown;
      const removed = await sweepOrphanedWorktrees({
        repoDirs: [repo], listAgentWorktrees, remove: async (repoDir, path) => {
          try { await removeCleanWorktreeAt(repoDir, path); } catch (error) { removalError = error; throw error; }
        }, isActiveRunId: () => false,
        isEligibleWorktree: async (_repoDir, path, runId) => runId === 'run-owned' && path === canonicalOwned,
      });

      expect(removalError).toBeUndefined();
      expect(removed).toEqual([canonicalOwned]);
      expect(existsSync(owned)).toBe(false);
      expect(await readFile(join(dirty, 'tracked.txt'), 'utf8')).toBe('unsaved tracked work');
      expect(await readFile(join(dirty, 'untracked.txt'), 'utf8')).toBe('untracked work');
      expect(await readFile(join(foreign, 'tracked.txt'), 'utf8')).toBe('foreign tracked work');
      expect(await readFile(join(foreign, 'untracked.txt'), 'utf8')).toBe('foreign untracked work');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not remove a dirty retained workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dirty-startup-worktree-sweep-'));
    try {
      const repo = join(root, 'repo');
      await mkdir(repo);
      const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      await git('commit', '-q', '--allow-empty', '-m', 'base');
      const owned = join(repo, '.worktrees', 'run-owned');
      await git('worktree', 'add', '-b', 'agent/run-owned', owned);
      await writeFile(join(owned, 'untracked.txt'), 'unsaved work');

      const removed = await sweepOrphanedWorktrees({
        repoDirs: [repo], listAgentWorktrees, remove: removeCleanWorktreeAt, isActiveRunId: () => false,
        isEligibleWorktree: async () => true,
      });

      expect(removed).toEqual([]);
      expect(await readFile(join(owned, 'untracked.txt'), 'utf8')).toBe('unsaved work');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('discoverRepoDirs', () => {
  it('returns only subdirectories that contain a .worktrees dir', async () => {
    const root: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      await mkdir(join(root, 'repo-a', '.worktrees'), { recursive: true });
      await mkdir(join(root, 'repo-b'), { recursive: true });
      const dirs: string[] = await discoverRepoDirs(root);
      expect(dirs).toEqual([join(root, 'repo-a')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns [] for a nonexistent root without throwing', async () => {
    const dirs: string[] = await discoverRepoDirs(join(tmpdir(), 'does-not-exist-xyz-123'));
    expect(dirs).toEqual([]);
  });
});

it('rejects a moved rerun head before removing the original branch worktree', async () => {
  const agentsRoot = await mkdtemp(join(tmpdir(), 'pinned-rerun-'));
  try {
    const source = join(agentsRoot, 'source'); const repo = join(agentsRoot, 'repo');
    await mkdir(source);
    await execFileAsync('git', ['-C', source, 'init', '-q', '-b', 'main']);
    await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', source, 'config', 'user.name', 'Test']);
    await execFileAsync('git', ['-C', source, 'commit', '-q', '--allow-empty', '-m', 'original']);
    await execFileAsync('git', ['-C', source, 'switch', '-qc', 'fix/pinned']);
    const original = (await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFileAsync('git', ['clone', '-q', source, repo]);
    await fixtureOrigin(repo, source, 'o/repo');
    await expect(createWorktreeFromBranch(agentsRoot, 'o/repo', 'checked-out', 'fix/pinned', original)).rejects.toThrow();
    expect((await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(original);
    await execFileAsync('git', ['-C', repo, 'switch', '-q', 'main']);
    const first = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'first', 'fix/pinned', original);
    expect((await execFileAsync('git', ['-C', first.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(original);
    await execFileAsync('git', ['-C', source, 'commit', '-q', '--allow-empty', '-m', 'replacement']);
    await expect(createWorktreeFromBranch(agentsRoot, 'o/repo', 'second', 'fix/pinned', original)).rejects.toThrow('PR branch changed');
    expect(existsSync(first.path)).toBe(true); expect(existsSync(join(repo, '.worktrees', 'second'))).toBe(false);
  } finally { await rm(agentsRoot, { recursive: true, force: true }); }
});


it.each([true, false])('preserves an occupied dirty developer worktree with retained head verification %s', async pinned => {
  const root = await mkdtemp(join(tmpdir(), 'dirty-rerun-'));
  try {
    const source = join(root, 'source'); const repo = join(root, 'repo'); const developer = join(root, 'developer checkout');
    await mkdir(source);
    await execFileAsync('git', ['-C', source, 'init', '-q', '-b', 'main']);
    await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', source, 'config', 'user.name', 'Test']);
    await writeFile(join(source, 'tracked.txt'), 'original');
    await execFileAsync('git', ['-C', source, 'add', '.']);
    await execFileAsync('git', ['-C', source, 'commit', '-qm', 'base']);
    const head = (await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFileAsync('git', ['-C', source, 'branch', 'fix/pr']);
    await execFileAsync('git', ['clone', '-q', source, repo]);
    await fixtureOrigin(repo, source, 'org/repo');
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', developer, 'fix/pr']);
    await writeFile(join(developer, 'tracked.txt'), 'unsaved tracked changes');
    await writeFile(join(developer, 'untracked.txt'), 'untracked work');
    if (pinned) await expect(createWorktreeFromBranch(root, 'org/repo', 'stale', 'fix/pr', 'f'.repeat(40))).rejects.toThrow('PR branch changed');
    await expect(createWorktreeFromBranch(root, 'org/repo', 'rerun', 'fix/pr', pinned ? head : undefined)).rejects.toThrow();
    expect(await readFile(join(developer, 'tracked.txt'), 'utf8')).toBe('unsaved tracked changes');
    expect(await readFile(join(developer, 'untracked.txt'), 'utf8')).toBe('untracked work');
    expect((await execFileAsync('git', ['-C', developer, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect(existsSync(join(repo, '.worktrees', 'rerun'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('detaches only an owned retained checkout, preserving staged, unstaged, untracked and unpublished work on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retained-feedback-'));
  try {
    const source = join(root, 'source'); const repo = join(root, 'repo');
    await mkdir(source);
    await execFileAsync('git', ['-C', source, 'init', '-q', '-b', 'main']);
    await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', source, 'config', 'user.name', 'Test']);
    await writeFile(join(source, 'tracked.txt'), 'original');
    await execFileAsync('git', ['-C', source, 'add', '.']);
    await execFileAsync('git', ['-C', source, 'commit', '-qm', 'base']);
    const published = (await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFileAsync('git', ['-C', source, 'branch', 'fix/pr']);
    await execFileAsync('git', ['clone', '-q', source, repo]);
    await fixtureOrigin(repo, source, 'org/repo');
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    const previous = await createWorktreeFromBranch(root, 'org/repo', 'previous', 'fix/pr', published);
    await execFileAsync('git', ['-C', previous.path, 'commit', '-q', '--allow-empty', '-m', 'unpublished']);
    const unpublished = (await execFileAsync('git', ['-C', previous.path, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(previous.path, 'tracked.txt'), 'staged');
    await execFileAsync('git', ['-C', previous.path, 'add', '.']);
    await writeFile(join(previous.path, 'tracked.txt'), 'unstaged');
    await writeFile(join(previous.path, 'untracked.txt'), 'untracked');
    const before = (await execFileAsync('git', ['-C', previous.path, 'status', '--porcelain=v1'])).stdout;
    await expect(detachRetainedFeedbackWorktree(root, 'org/repo', 'other', previous.path, 'fix/pr')).rejects.toThrow('owned run path');
    await expect(detachRetainedFeedbackWorktree(root, 'org/repo', 'previous', previous.path, 'wrong-branch')).rejects.toThrow('identity changed');
    await detachRetainedFeedbackWorktree(root, 'org/repo', 'previous', previous.path, 'fix/pr');
    await detachRetainedFeedbackWorktree(root, 'org/repo', 'previous', previous.path, 'fix/pr');
    const next = await createWorktreeFromBranch(root, 'org/repo', 'next', 'fix/pr', published);
    expect((await execFileAsync('git', ['-C', next.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(published);
    expect((await execFileAsync('git', ['-C', previous.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(unpublished);
    expect((await execFileAsync('git', ['-C', previous.path, 'status', '--porcelain=v1'])).stdout).toBe(before);
    expect((await execFileAsync('git', ['-C', previous.path, 'show', ':tracked.txt'])).stdout).toBe('staged');
    expect(await readFile(join(previous.path, 'tracked.txt'), 'utf8')).toBe('unstaged');
    expect(await readFile(join(previous.path, 'untracked.txt'), 'utf8')).toBe('untracked');
  } finally { await rm(root, { recursive: true, force: true }); }
});
