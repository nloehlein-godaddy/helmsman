import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { parseFeedbackInputV1, parseFeedbackReceiptV1, type FeedbackCommandInputV1, type FeedbackCommandV1 } from './feedback-command';
import { createFeedbackCommandJournal } from './feedback-command-journal';
import { createHostFeedbackCommandService } from './feedback-command-service';
const input: FeedbackCommandInputV1 = { version: 1, draftId: '12345678-1234-4123-8123-123456789abc', title: 'A bug', body: 'Steps to reproduce', context: { version: '1', repo: 'org/project', page: 'feedback' }, expectedDestination: { id: 'tracker', label: 'Feedback', url: 'https://github.com/org/app/issues', revision: 'a'.repeat(64) } };
const caller = 'example.feedback/page';
function receipt(command: FeedbackCommandV1) { const { requestId, ...input } = command; return { version: 1, requestId, input, status: 'succeeded', reason: null, result: { id: '1', url: 'https://github.com/org/app/issues/1' } }; }
function fixture() {
  const indexedDB = new IDBFactory(); const journal = createFeedbackCommandJournal(caller, { indexedDB }); const fetcher = vi.fn<typeof fetch>();
  const scope = { repo: input.context.repo, epoch: 1, active: true, signal: new AbortController().signal };
  const options = { caller, scope: () => scope, journal, fetch: fetcher };
  return { indexedDB, journal, fetcher, scope, options, service: createHostFeedbackCommandService(new AbortController().signal, options) };
}
it('strictly validates command version, nullable scope, and destination receipts', () => {
  expect(parseFeedbackInputV1(input)).toEqual(input);
  expect(() => parseFeedbackInputV1({ ...input, version: 2 })).toThrow();
  expect(() => parseFeedbackInputV1({ ...input, context: null })).toThrow();
  const command = { ...input, requestId: '22345678-1234-4123-8123-123456789abc' };
  expect(() => parseFeedbackReceiptV1({ ...receipt(command), result: { id: '1', url: 'https://github.com/other/app/issues/1' } }, command)).toThrow();
});
it('survives response loss and reload with the same immutable request identity', async () => {
  const f = fixture(); let command!: FeedbackCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => { command = JSON.parse(String(init?.body)).command; throw new Error('response lost'); });
  expect(await f.service.submit(input)).toMatchObject({ status: 'unavailable' });
  const journal = createFeedbackCommandJournal(caller, { indexedDB: f.indexedDB });
  const restored = createHostFeedbackCommandService(new AbortController().signal, { ...f.options, journal });
  expect(await restored.pending()).toEqual([{ command, receipt: null }]);
  expect(await restored.submit({ ...input, body: 'Changed' })).toEqual({ status: 'unavailable', reason: 'conflict' });
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(url).toBe('/api/feedback-command/retry'); expect(JSON.parse(String(init?.body)).command).toEqual(command); return Response.json(receipt(command)); });
  expect(await restored.retry({ requestId: command.requestId, repo: input.context.repo })).toMatchObject({ status: 'available', value: { status: 'succeeded' } });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('rejects changed receipt content and cross-scope calls without losing the draft', async () => {
  const f = fixture(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json({ ...receipt(command), input: { ...input, body: 'Changed' } }));
  expect(await f.service.receipt({ requestId: command.requestId, repo: input.context.repo })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
  f.scope.repo = 'other/project';
  expect(await f.service.retry({ requestId: command.requestId, repo: input.context.repo })).toEqual({ status: 'unavailable', reason: 'forbidden' });
});
it('keeps global-context feedback separate from an active galleon', async () => {
  const f = fixture(); expect(await f.service.submit({ ...input, context: { ...input.context, repo: null } })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
});
