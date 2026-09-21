import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createRunCommandJournal } from './run-command-journal';
import { createHostRunCommandService } from './run-command-service';
import type { RunCommandInputV1, RunCommandReceiptV1, RunCommandV1 } from './run-command';

const caller = 'example.runs/panel';
const input: RunCommandInputV1 = { version: 1, repo: 'org/project', action: 'stop', target: { runId: 'run-1', expectedAttempt: 1 } };
function receipt(command: RunCommandV1, status: RunCommandReceiptV1['status'] = 'accepted'): RunCommandReceiptV1 {
  return { version: 1, requestId: command.requestId, repo: command.repo, action: command.action, status, runId: 'run-1', attempt: 1, message: null };
}
function setup() {
  const indexedDB = new IDBFactory();
  const journal = createRunCommandJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope = { repo: input.repo as string | null, epoch: 1, active: true, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>();
  const service = createHostRunCommandService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { journal, indexedDB, lifetime, activity, fetcher, service, change: () => { activity.abort(); scope = { ...scope, epoch: 2, repo: 'org/other', signal: new AbortController().signal }; } };
}

describe('durable browser run commands', () => {
  it('reserves one UUID across concurrent mounts and reopened journals', async () => {
    const { journal, indexedDB } = setup();
    const other = createRunCommandJournal(caller, { indexedDB });
    const [first, second] = await Promise.all([journal.reserve(input), other.reserve(input)]);
    expect(second).toEqual(first);
    expect(await createRunCommandJournal(caller, { indexedDB }).reserve(input)).toEqual(first);
    expect(await journal.pending()).toHaveLength(1);
    expect((await createRunCommandJournal('example.other/panel', { indexedDB }).reserve(input)).requestId).not.toBe(first.requestId);
  });

  it('keeps uncertainty and retires only a matching definite receipt', async () => {
    const { journal } = setup(); const command = await journal.reserve(input);
    await journal.record(receipt(command, 'recovery-required'));
    expect((await journal.pending())[0]?.receipt?.status).toBe('recovery-required');
    await expect(journal.record({ ...receipt(command), action: 'launch' })).rejects.toThrow();
    expect(await journal.reserve(input)).toEqual(command);
    await journal.record(receipt(command));
    expect(await journal.reserve(input)).toEqual(command);
    await journal.acknowledge({ repo: command.repo, requestId: command.requestId });
    const next = await journal.reserve(input); expect(next.requestId).not.toBe(command.requestId);
    await journal.record(receipt(command));
    expect((await journal.pending())[0]?.command.requestId).toBe(next.requestId);
  });

  it('does not reserve a canceled intent', async () => {
    const { journal } = setup(); const signal = AbortSignal.abort();
    await expect(journal.reserve(input, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await journal.pending()).toEqual([]);
  });

  it('reuses the request after response loss and retires validated acceptance', async () => {
    const { service, fetcher, journal } = setup();
    fetcher.mockRejectedValueOnce(new TypeError('lost'));
    expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
    const command = (await journal.pending())[0]!.command;
    fetcher.mockResolvedValueOnce(Response.json(receipt(command)));
    expect(await service.submit(input)).toEqual({ status: 'available', value: receipt(command) });
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).requestId)).toEqual([command.requestId, command.requestId]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Helmsman-Contribution': caller });
    expect((await journal.pending())[0]?.receipt?.status).toBe('accepted');
    await service.acknowledge({ repo: command.repo, requestId: command.requestId });
    expect(await journal.pending()).toEqual([]);
  });

  it('keeps the journal for malformed, wrong-scope and failed responses', async () => {
    for (const response of [Response.json({ status: 'accepted' }), Response.json(null), new Response('', { status: 403 }), new Response('', { status: 409 })]) {
      const { service, fetcher, journal } = setup(); fetcher.mockResolvedValueOnce(response);
      expect((await service.submit(input)).status).toBe('unavailable');
      expect(await journal.pending()).toHaveLength(1);
    }
  });

  it('reconciles a reload through the receipt endpoint', async () => {
    const { service, fetcher, journal } = setup(); const command = await journal.reserve(input);
    fetcher.mockResolvedValueOnce(Response.json(receipt(command, 'rejected')));
    expect((await service.receipt({ requestId: command.requestId, repo: command.repo })).status).toBe('available');
    expect((await journal.pending())[0]?.receipt?.status).toBe('rejected');
    await service.acknowledge({ repo: command.repo, requestId: command.requestId });
    expect(await journal.pending()).toEqual([]);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('forbids cross-scope submission before storage or transport', async () => {
    const { service, fetcher, journal } = setup();
    expect(await service.submit({ ...input, repo: 'org/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(fetcher).not.toHaveBeenCalled(); expect(await journal.pending()).toEqual([]);
  });

  it('invalidates a hung request immediately and preserves identity on scope change', async () => {
    const { service, fetcher, journal, change } = setup();
    let resolve!: (response: Response) => void;
    fetcher.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = service.submit(input); const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const command = (await journal.pending())[0]!.command;
    change(); await outcome;
    resolve(Response.json(receipt(command))); await new Promise(done => setTimeout(done, 0));
    expect((await journal.pending())[0]?.command).toEqual(command);
    expect(await service.pending()).toEqual([]);
  });

  it('never dispatches when durable storage fails', async () => {
    const fetcher = vi.fn<typeof fetch>(); const controller = new AbortController();
    const service = createHostRunCommandService(controller.signal, { caller, fetch: fetcher,
      scope: () => ({ repo: input.repo, epoch: 1, active: true, signal: controller.signal }),
      journal: { reserve: async () => { throw new Error('quota'); }, record: async value => value, acknowledge: async () => {}, pending: async () => [] } });
    expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects cancellation during stalled storage without waiting for it', async () => {
    const controller = new AbortController(); const fetcher = vi.fn<typeof fetch>();
    const service = createHostRunCommandService(controller.signal, { caller, fetch: fetcher,
      scope: () => ({ repo: input.repo, epoch: 1, active: true, signal: controller.signal }),
      journal: { reserve: () => new Promise(() => {}), record: async value => value, acknowledge: async () => {}, pending: () => new Promise(() => {}) } });
    const submit = expect(service.submit(input)).rejects.toMatchObject({ name: 'AbortError' });
    const pending = expect(service.pending()).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await Promise.all([submit, pending]); expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains acceptance when cancellation interrupts receipt storage before delivery', async () => {
    const indexedDB = new IDBFactory(); const journal = createRunCommandJournal(caller, { indexedDB });
    const controller = new AbortController(); let commit!: () => void;
    const service = createHostRunCommandService(controller.signal, { caller,
      scope: () => ({ repo: input.repo, epoch: 1, active: true, signal: controller.signal }),
      fetch: async (_url, init) => Response.json(receipt(JSON.parse(String(init?.body)) as RunCommandV1)),
      journal: { ...journal, record: value => new Promise<RunCommandReceiptV1>((resolve, reject) => {
        commit = () => { void journal.record(value).then(resolve, reject); };
      }) } });
    const pending = expect(service.submit(input)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(commit).toBeTypeOf('function'));
    controller.abort(); await pending; commit();
    await vi.waitFor(async () => expect((await journal.pending())[0]?.receipt?.status).toBe('accepted'));
    const saved = (await journal.pending())[0]!;
    expect(await journal.reserve(input)).toEqual(saved.command);
    await expect(journal.acknowledge({ repo: 'org/other', requestId: saved.command.requestId })).rejects.toThrow();
  });

  it('rejects wrong stop targets without retiring their pending intent', async () => {
    const { service, journal, fetcher } = setup(); const command = await journal.reserve(input);
    fetcher.mockResolvedValueOnce(Response.json({ ...receipt(command), runId: 'unrelated', attempt: 2 }));
    expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect((await journal.pending())[0]?.command).toEqual(command);
    await expect(journal.acknowledge({ repo: command.repo, requestId: command.requestId })).rejects.toThrow();
  });

  it('does not regress recovery or definite evidence when responses arrive out of order', async () => {
    const { service, journal, fetcher } = setup(); const command = await journal.reserve(input);
    await journal.record(receipt(command, 'recovery-required'));
    fetcher.mockResolvedValueOnce(Response.json(receipt(command, 'pending')));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'available', value: receipt(command, 'recovery-required') });
    expect((await journal.pending())[0]?.receipt?.status).toBe('recovery-required');
    await journal.record(receipt(command, 'accepted'));
    expect(await journal.record(receipt(command, 'pending'))).toEqual(receipt(command, 'accepted'));
    expect((await journal.pending())[0]?.receipt?.status).toBe('accepted');
  });

  it.each(['pending', 'recovery-required'] as const)('preserves the assigned execution after %s launch evidence', async status => {
    const { service, journal, fetcher, indexedDB } = setup();
    const intent: RunCommandInputV1 = { version: 1, repo: input.repo, action: 'launch', launch: { mode: 'freeform', task: 'Keep this task identity' } };
    const command = await journal.reserve(intent);
    const prior = { ...receipt(command, status), runId: 'assigned-a' };
    await journal.record(prior);
    fetcher.mockResolvedValueOnce(Response.json({ ...prior, runId: null, attempt: null }));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect((await createRunCommandJournal(caller, { indexedDB }).pending())[0]?.receipt).toEqual(prior);
    fetcher.mockResolvedValueOnce(Response.json({ ...prior, status: 'accepted', runId: 'assigned-b' }));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    const reopened = createRunCommandJournal(caller, { indexedDB });
    expect((await reopened.pending())[0]?.receipt).toEqual(prior);
    await expect(reopened.acknowledge({ repo: command.repo, requestId: command.requestId })).rejects.toThrow();
    await journal.record({ ...prior, status: 'accepted' });
    await reopened.acknowledge({ repo: command.repo, requestId: command.requestId });
    expect(await journal.pending()).toEqual([]);
  });

  it('cannot dismiss a recovery-required command using a contradictory rejection', async () => {
    const { service, journal, fetcher } = setup(); const command = await journal.reserve(input);
    const prior = receipt(command, 'recovery-required'); await journal.record(prior);
    fetcher.mockResolvedValueOnce(Response.json({ ...prior, status: 'rejected', runId: null, attempt: null }));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect((await journal.pending())[0]?.receipt).toEqual(prior);
    await expect(journal.acknowledge({ repo: command.repo, requestId: command.requestId })).rejects.toThrow();
    expect(await journal.reserve(input)).toEqual(command);
  });
});
