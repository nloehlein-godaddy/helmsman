import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createTaskActionJournal, TaskActionJournalConflictError, TaskActionJournalValidationError } from './task-action-journal';
import { createHostTaskActionService } from './task-action-service';
import type { SourceRemoteActionInputV1, SourceRemoteActionCommandV1, SourceRemoteActionReceiptV1 } from './task-actions';

const caller = 'example.triage/panel';
const sourceId = '11111111-1111-4111-8111-111111111111';
const selection = { version: 1 as const, repo: 'org/project', sourceId, instanceId: 'jira-one', instanceRevision: 2 };
const input: SourceRemoteActionInputV1 = { version: 1, action: 'assign-self', selection, sourceRevision: 3, target: { ref: { sourceId, externalId: '10001' }, repo: selection.repo, expectedRevision: 'before' } };
function receipt(command: SourceRemoteActionCommandV1, status: SourceRemoteActionReceiptV1['status'] = 'succeeded'): SourceRemoteActionReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status, reason: null, result: status === 'succeeded' ? { ref: input.target.ref, repo: input.selection.repo, revision: 'after', accountId: 'authenticated-actor' } : null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createTaskActionJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const scope = { repo: selection.repo as string | null, epoch: 1, active: true, signal: new AbortController().signal };
  const fetcher = vi.fn<typeof fetch>();
  const service = createHostTaskActionService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { indexedDB, journal, service, fetcher, scope, lifetime };
}

it('keeps one request across concurrent callers in the same contribution and remounts', async () => {
  const f = setup(); const remount = createTaskActionJournal(caller, { indexedDB: f.indexedDB });
  const [first, second] = await Promise.all([f.journal.reserve(input), remount.reserve(input)]);
  expect(second).toEqual(first); expect(await remount.pending()).toEqual([{ command: first, receipt: null }]);
  expect((await createTaskActionJournal('copy.triage/panel', { indexedDB: f.indexedDB }).reserve(input)).requestId).not.toBe(first.requestId);
});
it.each([
  { ...input, sourceRevision: 4 },
  { ...input, selection: { ...selection, instanceId: 'replacement' } },
  { ...input, target: { ...input.target, expectedRevision: 'changed' } },
])('blocks changed intent for the same canonical task until a terminal receipt is dismissed', async changed => {
  const f = setup(); const command = await f.journal.reserve(input);
  await expect(f.journal.reserve(changed)).rejects.toBeInstanceOf(TaskActionJournalConflictError);
  await expect(f.journal.acknowledge({ repo: selection.repo, requestId: command.requestId })).rejects.toThrow('definite');
  await f.journal.record(receipt(command)); await f.journal.acknowledge({ repo: selection.repo, requestId: command.requestId });
  expect((await f.journal.reserve(changed)).requestId).not.toBe(command.requestId);
});
it('keeps uncertain outcomes protected from stale pending and unproven rejected responses', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const uncertain = receipt(command, 'recovery-required');
  await f.journal.record(uncertain); expect(await f.journal.record(receipt(command, 'pending'))).toEqual(uncertain);
  await expect(f.journal.record(receipt(command, 'rejected'))).rejects.toBeInstanceOf(TaskActionJournalValidationError);
  await expect(f.journal.acknowledge({ repo: selection.repo, requestId: command.requestId })).rejects.toThrow();
  const resolved = { ...receipt(command, 'rejected'), resolution: { version: 1 as const, id: sourceId, kind: 'not-applied' as const } };
  await f.journal.record(resolved); await f.journal.acknowledge({ repo: selection.repo, requestId: command.requestId }); expect(await f.journal.pending()).toEqual([]);
});
it('never replaces a definite assignment result with a contradictory terminal receipt', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const success = receipt(command);
  await f.journal.record(success); await expect(f.journal.record(receipt(command, 'rejected'))).rejects.toThrow('Definite');
  expect(await f.journal.record(receipt(command, 'pending'))).toEqual(success);
});
it('retains a lost response and retries the exact saved command without generating another identity', async () => {
  const f = setup(); let sent!: SourceRemoteActionCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => { sent = JSON.parse(String(init?.body)).command; throw new Error('Lost response'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  expect(await f.journal.pending()).toEqual([{ command: sent, receipt: null }]);
  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe('/api/task-action/retry'); expect(JSON.parse(String(init?.body))).toEqual({ query: { repo: selection.repo, requestId: sent.requestId }, scopeRepo: selection.repo });
    return Response.json(receipt(sent));
  });
  expect(await f.service.retry({ repo: selection.repo, requestId: sent.requestId })).toEqual({ status: 'available', value: receipt(sent) });
});
it('resends the original command only after an explicit retry proves no server receipt exists', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValueOnce(Response.json({ reason: 'not-found' }, { status: 404 }));
  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe('/api/task-action'); expect(JSON.parse(String(init?.body)).command).toEqual(command); return Response.json(receipt(command));
  });
  expect(await f.service.retry({ repo: selection.repo, requestId: command.requestId })).toMatchObject({ status: 'available' }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('does not retry missing local requests or silently redeliver after a network failure', async () => {
  const f = setup(); expect(await f.service.retry({ repo: selection.repo, requestId: sourceId })).toEqual({ status: 'unavailable', reason: 'not-found' }); expect(f.fetcher).not.toHaveBeenCalled();
  const command = await f.journal.reserve(input); f.fetcher.mockRejectedValue(new Error('Offline'));
  expect(await f.service.retry({ repo: selection.repo, requestId: command.requestId })).toMatchObject({ status: 'unavailable' }); expect(f.fetcher).toHaveBeenCalledOnce();
});
it('validates discovered source authority and preserves the scoped caller on transport', async () => {
  const f = setup(); f.fetcher.mockImplementation(async (_url, init) => {
    expect(init?.headers).toMatchObject({ 'X-Helmsman-Contribution': caller }); expect(JSON.parse(String(init?.body))).toEqual({ selection, scopeRepo: selection.repo });
    return Response.json({ version: 1, selection: { ...selection, instanceRevision: 99 }, sourceRevision: 3, actions: ['assign-self'] });
  });
  expect(await f.service.discover(selection)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('refuses forged receipt input and retains the original command', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json({ ...receipt(command), input: { ...input, sourceRevision: 9 } }));
  expect(await f.service.receipt({ repo: selection.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('fails closed outside scope and when durable storage cannot reserve the request', async () => {
  const f = setup(); f.scope.repo = 'other/project';
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
  f.scope.repo = selection.repo; vi.spyOn(f.journal, 'reserve').mockRejectedValue(new Error('Storage blocked'));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' }); expect(f.fetcher).not.toHaveBeenCalled();
});
it('discards a late response after scope changes without overwriting its saved request', async () => {
  const f = setup(); let respond!: (response: Response) => void; let command!: SourceRemoteActionCommandV1;
  f.fetcher.mockImplementation((_url, init) => { command = JSON.parse(String(init?.body)).command; return new Promise(resolve => { respond = resolve; }); });
  const pending = f.service.submit(input); const rejected = expect(pending).rejects.toThrow('scope');
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); f.scope.epoch++; respond(Response.json(receipt(command))); await rejected;
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
