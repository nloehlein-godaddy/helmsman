import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSourceCommandJournal } from './source-command-journal';
import { createHostSourceCommandService } from './source-command-service';
import { parseSourceCommandInputV1, parseSourceCommandReceiptV1, type SourceCommandInputV1, type SourceCommandV1, type SourceCommandReceiptV1 } from './source-command';
import { LOCAL_TASK_EDITOR_V1 } from './task-edit';

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
