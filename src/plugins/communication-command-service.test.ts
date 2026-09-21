import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CommunicationCommandInputV1, CommunicationCommandReceiptV1, CommunicationCommandV1 } from './communication-command';
import { createCommunicationCommandJournal } from './communication-command-journal';
import { createHostCommunicationCommandService } from './communication-command-service';

const caller = 'example.communication/panel';
const destination = { providerId: 'helmsman.slack/review', artifactHash: 'a'.repeat(64), workspace: 'T123', channel: 'C123', mention: '@reviewers', connectionId: 'connection-1' };
const input: CommunicationCommandInputV1 = { version: 1, repo: 'org/project', number: 42, expectedDestination: destination };

function receipt(command: CommunicationCommandV1): CommunicationCommandReceiptV1 {
  const { requestId, ...retained } = command;
  return { version: 1, requestId, input: retained, status: 'succeeded', reason: null,
    result: { repo: command.repo, number: command.number, destination: command.expectedDestination, permalink: 'https://example.slack.com/archives/C123/p1710000000000000' } };
}

function setup() {
  const indexedDB = new IDBFactory();
  const journal = createCommunicationCommandJournal(caller, { indexedDB });
  const lifetime = new AbortController();
  const scope = { repo: input.repo, epoch: 1, active: true, signal: new AbortController().signal };
  const fetcher = vi.fn<typeof fetch>();
  const service = createHostCommunicationCommandService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { journal, fetcher, service };
}

afterEach(() => vi.restoreAllMocks());

it('retains a communication request when the browser loses its response and retries the exact command', async () => {
  const f = setup();
  let sent!: CommunicationCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    sent = JSON.parse(String(init?.body)).command;
    throw new Error('Response lost');
  });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  expect(await f.journal.pending()).toEqual([{ command: sent, receipt: null }]);

  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe('/api/communication-command/retry');
    expect(JSON.parse(String(init?.body)).command).toEqual(sent);
    return Response.json(receipt(sent));
  });
  expect(await f.service.retry({ repo: sent.repo, requestId: sent.requestId })).toMatchObject({ status: 'available', value: { requestId: sent.requestId } });
});

it('does not send a retry when its journal entry is missing', async () => {
  const f = setup();
  expect(await f.service.retry({ repo: input.repo, requestId: '12345678-1234-4123-8123-123456789abc' })).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each([
  ['number', (command: CommunicationCommandV1) => ({ ...receipt(command), input: { ...receipt(command).input, number: 43 } })],
  ['destination', (command: CommunicationCommandV1) => ({ ...receipt(command), input: { ...receipt(command).input, expectedDestination: { ...command.expectedDestination, channel: 'C999' } } })],
])('rejects a receipt with an altered %s and retains the original request', async (_field, alter) => {
  const f = setup();
  const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json(alter(command)));
  expect(await f.service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});

it('rejects commands outside the active galleon without sending them', async () => {
  const f = setup();
  expect(await f.service.submit({ ...input, repo: 'other/project' })).toEqual({ status: 'unavailable', reason: 'forbidden' });
  expect(f.fetcher).not.toHaveBeenCalled();
});


it('redelivers an unadmitted original only after an explicit retry reports it missing', async () => {
  const f = setup(); const retained = await f.journal.reserve(input);
  f.fetcher.mockResolvedValueOnce(Response.json({ reason: 'not-found' }, { status: 404 }));
  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe('/api/communication-command'); expect(JSON.parse(String(init?.body)).command).toEqual(retained);
    return Response.json(receipt(retained));
  });
  expect(await f.service.retry({ repo: retained.repo, requestId: retained.requestId })).toMatchObject({ status: 'available', value: { requestId: retained.requestId } });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('does not redeliver on a failed explicit retry transport', async () => {
  const f = setup(); const retained = await f.journal.reserve(input);
  f.fetcher.mockRejectedValueOnce(new Error('Connection lost'));
  expect(await f.service.retry({ repo: retained.repo, requestId: retained.requestId })).toMatchObject({ status: 'unavailable' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect((await f.journal.pending())[0]?.command).toEqual(retained);
});
