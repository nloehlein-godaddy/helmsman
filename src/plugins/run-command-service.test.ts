import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createRunCommandJournal } from './run-command-journal';
import { createHostRunCommandService } from './run-command-service';
import type { RunCommandInputV1, RunCommandReceiptV1, RunCommandV1 } from './run-command';

afterEach(() => { vi.restoreAllMocks(); });
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
      journal: { retained: async () => null, reserve: async () => { throw new Error('quota'); }, record: async value => value, acknowledge: async () => {}, pending: async () => [] } });
    expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects cancellation during stalled storage without waiting for it', async () => {
    const controller = new AbortController(); const fetcher = vi.fn<typeof fetch>();
    const service = createHostRunCommandService(controller.signal, { caller, fetch: fetcher,
      scope: () => ({ repo: input.repo, epoch: 1, active: true, signal: controller.signal }),
      journal: { retained: async () => null, reserve: () => new Promise(() => {}), record: async value => value, acknowledge: async () => {}, pending: () => new Promise(() => {}) } });
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

  it('consumes an explicit audited not-admitted resolution after reload without retiring a newer delivery', async () => {
    const { journal, fetcher, service, indexedDB } = setup(); const command = await journal.reserve(input);
    await journal.record(receipt(command, 'recovery-required'));
    const resolved: RunCommandReceiptV1 = { ...receipt(command, 'rejected'), runId: null, attempt: null,
      resolution: { version: 1, id: '00000000-0000-4000-8000-000000000005', kind: 'not-admitted', runId: 'run-1', attempt: 1 } };
    fetcher.mockResolvedValueOnce(Response.json(resolved));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'available', value: resolved });
    const reopened = createRunCommandJournal(caller, { indexedDB });
    expect((await reopened.pending())[0]?.receipt).toEqual(resolved);
    expect(await journal.record(receipt(command, 'recovery-required'))).toEqual(resolved);
    await reopened.acknowledge({ repo: command.repo, requestId: command.requestId });
    const next = await journal.reserve(input); expect(next.requestId).not.toBe(command.requestId);
    await journal.record(resolved);
    expect(await journal.pending()).toEqual([{ command: next, receipt: null }]);
  });

  it('rejects a not-admitted resolution for a different assigned launch identity', async () => {
    const { journal, fetcher, service } = setup();
    const intent: RunCommandInputV1 = { version: 1, repo: input.repo, action: 'launch', launch: { mode: 'freeform', task: 'Retain uncertainty' } };
    const command = await journal.reserve(intent); await journal.record(receipt(command, 'recovery-required'));
    fetcher.mockResolvedValueOnce(Response.json({ ...receipt(command, 'rejected'), runId: null, attempt: null,
      resolution: { version: 1, id: '00000000-0000-4000-8000-000000000005', kind: 'not-admitted', runId: 'other-run', attempt: 1 } }));
    expect(await service.receipt({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect((await journal.pending())[0]?.receipt?.status).toBe('recovery-required');
    await expect(journal.acknowledge({ repo: command.repo, requestId: command.requestId })).rejects.toThrow();
  });
});


it('fails closed for stale exact retry after peer acknowledgment without touching a newer reservation', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: command.repo, requestId: command.requestId };
  const peer = createHostRunCommandService(f.lifetime.signal, { caller, scope: () => ({ repo: input.repo, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createRunCommandJournal(caller, { indexedDB: f.indexedDB }) });
  expect((await f.service.pending())[0]?.command).toEqual(command);
  await f.journal.record(receipt(command)); await peer.acknowledge(query);
  const reserve = vi.spyOn(f.journal, 'reserve');
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  const newer = await f.journal.reserve(input); reserve.mockClear(); expect(newer.requestId).not.toBe(command.requestId);
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.journal.pending()).toEqual([{ command: newer, receipt: null }]);
});
it('keeps exact command authority when acknowledgment races retained lookup and a newer intent is reserved', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: command.repo, requestId: command.requestId };
  await f.journal.record(receipt(command)); const peer = createRunCommandJournal(caller, { indexedDB: f.indexedDB });
  const retained = f.journal.retained.bind(f.journal); let newer: RunCommandV1 | undefined;
  vi.spyOn(f.journal, 'retained').mockImplementationOnce(async (query, signal) => { const saved = await retained(query, signal); await peer.acknowledge(query); newer = await peer.reserve(input); return saved; });
  const reserve = vi.spyOn(f.journal, 'reserve');
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body))).toEqual(command); return Response.json(receipt(command)); });
  expect(await f.service.retry!(query)).toEqual({ status: 'available', value: receipt(command) });
  expect(reserve).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command: newer, receipt: null }]);
});
it('rejects foreign caller and scope before retrying a retained command', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const retained = vi.spyOn(f.journal, 'retained');
  expect(await f.service.retry!({ repo: 'org/foreign', requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'forbidden' });
  expect(retained).not.toHaveBeenCalled();
  const foreign = createHostRunCommandService(f.lifetime.signal, { caller: 'example.other/panel', scope: () => ({ repo: null, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createRunCommandJournal('example.other/panel', { indexedDB: f.indexedDB }) });
  expect(await foreign.retry!({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(await f.journal.retained({ repo: 'org/other', requestId: command.requestId })).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it.each(['caller', 'scope', 'lifetime'] as const)('cancels %s during exact retry lookup without transmission or allocation', async kind => {
  const f = setup(); const command = await f.journal.reserve(input); let release!: (command: RunCommandV1) => void;
  vi.spyOn(f.journal, 'retained').mockReturnValueOnce(new Promise(resolve => { release = resolve; })); const reserve = vi.spyOn(f.journal, 'reserve');
  const controller = new AbortController(); const pending = f.service.retry!({ repo: command.repo, requestId: command.requestId }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  if (kind === 'caller') controller.abort(); else if (kind === 'scope') f.change(); else f.lifetime.abort();
  await rejected; release(command);
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('preserves retry identity after unavailable storage and rejects malformed query values', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  vi.spyOn(f.journal, 'retained').mockRejectedValueOnce(new Error('Storage unavailable'));
  expect(await f.service.retry!({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
  await expect(f.service.retry!(null as never)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('rejects corrupt retained receipt data without dispatching or replacing the saved request', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  await new Promise<void>((resolve, reject) => {
    const open = f.indexedDB.open('helmsman.run-commands', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('pending', 'readwrite'); const table = tx.objectStore('pending');
      const read = table.index('request').get([caller, command.requestId]);
      read.onsuccess = () => { table.put({ ...read.result, receipt: {} }); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
  const reserve = vi.spyOn(f.journal, 'reserve');
  expect(await f.service.retry!({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); await expect(f.journal.pending()).rejects.toThrow();
});

it('redelivers a freeform launch with its original identity and tuning, then refuses stale retry after acknowledgment', async () => {
  const f = setup(); const intent: RunCommandInputV1 = { version: 1, repo: input.repo, action: 'launch', launch: { mode: 'freeform', task: 'One explicit launch', model: 'model-one', effort: 'high' } };
  const applied = new Map<string, RunCommandReceiptV1>(); let lose = true;
  f.fetcher.mockImplementation(async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as RunCommandV1;
    expect(command).toMatchObject(intent);
    if (!applied.has(command.requestId)) applied.set(command.requestId, receipt(command));
    if (lose) { lose = false; throw new Error('Response lost after launch'); }
    return Response.json(applied.get(command.requestId));
  });
  expect(await f.service.submit(intent)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  const original = (await f.journal.pending())[0]!.command; const query = { repo: original.repo, requestId: original.requestId };
  const reserve = vi.spyOn(f.journal, 'reserve');
  expect(await f.service.retry!(query)).toEqual({ status: 'available', value: receipt(original) });
  expect(reserve).not.toHaveBeenCalled(); expect(applied.size).toBe(1);
  expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([original, original]);
  await f.service.acknowledge(query);
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(f.fetcher).toHaveBeenCalledTimes(2); expect(applied.size).toBe(1); expect(await f.journal.pending()).toEqual([]);
});
it('validates the original stop target even if acknowledgment removes its journal before retry response', async () => {
  const f = setup(); const command = await f.journal.reserve(input); await f.journal.record(receipt(command));
  const peer = createRunCommandJournal(caller, { indexedDB: f.indexedDB }); const query = { repo: command.repo, requestId: command.requestId };
  f.fetcher.mockImplementation(async () => { await peer.acknowledge(query); return Response.json({ ...receipt(command), runId: 'other-run', attempt: 2 }); });
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(await f.journal.pending()).toEqual([]);
});
