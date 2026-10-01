// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commonGitDirectory, withWorktreeMaintenance } from './worktree-maintenance';
import { captureManagedWorktreeIdentity, assertManagedWorktreeIdentity, createWorktreeFromBranch, createReviewWorktree, describeLocalCheckout, verifyWorktreeAbsent, verifyWorktreeDetached, detachRetainedFeedbackWorktree, removeWorktreeAt } from './worktree';
const execute = promisify(execFile); const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hm-parallel-git-'))); directories.push(root);
  const source = join(root, 'source'); const repo = join(root, 'repo'); await mkdir(source);
  const git = async (path: string, ...args: string[]) => (await execute('git', ['-C', path, ...args])).stdout.trim();
  await git(source, 'init', '-q', '-b', 'main'); await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.com');
  await git(source, 'commit', '-q', '--allow-empty', '-m', 'base'); await execute('git', ['clone', '-q', source, repo]);
  await git(repo, 'config', 'remote.origin.url', 'https://github.com/org/repo.git'); await git(repo, 'config', `url.${source}.insteadOf`, 'https://github.com/org/repo.git');
  const head = await git(source, 'rev-parse', 'HEAD');
  return { root, source, repo, git, head };
}
it('serializes independent owners while allowing nested cleanup helpers', async () => {
  const f = await fixture(); const order: string[] = []; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const first = withWorktreeMaintenance(f.repo, async () => {
    order.push('first'); await withWorktreeMaintenance(f.repo, async () => { order.push('nested'); }); entered();
    await new Promise<void>(done => { release = done; }); order.push('released');
  });
  await started;
  const second = withWorktreeMaintenance(f.repo, async () => { order.push('second'); }); release(); await Promise.all([first, second]);
  expect(order).toEqual(['first', 'nested', 'released', 'second']);
});
it('does not steal a crashed owner lock or interpret elapsed time as permission', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
    `import {withWorktreeMaintenance} from ${JSON.stringify(new URL('./worktree-maintenance.ts', import.meta.url).href)}; await withWorktreeMaintenance(process.argv[1],async()=>{process.stdout.write('locked\\n');setInterval(()=>{},1000);await new Promise(()=>{});});` , f.repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error(`Lock owner exited ${code}`))); });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await exited;
    await expect(withWorktreeMaintenance(f.repo, async () => {}, 20)).rejects.toThrow('recovery must verify');
    expect(existsSync(join(commonGitDirectory(f.repo), 'helmsman-maintenance.lock', 'owner.json'))).toBe(true);
  } finally { child.kill('SIGKILL'); }
});
it('prepares concurrent independent branches without modifying shared FETCH_HEAD', async () => {
  const f = await fixture(); await f.git(f.source, 'branch', 'one'); await f.git(f.source, 'branch', 'two');
  const shared = join(commonGitDirectory(f.repo), 'FETCH_HEAD'); await writeFile(shared, 'preserved unrelated fetch\n');
  const [one, two] = await Promise.all([createWorktreeFromBranch(f.root, 'org/repo', 'one', 'one', f.head, 1), createWorktreeFromBranch(f.root, 'org/repo', 'two', 'two', f.head, 2)]);
  expect(await f.git(one.path, 'rev-parse', 'HEAD')).toBe(f.head); expect(await f.git(two.path, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(shared, 'utf8')).toBe('preserved unrelated fetch\n'); expect(await f.git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/helmsman/runs')).toBe('');
  await removeWorktreeAt(f.repo, one.path); expect(await verifyWorktreeAbsent(f.repo, one.path)).toBe(true);
  expect(await verifyWorktreeAbsent(f.repo, two.path)).toBe(false);
});
it('rejects wrong galleon authority, workspace symlinks, and unrelated cached review heads', async () => {
  const f = await fixture(); expect(() => describeLocalCheckout(f.root, 'another/repo', 'run')).toThrow('origin');
  const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere); await symlink(elsewhere, join(f.repo, '.worktrees'));
  expect(() => describeLocalCheckout(f.root, 'org/repo', 'run')).toThrow('alias'); await rm(join(f.repo, '.worktrees'));
  await f.git(f.source, 'update-ref', 'refs/pull/1/head', f.head);
  await f.git(f.repo, 'config', 'user.name', 'Fixture'); await f.git(f.repo, 'config', 'user.email', 'fixture@example.com');
  await f.git(f.repo, 'checkout', '--orphan', 'unrelated'); await f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  const unrelated = await f.git(f.repo, 'rev-parse', 'HEAD');
  await expect(createReviewWorktree(f.root, 'org/repo', 'review', 1, unrelated)).rejects.toThrow();
  expect(existsSync(join(f.repo, '.worktrees', 'review'))).toBe(false);
});

it('rejects retained cleanup proof after a worktree is removed and recreated at the same path', async () => {
  const f = await fixture(); await f.git(f.source, 'branch', 'one');
  const worktree = await createWorktreeFromBranch(f.root, 'org/repo', 'reused', 'one', f.head);
  const identity = await captureManagedWorktreeIdentity(f.repo, worktree.path);
  await assertManagedWorktreeIdentity(f.repo, worktree.path, identity);
  await removeWorktreeAt(f.repo, worktree.path);
  await f.git(f.repo, 'worktree', 'add', '--detach', worktree.path, f.head);
  await expect(assertManagedWorktreeIdentity(f.repo, worktree.path, identity)).rejects.toThrow('replaced');
  expect(existsSync(worktree.path)).toBe(true);
});

it('confirms detached state without losing dirty retained content or accepting another workspace', async () => {
  const f = await fixture(); await f.git(f.source, 'branch', 'one');
  const worktree = await createWorktreeFromBranch(f.root, 'org/repo', 'retained', 'one', f.head);
  expect(await verifyWorktreeDetached(f.repo, worktree.path)).toBe(false);
  await writeFile(join(worktree.path, 'draft.txt'), 'retained draft');
  await detachRetainedFeedbackWorktree(f.root, 'org/repo', 'retained', worktree.path, 'one');
  expect(await verifyWorktreeDetached(f.repo, worktree.path)).toBe(true);
  expect(await readFile(join(worktree.path, 'draft.txt'), 'utf8')).toBe('retained draft');
  await expect(verifyWorktreeDetached(f.repo, f.source)).rejects.toThrow('identity');
});
