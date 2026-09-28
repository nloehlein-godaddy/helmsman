import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createLocalGitCommandJournal } from './local-git-command-journal';
import { createHostLocalGitService } from './local-git-service';
import { parseLocalGitControlInputV1, parseLocalGitPreviewV1, type LocalGitControlCommandV1, type LocalGitControlInputV1, type LocalGitControlReceiptV1 } from './local-git';

const caller = 'example.local-git/panel';
const input: LocalGitControlInputV1 = { version: 1, target: { repo: 'org/a', revision: 'a'.repeat(64) }, operation: { action: 'delete-branch', branch: 'topic', expectedCommit: 'b'.repeat(40) } };
function receipt(command: LocalGitControlCommandV1, status: 'succeeded' | 'pending' | 'recovery-required' = 'succeeded'): LocalGitControlReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status, reason: status === 'recovery-required' ? 'Inspect original local Git state' : null,
    result: status === 'succeeded' ? { version: 1, repo: command.target.repo, revision: 'c'.repeat(64), path: '/fixture/a', branches: [], worktrees: [], error: null } : null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createLocalGitCommandJournal(caller, { indexedDB }); const fetcher = vi.fn<typeof fetch>();
  const scope = { repo: 'org/a' as string | null, active: true, epoch: 1, signal: new AbortController().signal };
  const options = { caller, journal, scope: () => scope, fetch: fetcher }; return { indexedDB, journal, fetcher, scope, options, service: createHostLocalGitService(new AbortController().signal, options) };
}
it('reserves the original destructive operation before transport and only reads after response loss/reload', async () => {
  const f = setup(); let command!: LocalGitControlCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => { command = JSON.parse(String(init?.body)).command; expect((await f.journal.pending())[0]?.command).toEqual(command); throw new Error('response lost'); });
  expect(await f.service.control(input)).toMatchObject({ status: 'unavailable', reason: 'connection-failed' });
  const reloaded = createHostLocalGitService(new AbortController().signal, { ...f.options, journal: createLocalGitCommandJournal(caller, { indexedDB: f.indexedDB }) });
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(String(url)).toContain('/api/local-git/receipts/'); expect(init?.method).toBe('GET'); return Response.json(receipt(command)); });
  expect(await reloaded.control(input)).toMatchObject({ status: 'available', value: { status: 'succeeded' } });
  expect(f.fetcher).toHaveBeenCalledTimes(2); expect((await reloaded.pending())[0]?.receipt).toEqual(receipt(command));
});
it('requires explicit fenced inspection before acknowledging absent evidence and never sends a fresh control', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: 'org/a', requestId: command.requestId };
  f.fetcher.mockResolvedValueOnce(Response.json(null)); expect(await f.service.receipt(query)).toMatchObject({ status: 'available', value: null });
  await expect(f.service.acknowledge(query)).rejects.toThrow();
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(url).toBe('/api/local-git/inspect'); expect(JSON.parse(String(init?.body))).toEqual({ command, scopeRepo: 'org/a' }); return Response.json(receipt(command, 'recovery-required')); });
  expect(await f.service.inspect(query)).toMatchObject({ status: 'available', value: { status: 'recovery-required' } });
  expect((await f.journal.pending())[0]?.receipt?.status).toBe('recovery-required'); await f.service.acknowledge(query); expect(await f.service.pending()).toEqual([]);
  expect(await f.service.inspect(query)).toMatchObject({ status: 'unavailable', reason: 'not-found' }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('rejects altered receipts, changed outstanding operations, pending acknowledgment and foreign scope', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: 'org/a', requestId: command.requestId };
  expect(await f.service.control({ ...input, operation: { action: 'refresh-remotes' } })).toMatchObject({ status: 'unavailable', reason: 'conflict' });
  f.fetcher.mockResolvedValueOnce(Response.json({ ...receipt(command), input: { ...input, target: { ...input.target, revision: 'b'.repeat(64) } } }));
  expect(await f.service.receipt(query)).toMatchObject({ status: 'unavailable' }); expect((await f.journal.pending())[0]?.receipt).toBeNull();
  f.fetcher.mockResolvedValueOnce(Response.json(receipt(command, 'pending'))); await f.service.inspect(query); await expect(f.service.acknowledge(query)).rejects.toThrow();
  f.scope.repo = 'org/b'; f.scope.epoch++; expect(await f.service.inspect(query)).toMatchObject({ status: 'unavailable', reason: 'forbidden' }); expect(await f.service.pending()).toEqual([]);
});
it('does not dispatch after scope changes while the journal is saving', async () => {
  const f = setup(); const reserve = f.journal.reserve.bind(f.journal);
  f.journal.reserve = async (input, signal) => { const command = await reserve(input, signal); f.scope.repo = 'org/b'; f.scope.epoch++; return command; };
  await expect(f.service.control(input)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toHaveLength(1);
});
it('pins cleanup previews and rejects malformed branch references and duplicate bulk targets', () => {
  for (const branch of ['-option', 'topic\nextra', 'topic..other', 'topic@{0}']) expect(() => parseLocalGitControlInputV1({ ...input, operation: { action: 'delete-branch', branch, expectedCommit: 'a'.repeat(40) } })).toThrow();
  expect(() => parseLocalGitControlInputV1({ ...input, operation: { action: 'delete-untracked-branches', expectedHead: 'a'.repeat(40), branches: [{ branch: 'same', expectedCommit: 'b'.repeat(40) }, { branch: 'same', expectedCommit: 'b'.repeat(40) }] } })).toThrow();
  expect(() => parseLocalGitPreviewV1({ version: 1, target: { ...input.target, revision: 'c'.repeat(64) }, cleanup: { expectedHead: 'a'.repeat(40), force: false, candidates: [], skipped: [] } }, input.target)).toThrow();
});

it('validates exact branch-release confirmation and retains its journal after a lost response', async () => {
  const operation = { action: 'release-worktree' as const, path: '/fixture/topic', expectedCommit: 'b'.repeat(40), expectedBranch: 'topic' };
  const release = { ...input, operation };
  expect(parseLocalGitControlInputV1(release)).toEqual(release);
  for (const invalid of [{ ...operation, expectedBranch: undefined }, { ...operation, expectedBranch: '-bad' }, { ...operation, path: 'relative' }, { ...operation, force: true }]) {
    expect(() => parseLocalGitControlInputV1({ ...release, operation: invalid })).toThrow();
  }
  const f = setup(); f.fetcher.mockRejectedValueOnce(new Error('Response lost'));
  expect(await f.service.control(release)).toMatchObject({ status: 'unavailable' });
  const pending = await f.journal.pending();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.command.operation).toEqual(operation);
  expect(pending[0]?.receipt).toBeNull();
});
