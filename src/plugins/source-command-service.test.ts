import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSourceCommandJournal } from './source-command-journal';
import { createHostSourceCommandService } from './source-command-service';
import { parseSourceCommandInputV1, parseSourceCommandReceiptV1, type SourceCommandInputV1, type SourceCommandV1, type SourceCommandReceiptV1 } from './source-command';
import { LOCAL_TASK_EDITOR_V1 } from './task-edit';

afterEach(() => { vi.restoreAllMocks(); });
const caller = 'example.todos/panel';
const input: SourceCommandInputV1 = { version: 1, selection: { version: 1, sourceId: '00000000-0000-4000-8000-000000000111', instanceId: 'instance-one', instanceRevision: 1, repo: 'org/project' },
  sourceRevision: 1, editor: LOCAL_TASK_EDITOR_V1, action: 'create', commandId: 'create', target: null, destinationRepo: 'org/project', input: { title: 'Task', repo: 'org/project' } };
function receipt(command: SourceCommandV1, status: SourceCommandReceiptV1['status'] = 'succeeded'): SourceCommandReceiptV1 {
  const { input: _input, ...identity } = command;
  return { ...identity, status, message: null, result: status === 'succeeded' ? { kind: 'changed', ref: { sourceId: command.selection.sourceId, externalId: 'TODO-1' }, repo: command.destinationRepo!, revision: '1' } : null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createSourceCommandJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const activity = new AbortController(); let scope = { repo: 'org/project', epoch: 1, active: true, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>(); const service = createHostSourceCommandService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { indexedDB, journal, lifetime, fetcher, service, change() { activity.abort(); scope = { ...scope, repo: 'org/other', epoch: 2, signal: new AbortController().signal }; } };
}
it('reserves one canonical intent across concurrent tabs, object key order and reload', async () => {
  const f = setup(); const second = createSourceCommandJournal(caller, { indexedDB: f.indexedDB });
  const [a, b] = await Promise.all([f.journal.reserve(input), second.reserve({ ...input, input: { repo: 'org/project', title: 'Task' } })]);
  expect(a).toEqual(b); expect((await second.pending()).map(value => value.command)).toEqual([a]);
  expect(await createSourceCommandJournal(caller, { indexedDB: f.indexedDB }).reserve(input)).toEqual(a);
});
it('retains response loss and reuses original request until result is saved and explicitly acknowledged', async () => {
  const f = setup(); let command: SourceCommandV1 | undefined;
  f.fetcher.mockImplementation(async (_url, init) => { command = JSON.parse(String(init?.body)) as SourceCommandV1; throw new Error('Lost response'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  expect(await f.service.pending()).toHaveLength(1);
  f.fetcher.mockImplementation(async () => Response.json(receipt(command!)));
  const result = await f.service.submit(input); expect(result.status).toBe('available');
  expect(await f.service.pending()).toHaveLength(1);
  await f.service.acknowledge({ repo: input.selection.repo, requestId: command!.requestId });
  expect(await f.service.pending()).toEqual([]); expect((await f.journal.reserve(input)).requestId).not.toBe(command!.requestId);
});
it('rejects uncertain dismissal or unproved rejection and accepts only audited terminal resolution', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const pending = receipt(command, 'recovery-required');
  await f.journal.record(pending);
  await expect(f.journal.acknowledge({ repo: input.selection.repo, requestId: command.requestId })).rejects.toThrow('definite');
  await expect(f.journal.record(receipt(command, 'rejected'))).rejects.toThrow('Uncertain');
  const resolved = { ...receipt(command, 'rejected'), resolution: { version: 1 as const, kind: 'not-applied' as const, id: '00000000-0000-4000-8000-000000000001' } };
  expect(await f.journal.record(resolved)).toEqual(resolved);
  expect(await f.journal.record(pending)).toEqual(resolved);
  await f.journal.acknowledge({ repo: input.selection.repo, requestId: command.requestId }); expect(await f.journal.pending()).toEqual([]);
});
it('rejects receipt target/source/destination rebinding before changing durable pending state', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json({ ...receipt(command), selection: { ...input.selection, instanceRevision: 2 } }));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect((await f.journal.pending())[0]?.receipt).toBeNull();
  expect(() => parseSourceCommandReceiptV1({ ...receipt(command), result: { kind: 'changed', ref: { sourceId: 'other', externalId: 'TODO-1' }, repo: input.selection.repo, revision: '1' } }, command)).toThrow();
});
it('cancels a late scope response while preserving its immutable pending request', async () => {
  const f = setup(); let resolve!: (response: Response) => void; const wait = new Promise<Response>(yes => { resolve = yes; });
  f.fetcher.mockReturnValue(wait); const pending = f.service.submit(input);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled()); const command = (await f.journal.pending())[0]!.command;
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.change(); resolve(Response.json(receipt(command))); await rejected;
  expect((await f.journal.pending())[0]?.receipt).toBeNull();
});
it('supports full Unicode drafts and rejects unbounded or accessor payloads before reserving', () => {
  expect(parseSourceCommandInputV1({ ...input, input: { title: 'Task', description: '界'.repeat(20_000), acceptanceCriteria: '界'.repeat(20_000) } }).input).toBeDefined();
  expect(() => parseSourceCommandInputV1({ ...input, input: { text: '界'.repeat(100_000) } })).toThrow();
  const getter = vi.fn(); const value = Object.defineProperty({}, 'title', { enumerable: true, get: getter });
  expect(() => parseSourceCommandInputV1({ ...input, input: value })).toThrow(); expect(getter).not.toHaveBeenCalled();
});
it('retains separate caller ownership and blocks explicit caller or request ID injection', async () => {
  const f = setup(); const first = await f.journal.reserve(input);
  const second = await createSourceCommandJournal('example.other/panel', { indexedDB: f.indexedDB }).reserve(input);
  expect(first.requestId).not.toBe(second.requestId);
  expect(() => parseSourceCommandInputV1({ ...input, caller: 'example.other/panel' })).toThrow();
  expect(() => parseSourceCommandInputV1({ ...input, requestId: first.requestId })).toThrow();
});


it('fails closed for stale exact retry after peer acknowledgment without touching a newer reservation', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: command.selection.repo, requestId: command.requestId };
  const peer = createHostSourceCommandService(f.lifetime.signal, { caller, scope: () => ({ repo: input.selection.repo, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createSourceCommandJournal(caller, { indexedDB: f.indexedDB }) });
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
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: command.selection.repo, requestId: command.requestId };
  await f.journal.record(receipt(command)); const peer = createSourceCommandJournal(caller, { indexedDB: f.indexedDB });
  const retained = f.journal.retained.bind(f.journal); let newer: SourceCommandV1 | undefined;
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
  const foreign = createHostSourceCommandService(f.lifetime.signal, { caller: 'example.other/panel', scope: () => ({ repo: null, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createSourceCommandJournal('example.other/panel', { indexedDB: f.indexedDB }) });
  expect(await foreign.retry!({ repo: command.selection.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(await f.journal.retained({ repo: 'org/other', requestId: command.requestId })).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it.each(['caller', 'scope', 'lifetime'] as const)('cancels %s during exact retry lookup without transmission or allocation', async kind => {
  const f = setup(); const command = await f.journal.reserve(input); let release!: (command: SourceCommandV1) => void;
  vi.spyOn(f.journal, 'retained').mockReturnValueOnce(new Promise(resolve => { release = resolve; })); const reserve = vi.spyOn(f.journal, 'reserve');
  const controller = new AbortController(); const pending = f.service.retry!({ repo: command.selection.repo, requestId: command.requestId }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  if (kind === 'caller') controller.abort(); else if (kind === 'scope') f.change(); else f.lifetime.abort();
  await rejected; release(command);
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('preserves retry identity after unavailable storage and rejects malformed query values', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  vi.spyOn(f.journal, 'retained').mockRejectedValueOnce(new Error('Storage unavailable'));
  expect(await f.service.retry!({ repo: command.selection.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
  await expect(f.service.retry!(null as never)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it('rejects corrupt retained receipt data without dispatching or replacing the saved request', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  await new Promise<void>((resolve, reject) => {
    const open = f.indexedDB.open('helmsman.source-commands', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('pending', 'readwrite'); const table = tx.objectStore('pending');
      const read = table.index('request').get([caller, command.requestId]);
      read.onsuccess = () => { table.put({ ...read.result, receipt: {} }); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
  const reserve = vi.spyOn(f.journal, 'reserve');
  expect(await f.service.retry!({ repo: command.selection.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); await expect(f.journal.pending()).rejects.toThrow();
});

it('validates original provider selection after acknowledgment removes the retry journal', async () => {
  const f = setup(); const command = await f.journal.reserve(input); await f.journal.record(receipt(command));
  const peer = createSourceCommandJournal(caller, { indexedDB: f.indexedDB }); const query = { repo: command.selection.repo, requestId: command.requestId };
  f.fetcher.mockImplementation(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual(command); await peer.acknowledge(query);
    return Response.json(receipt({ ...command, selection: { ...command.selection, instanceRevision: command.selection.instanceRevision + 1 } }));
  });
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(await f.journal.pending()).toEqual([]);
});
