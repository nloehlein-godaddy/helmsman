import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createLocalGitService, type LocalGitServerOptions } from './local-git-service';
import { openPersistence, type Persistence } from './persistence';
import type { LocalGitControlCommandV1, LocalGitResponse } from '../../src/plugins/local-git';
import { handleLocalGitApi } from './local-git-routes';

const caller = 'example.local-git/panel'; const stores: Persistence[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const persistence = openPersistence(':memory:'); stores.push(persistence); let binding = 'checkout-1';
  const data: LocalGitResponse = { repo: 'org/a', path: '/fixture/a', branches: [{ name: 'topic', current: false, upstream: null, upstreamStatus: 'none', commit: 'a'.repeat(40), deletionBlockedReason: null }], worktrees: [], error: null };
  const effect = vi.fn(); const read = vi.fn(async () => ({ status: 200, json: structuredClone(data) }));
  const mutate: NonNullable<LocalGitServerOptions['mutate']> = vi.fn(async (_root, _repo, _repos, _input, options) => {
    try { await options?.beforeMutation?.(data); await options?.beforeEffect?.(); effect(); data.branches = []; return { status: 200, json: structuredClone(data) }; }
    catch { return { status: 409, json: { ...data, error: 'Target changed before dispatch' } }; }
  });
  const options: LocalGitServerOptions = { persistence, agentsRoot: '/fixture', repos: () => ['org/a', 'org/b'], authorize: () => {}, read, mutate, identity: async () => binding };
  const service = createLocalGitService(options);
  const command = async (): Promise<LocalGitControlCommandV1> => { const state = await service.snapshot(caller, { version: 1, repo: 'org/a' }, 'org/a'); return { version: 1, requestId: randomUUID(), target: { repo: state.repo, revision: state.revision }, operation: { action: 'delete-branch', branch: 'topic', expectedCommit: 'a'.repeat(40) } }; };
  return { persistence, data, options, effect, read, service, command, binding: (value: string) => { binding = value; } };
}
it('retains successful outcomes across response loss/restart and rejects changed UUID input', async () => {
  const f = setup(); const command = await f.command(); const first = await f.service.control(caller, command, 'org/a'); expect(first.status).toBe('succeeded');
  f.binding('replaced-checkout'); const restarted = createLocalGitService(f.options);
  expect(await restarted.control(caller, command, 'org/a')).toEqual(first); expect(f.effect).toHaveBeenCalledTimes(1);
  await expect(restarted.control(caller, { ...command, operation: { action: 'refresh-remotes' } }, 'org/a')).rejects.toMatchObject({ reason: 'conflict' });
});
it('rejects a replaced checkout before dispatch and preserves foreign scope isolation', async () => {
  const f = setup(); const command = await f.command(); f.binding('replacement');
  expect((await f.service.control(caller, command, 'org/a')).status).toBe('rejected'); expect(f.effect).not.toHaveBeenCalled();
  await expect(f.service.control(caller, command, 'org/b')).rejects.toMatchObject({ reason: 'not-found' });
  expect(f.service.receipt('example.other/panel', { repo: 'org/a', requestId: command.requestId }, 'org/a')).toBeNull();
});
it('persists unknown before effects and never reexecutes a lost or malformed post-effect outcome', async () => {
  const f = setup(); const command = await f.command(); const started = deferred<void>(); const gate = deferred<void>();
  const mutate: NonNullable<LocalGitServerOptions['mutate']> = async (_root, _repo, _repos, _input, options) => {
    await options?.beforeMutation?.(f.data); await options?.beforeEffect?.(); f.effect(); started.resolve(); await gate.promise; throw new Error('Response lost after mutation');
  };
  const service = createLocalGitService({ ...f.options, mutate }); const promise = service.control(caller, command, 'org/a'); await started.promise;
  expect(service.receipt(caller, { repo: 'org/a', requestId: command.requestId }, 'org/a')?.status).toBe('pending');
  expect(service.inspect(caller, command, 'org/a').status).toBe('pending');
  expect(createLocalGitService(f.options).receipt(caller, { repo: 'org/a', requestId: command.requestId }, 'org/a')?.status).toBe('recovery-required');
  gate.resolve(); expect((await promise).status).toBe('recovery-required');
  expect((await createLocalGitService(f.options).control(caller, command, 'org/a')).status).toBe('recovery-required'); expect(f.effect).toHaveBeenCalledTimes(1);
});
it('explicit inspection fences missing and delayed controls without effects', async () => {
  const f = setup(); const command = await f.command(); const started = deferred<void>(); const gate = deferred<void>();
  const mutate: NonNullable<LocalGitServerOptions['mutate']> = async (_root, _repo, _repos, _input, options) => {
    started.resolve(); await gate.promise;
    try { await options?.beforeMutation?.(f.data); await options?.beforeEffect?.(); f.effect(); return { status: 200, json: f.data }; }
    catch { return { status: 409, json: { ...f.data, error: 'Fenced' } }; }
  };
  const service = createLocalGitService({ ...f.options, mutate }); const original = service.control(caller, command, 'org/a'); await started.promise;
  expect(service.receipt(caller, { repo: 'org/a', requestId: command.requestId }, 'org/a')).toBeNull();
  const inspected = service.inspect(caller, command, 'org/a'); expect(inspected.status).toBe('recovery-required'); gate.resolve();
  expect(await original).toEqual(inspected); expect(await createLocalGitService(f.options).control(caller, command, 'org/a')).toEqual(inspected); expect(f.effect).not.toHaveBeenCalled();
});
it('fails closed before mutation when admission storage is unavailable and rejects invalid HTTP scope', async () => {
  const f = setup(); const command = await f.command();
  f.persistence.sql.exec("CREATE TRIGGER reject_local_git_receipts BEFORE INSERT ON local_git_control_receipts BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
  await expect(f.service.control(caller, command, 'org/a')).rejects.toThrow('storage unavailable'); expect(f.effect).not.toHaveBeenCalled();
  expect(await handleLocalGitApi({ caller, service: f.service, method: 'POST', path: '/api/local-git/control', query: new URLSearchParams(), body: { command } })).toMatchObject({ status: 400 });
});

it('rechecks native checkout replacement and active-worktree safety inside the existing serialized mutation path', async () => {
  const run = promisify(execFile); const directory = await realpath(await mkdtemp(join(tmpdir(), 'helmsman-public-git-'))); const checkout = join(directory, 'repo');
  const git = async (...args: string[]) => (await run('git', ['-C', checkout, ...args], { encoding: 'utf8' })).stdout.trim();
  const create = async () => { await mkdir(checkout); await git('init', '--initial-branch=main'); await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'); await git('remote', 'add', 'origin', 'https://github.com/org/repo.git'); await git('branch', 'topic'); await git('config', 'branch.topic.description', 'fixture metadata'); };
  const persistence = openPersistence(':memory:'); stores.push(persistence);
  try {
    await create(); const service = createLocalGitService({ persistence, agentsRoot: directory, repos: () => ['org/repo'], authorize: () => {} });
    const state = await service.snapshot(caller, { version: 1, repo: 'org/repo' }, 'org/repo');
    const command: LocalGitControlCommandV1 = { version: 1, requestId: randomUUID(), target: { repo: state.repo, revision: state.revision }, operation: { action: 'delete-branch', branch: 'topic', expectedCommit: state.branches.find(branch => branch.name === 'topic')!.commit } };
    await rename(checkout, join(directory, 'preserved-original')); await create();
    expect((await service.control(caller, command, 'org/repo')).status).toBe('rejected'); expect(await git('branch', '--list', 'topic')).toContain('topic');
    const fresh = await service.snapshot(caller, { version: 1, repo: 'org/repo' }, 'org/repo');
    const success = await service.control(caller, { ...command, requestId: randomUUID(), target: { repo: fresh.repo, revision: fresh.revision }, operation: { action: 'delete-branch', branch: 'topic', expectedCommit: fresh.branches.find(branch => branch.name === 'topic')!.commit } }, 'org/repo');
    expect(success.status).toBe('succeeded'); expect(await git('branch', '--list', 'topic')).toBe('');
    const worktree = join(directory, 'active'); await git('worktree', 'add', '-b', 'active', worktree);
    const guarded = createLocalGitService({ persistence, agentsRoot: directory, repos: () => ['org/repo'], authorize: () => {}, activeWorktreePaths: () => [worktree] });
    const active = await guarded.snapshot(caller, { version: 1, repo: 'org/repo' }, 'org/repo');
    expect((await guarded.control(caller, { version: 1, requestId: randomUUID(), target: { repo: active.repo, revision: active.revision }, operation: { action: 'delete-worktree', path: worktree, expectedCommit: active.worktrees.find(tree => tree.path === worktree)!.commit } }, 'org/repo')).status).toBe('rejected');
    expect(await git('worktree', 'list')).toContain(worktree);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('keeps durable uncertainty when final receipt persistence fails after an effect', async () => {
  const f = setup(); const command = await f.command();
  f.persistence.sql.exec("CREATE TRIGGER reject_local_git_outcome BEFORE UPDATE ON local_git_control_receipts BEGIN SELECT RAISE(ABORT, 'outcome storage unavailable'); END");
  await expect(f.service.control(caller, command, 'org/a')).rejects.toThrow('outcome storage unavailable'); expect(f.effect).toHaveBeenCalledTimes(1);
  const restarted = createLocalGitService(f.options); expect(restarted.receipt(caller, { repo: 'org/a', requestId: command.requestId }, 'org/a')?.status).toBe('recovery-required');
  expect((await restarted.control(caller, command, 'org/a')).status).toBe('recovery-required'); expect(f.effect).toHaveBeenCalledTimes(1);
});
