import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createClarificationCommandJournal } from './clarification-command-journal';
import { createHostClarificationCommandService } from './clarification-command-service';
import type { ClarificationCommandInputV1, ClarificationCommandReceiptV1, ClarificationCommandV1 } from './clarification-command';

const caller = 'example.questions/panel';
const input: ClarificationCommandInputV1 = { version: 1, repo: 'org/project', runId: 'run', questionId: 'question', expectedAttempt: 1,
  expectedChannelId: '00000000-0000-4000-8000-000000000111', expectedQuestionRevision: 1, answer: 'Yes' };
function receipt(command: ClarificationCommandV1): ClarificationCommandReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status: 'succeeded', result: { questionId: input.questionId, revision: input.expectedQuestionRevision + 1, answer: input.answer, answeredAt: '2026-01-01T00:00:00Z' }, reason: null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createClarificationCommandJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const activity = new AbortController(); let scope = { repo: 'org/project', epoch: 1, active: true, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>(); const service = createHostClarificationCommandService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { indexedDB, journal, lifetime, fetcher, service, change() { activity.abort(); scope = { ...scope, repo: 'org/other', epoch: 2, signal: new AbortController().signal }; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reserves one identity across concurrent tabs and reload, blocking changed answer or revision until acknowledgment', async () => {
  const f = setup(); const other = createClarificationCommandJournal(caller, { indexedDB: f.indexedDB });
  const [first, second] = await Promise.all([f.journal.reserve(input), other.reserve({ ...input, answer: ' Yes ' })]);
  expect(first).toEqual(second);
  await expect(other.reserve({ ...input, answer: 'No' })).rejects.toThrow('original command');
  await expect(other.reserve({ ...input, expectedQuestionRevision: 2 })).rejects.toThrow('original command');
  expect((await other.pending())[0]?.command).toEqual(first);
  await f.journal.record(receipt(first));
  await expect(other.reserve({ ...input, answer: 'No' })).rejects.toThrow('original command');
  await other.acknowledge({ repo: input.repo, requestId: first.requestId });
  expect((await other.reserve({ ...input, answer: 'No' })).requestId).not.toBe(first.requestId);
});
it('retains response loss and retries the exact canonical intent under its original host request', async () => {
  const f = setup(); let command!: ClarificationCommandV1;
  f.fetcher.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); command = body.command;
    expect(body.scopeRepo).toBe(input.repo); expect(new Headers(init?.headers).get('x-helmsman-contribution')).toBe(caller);
    throw new Error('Response lost');
  });
  expect(await f.service.submit({ ...input, answer: ' Yes ' })).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  const original = command; expect((await f.service.pending())[0]).toEqual({ command: original, receipt: null });
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body)).command).toEqual(original); return Response.json(receipt(original)); });
  expect((await f.service.submit(input)).status).toBe('available');
  await f.service.acknowledge({ repo: input.repo, requestId: original.requestId }); expect(await f.service.pending()).toEqual([]);
});
it('rejects unknown acknowledgment and receipt rebinding without losing pending identity', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: input.repo, requestId: command.requestId };
  await expect(f.journal.acknowledge(query)).rejects.toThrow('recorded terminal');
  const wrong = receipt({ ...command, answer: 'No' }); f.fetcher.mockResolvedValue(Response.json(wrong));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect((await f.journal.pending())[0]?.receipt).toBeNull();
  await f.journal.record(receipt(command));
  await expect(f.journal.record({ ...receipt(command), status: 'rejected', result: null, reason: 'run-inactive' })).rejects.toThrow('terminal receipt changed');
  await expect(f.journal.acknowledge({ ...query, repo: 'org/other' })).rejects.toThrow('matching');
});
it('recovers a receipt after response loss while checking retained input, then requires explicit acknowledgment', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockImplementation(async url => {
    expect(String(url)).toContain(`/receipts/${command.requestId}`); expect(new URL(String(url), 'http://localhost').searchParams.get('scopeRepo')).toBe(input.repo);
    return Response.json(receipt(command));
  });
  expect((await f.service.receipt({ repo: input.repo, requestId: command.requestId })).status).toBe('available');
  expect((await f.journal.pending())[0]?.receipt?.status).toBe('succeeded');
});
it('preserves reservations when lifetime or scope cancels a delayed response', async () => {
  const f = setup(); let resolve!: (value: Response) => void;
  f.fetcher.mockReturnValue(new Promise(yes => { resolve = yes; })); const pending = f.service.submit(input);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled()); const command = (await f.journal.pending())[0]!.command;
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.change(); resolve(Response.json(receipt(command))); await cancelled;
  expect((await f.journal.pending())[0]).toEqual({ command, receipt: null });
  f.lifetime.abort(); await expect(f.service.pending()).rejects.toMatchObject({ name: 'AbortError' });
});
it('aborts an in-progress acknowledgment transaction without deleting its receipt', async () => {
  const f = setup(); const command = await f.journal.reserve(input); await f.journal.record(receipt(command)); const abort = new AbortController();
  const remove = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) { const request = remove.call(this, key); abort.abort(); return request; });
  await expect(f.service.acknowledge({ repo: input.repo, requestId: command.requestId }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect((await f.journal.pending())[0]?.receipt).toEqual(receipt(command));
});
it('does not transmit without durable storage or when reservation fails partway', async () => {
  vi.stubGlobal('indexedDB', undefined); const f = setup();
  const service = createHostClarificationCommandService(f.lifetime.signal, { caller, scope: () => ({ repo: input.repo, epoch: 1, active: true, signal: f.lifetime.signal }), fetch: f.fetcher });
  expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' }); expect(f.fetcher).not.toHaveBeenCalled();
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' }); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.journal.pending()).toEqual([]);
});
it('retains unknown identity when receipt persistence fails and rejects conflicting drafts without sending', async () => {
  const f = setup(); const command = await f.journal.reserve(input); f.fetcher.mockResolvedValue(Response.json(receipt(command)));
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' }); expect((await f.journal.pending())[0]?.receipt).toBeNull();
  f.fetcher.mockClear(); expect(await f.service.submit({ ...input, answer: 'No' })).toEqual({ status: 'unavailable', reason: 'conflict' }); expect(f.fetcher).not.toHaveBeenCalled();
});
it('keeps caller ownership separate and rejects foreign scope before reserving', async () => {
  const f = setup(); const first = await f.journal.reserve(input); const other = createClarificationCommandJournal('example.other/panel', { indexedDB: f.indexedDB });
  expect((await other.reserve(input)).requestId).not.toBe(first.requestId);
  expect(await f.service.submit({ ...input, repo: 'org/foreign' })).toEqual({ status: 'unavailable', reason: 'forbidden' });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toHaveLength(1);
});
it('bounds pending reservations without evicting unresolved requests', async () => {
  const f = setup();
  for (let index = 0; index < 256; index++) await f.journal.reserve({ ...input, questionId: `question-${index}` });
  await expect(f.journal.reserve({ ...input, questionId: 'overflow' })).rejects.toThrow('Reconcile pending');
  expect(await f.journal.pending()).toHaveLength(256);
});
