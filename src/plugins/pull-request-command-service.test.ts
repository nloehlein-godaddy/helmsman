import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createPullRequestCommandJournal } from './pull-request-command-journal';
import { createHostPullRequestCommandService } from './pull-request-command-service';
import type { PullRequestCommandInputV1, PullRequestCommandReceiptV1, PullRequestCommandV1 } from './pull-request-command';

const caller = 'example.pr/panel';
const input: PullRequestCommandInputV1 = { version: 1, repo: 'org/project', number: 42, expectedHeadSha: 'a'.repeat(40), event: 'COMMENT', body: ' Keep exact review text. ' };
function receipt(command: PullRequestCommandV1, status: PullRequestCommandReceiptV1['status'] = 'succeeded'): PullRequestCommandReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status, reason: status === 'rejected' || status === 'recovery-required' ? 'Original operation needs recovery' : null,
    result: status === 'succeeded' ? { repo: input.repo, number: input.number, headSha: input.expectedHeadSha, actor: 'reviewer', reviewId: 7 } : null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createPullRequestCommandJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const activity = new AbortController(); let scope = { repo: input.repo, epoch: 1, active: true, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>(); const service = createHostPullRequestCommandService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { indexedDB, journal, lifetime, fetcher, service, change() { activity.abort(); scope = { ...scope, repo: 'org/other', epoch: 2, signal: new AbortController().signal }; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reserves one request across peers and blocks changed body, event or head while unresolved', async () => {
  const f = setup(); const peer = createPullRequestCommandJournal(caller, { indexedDB: f.indexedDB });
  const [first, second] = await Promise.all([f.journal.reserve(input), peer.reserve(input)]); expect(second).toEqual(first);
  for (const change of [{ body: 'Changed' }, { expectedHeadSha: 'b'.repeat(40) }, { event: 'APPROVE' as const }]) await expect(peer.reserve({ ...input, ...change })).rejects.toThrow('original command');
  expect((await peer.pending())[0]?.command.body).toBe(input.body);
  const foreign = createPullRequestCommandJournal('example.other/panel', { indexedDB: f.indexedDB });
  expect((await foreign.reserve(input)).requestId).not.toBe(first.requestId);
});
it('records remote uncertainty across reload and allows acknowledgment only after terminal success', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: input.repo, requestId: command.requestId };
  await f.journal.record(receipt(command, 'pending')); await expect(f.journal.acknowledge(query)).rejects.toThrow('terminal');
  await f.journal.record(receipt(command, 'recovery-required'));
  const reloaded = createPullRequestCommandJournal(caller, { indexedDB: f.indexedDB });
  expect((await reloaded.pending())[0]?.receipt?.status).toBe('recovery-required'); await expect(reloaded.acknowledge(query)).rejects.toThrow('terminal');
  const terminal = receipt(command); await reloaded.record(terminal);
  expect(await reloaded.record(receipt(command, 'pending'))).toEqual(terminal);
  await expect(reloaded.record({ ...terminal, result: { ...terminal.result!, reviewId: 8 } })).rejects.toThrow('terminal receipt changed');
  await reloaded.acknowledge(query); expect(await f.journal.pending()).toEqual([]);
  expect((await f.journal.reserve({ ...input, body: 'An intentional new review' })).requestId).not.toBe(command.requestId);
});
it('retries response loss under the exact retained identity and never resurrects an acknowledged request', async () => {
  const f = setup(); let command!: PullRequestCommandV1;
  f.fetcher.mockImplementation(async (url, init) => {
    expect(url).toBe('/api/pull-request-command'); const payload = JSON.parse(String(init?.body)); command = payload.command;
    expect(payload.scopeRepo).toBe(input.repo); expect(new Headers(init?.headers).get('x-helmsman-contribution')).toBe(caller); throw new Error('Response lost');
  });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' }); const original = command;
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body)).command).toEqual(original); return Response.json(receipt(original)); });
  const query = { repo: input.repo, requestId: original.requestId }; expect((await f.service.retry(query)).status).toBe('available'); await f.service.acknowledge(query);
  const newer = await f.journal.reserve({ ...input, body: 'New review' }); f.fetcher.mockClear();
  expect(await f.service.retry(query)).toEqual({ status: 'unavailable', reason: 'not-found' }); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.journal.pending()).toEqual([{ command: newer, receipt: null }]);
});
it('never sends a review before durable reservation or across foreign scope', async () => {
  const f = setup();
  expect(await f.service.submit({ ...input, repo: 'org/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' });
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' }); expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([]);
});
it('rejects receipt rebinding without clearing the original request or draft', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json(receipt({ ...command, body: 'Substituted body' })));
  expect(await f.service.receipt({ repo: input.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('retains original requests when scope cancels a delayed publication response or receipt storage fails', async () => {
  const f = setup(); let finish!: (response: Response) => void;
  f.fetcher.mockReturnValue(new Promise(resolve => { finish = resolve; })); const pending = f.service.submit(input);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled()); const command = (await f.journal.pending())[0]!.command;
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.change(); finish(Response.json(receipt(command))); await cancelled;
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
  const next = setup(); const retained = await next.journal.reserve(input); next.fetcher.mockResolvedValue(Response.json(receipt(retained)));
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(await next.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
  expect(await next.journal.pending()).toEqual([{ command: retained, receipt: null }]);
});
it('allows an in-flight exact retry to finish after acknowledgment without recreating its journal', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: input.repo, requestId: command.requestId };
  await f.journal.record(receipt(command)); const retained = f.journal.retained.bind(f.journal);
  vi.spyOn(f.journal, 'retained').mockImplementation(async (...args) => { const value = await retained(...args); await f.journal.acknowledge(query); return value; });
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body)).command).toEqual(command); return Response.json(receipt(command)); });
  expect((await f.service.retry(query)).status).toBe('available'); expect(await f.journal.pending()).toEqual([]);
});
it('preserves the full permitted review body through durable equality checks', async () => {
  const f = setup(); const large = { ...input, body: '\ud800'.repeat(64_000) };
  const command = await f.journal.reserve(large); expect(await f.journal.reserve(large)).toEqual(command);
  await f.journal.record(receipt(command)); expect((await f.journal.pending())[0]?.receipt?.input.body).toBe(large.body);
});
