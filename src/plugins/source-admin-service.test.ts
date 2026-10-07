import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSourceAdminJournal } from './source-admin-journal';
import { createHostSourceAdminService } from './source-admin-service';
import { parseSourceAdminInputV1, parseSourceAdminReceiptV1, type SourceAdminCommandV1, type SourceAdminInputV1, type SourceAdminReceiptV1 } from './source-admin';
import { parseSourceSettingFieldsV1 } from './source-settings';

afterEach(() => { vi.restoreAllMocks(); });
const caller = 'example.settings/panel'; const repo = 'org/project';
const input: SourceAdminInputV1 = { version: 1, kind: 'configure', repo,
  target: { sourceId: '00000000-0000-4000-8000-000000000111', sourceRevision: 1, instanceId: 'instance-one', instanceRevision: 1 },
  changes: { label: 'Source', desiredEnabled: true, allowedRepos: [repo], settings: { field: 'value' } } };
function receipt(command: SourceAdminCommandV1): SourceAdminReceiptV1 {
  const { requestId, ...intent } = command;
  if (intent.kind === 'configure') return parseSourceAdminReceiptV1({ version: 1, requestId, input: intent, status: 'succeeded', result: { kind: 'configured', target: { ...intent.target, instanceRevision: intent.target.instanceRevision + 1 } }, message: null });
  if (intent.kind === 'runtime') return parseSourceAdminReceiptV1({ version: 1, requestId, input: intent, status: 'succeeded', result: { kind: 'runtime', runtime: { repo, epoch: intent.epoch, revision: intent.expectedRevision + 1, enabled: intent.enabled } }, message: null });
  throw new Error('Unsupported fixture');
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createSourceAdminJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const activity = new AbortController(); let scope = { repo, epoch: 1, active: true, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>(); const service = createHostSourceAdminService(lifetime.signal, { caller, scope: () => scope, journal, fetch: fetcher });
  return { indexedDB, journal, lifetime, fetcher, service, change() { activity.abort(); scope = { ...scope, repo: 'org/other', epoch: 2, signal: new AbortController().signal }; } };
}
it('reserves the same intent across tabs and reload, keeping pending response loss until acknowledgment', async () => {
  const f = setup(); const second = createSourceAdminJournal(caller, { indexedDB: f.indexedDB });
  const [first, other] = await Promise.all([f.journal.reserve(input), second.reserve(input)]); expect(first).toEqual(other);
  f.fetcher.mockRejectedValueOnce(new Error('Lost response'));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  await expect(f.service.acknowledge({ repo, requestId: first.requestId })).rejects.toThrow('definite');
  f.fetcher.mockResolvedValueOnce(Response.json(receipt(first))); expect(await f.service.submit(input)).toMatchObject({ status: 'available', value: { requestId: first.requestId } });
  expect(await second.pending()).toHaveLength(1); await f.service.acknowledge({ repo, requestId: first.requestId }); expect(await second.pending()).toEqual([]);
});
it('preserves known historical runtime success when the new process reports the old epoch expired', async () => {
  const f = setup(); const command = await f.journal.reserve({ version: 1, kind: 'runtime', repo, epoch: '00000000-0000-4000-8000-000000000111', expectedRevision: 0, enabled: true });
  const saved = receipt(command); await f.journal.record(saved);
  const expired = { ...saved, status: 'expired' as const, result: null, message: 'Previous process outcome is unknown.' };
  expect(await f.journal.record(expired)).toEqual(saved);
  const next = createSourceAdminJournal('example.other/panel', { indexedDB: f.indexedDB });
  const { requestId: _id, ...intent } = command; const unknown = await next.reserve(intent);
  expect(await next.record({ ...expired, requestId: unknown.requestId })).toMatchObject({ status: 'expired' });
  await next.acknowledge({ repo, requestId: unknown.requestId }); expect(await next.pending()).toEqual([]);
});
it('rejects forged receipt identity and non-string status without changing the saved pending entry', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const valid = receipt(command);
  expect(() => parseSourceAdminReceiptV1({ ...valid, status: ['succeeded'] })).toThrow();
  expect(() => parseSourceAdminReceiptV1({ ...valid, status: 'expired', result: null, message: 'Expired' })).toThrow();
  f.fetcher.mockResolvedValue(Response.json({ ...valid, input: { ...input, target: { ...input.target, instanceRevision: 2 } } }));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect((await f.journal.pending())[0]?.receipt).toBeNull();
});
it('cancels late scope responses without deleting the pending command', async () => {
  const f = setup(); let release!: (response: Response) => void; f.fetcher.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = f.service.submit(input); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled()); const command = (await f.journal.pending())[0]!.command;
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.change(); release(Response.json(receipt(command))); await rejected;
  expect((await f.journal.pending())[0]?.receipt).toBeNull();
});
it('cancels journal acknowledgment before its transaction can delete a receipt', async () => {
  const f = setup(); const command = await f.journal.reserve(input); await f.journal.record(receipt(command));
  const controller = new AbortController(); controller.abort();
  await expect(f.journal.acknowledge({ repo, requestId: command.requestId }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await f.journal.pending()).toHaveLength(1);
});
it('forwards scope cancellation into an in-flight acknowledgment transaction', async () => {
  const f = setup(); const command = await f.journal.reserve(input); await f.journal.record(receipt(command));
  const pending = f.service.acknowledge({ repo, requestId: command.requestId }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  f.change(); await rejected; expect(await f.journal.pending()).toHaveLength(1);
});
it('does not fetch outside scope, and validates public field types without invoking accessors', async () => {
  const f = setup(); expect(await f.service.submit({ ...input, repo: 'org/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
  expect(() => parseSourceAdminInputV1({ ...input, requestId: crypto.randomUUID() })).toThrow();
  expect(() => parseSourceSettingFieldsV1({ field: { label: 'Field', schema: { type: ['boolean'], default: true } } })).toThrow();
  const getter = vi.fn(); const values = Object.defineProperty({}, 'field', { enumerable: true, get: getter });
  expect(() => parseSourceAdminInputV1({ ...input, changes: { ...input.changes, settings: values } })).toThrow(); expect(getter).not.toHaveBeenCalled();
});


it('fails closed for stale exact retry after peer acknowledgment without touching a newer reservation', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: command.repo, requestId: command.requestId };
  const peer = createHostSourceAdminService(f.lifetime.signal, { caller, scope: () => ({ repo: repo, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createSourceAdminJournal(caller, { indexedDB: f.indexedDB }) });
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
  await f.journal.record(receipt(command)); const peer = createSourceAdminJournal(caller, { indexedDB: f.indexedDB });
  const retained = f.journal.retained.bind(f.journal); let newer: SourceAdminCommandV1 | undefined;
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
  const foreign = createHostSourceAdminService(f.lifetime.signal, { caller: 'example.other/panel', scope: () => ({ repo: null, active: true, epoch: 1, signal: f.lifetime.signal }),
    fetch: f.fetcher, journal: createSourceAdminJournal('example.other/panel', { indexedDB: f.indexedDB }) });
  expect(await foreign.retry!({ repo: command.repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'not-found' });
  expect(await f.journal.retained({ repo: 'org/other', requestId: command.requestId })).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toEqual([{ command, receipt: null }]);
});
it.each(['caller', 'scope', 'lifetime'] as const)('cancels %s during exact retry lookup without transmission or allocation', async kind => {
  const f = setup(); const command = await f.journal.reserve(input); let release!: (command: SourceAdminCommandV1) => void;
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
    const open = f.indexedDB.open('helmsman.source-admin', 1); open.onerror = () => reject(open.error);
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

it('validates original administrative input after acknowledgment removes the retry journal', async () => {
  const f = setup(); const command = await f.journal.reserve(input); if (command.kind !== 'configure') throw new Error('Expected configure fixture');
  await f.journal.record(receipt(command)); const peer = createSourceAdminJournal(caller, { indexedDB: f.indexedDB }); const query = { repo: command.repo, requestId: command.requestId };
  f.fetcher.mockImplementation(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual(command); await peer.acknowledge(query);
    return Response.json(receipt({ ...command, changes: { ...command.changes, settings: { field: 'changed' } } }));
  });
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(await f.journal.pending()).toEqual([]);
});
it('allows null-scope administration retry only from All and retains the exact null scope', async () => {
  const f = setup(); const command = await f.journal.reserve({ ...input, repo: null }); const query = { repo: null, requestId: command.requestId };
  expect(await f.service.retry!(query)).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
  const all = createHostSourceAdminService(f.lifetime.signal, { caller, scope: () => ({ repo: null, active: true, epoch: 1, signal: f.lifetime.signal }), fetch: f.fetcher, journal: f.journal });
  expect(await all.retry!({ repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'not-found' });
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body))).toEqual(command); return Response.json(receipt(command)); });
  expect(await all.retry!(query)).toEqual({ status: 'available', value: receipt(command) });
});

const validationInput = { repo, target: input.target, mode: 'refresh' as const, providerId: 'example.tasks/provider', artifactHash: 'a'.repeat(64), actor: 'operator', reason: 'upgrade' };
it.each(['jira-credentials-rejected', 'jira-access-denied'] as const)('preserves allowlisted validation diagnostic %s without forwarding remote messages', async diagnostic => {
  const f = setup(); f.fetcher.mockResolvedValue(Response.json({ diagnostic, error: 'private upstream detail' }, { status: 502 }));
  expect(await f.service.validateReplacement(validationInput)).toEqual({ status: 'unavailable', reason: 'service-unavailable', diagnostic });
});
it.each([{ diagnostic: 'private upstream detail' }, { error: 'private upstream detail' }, null])('keeps unknown validation failures generic', async response => {
  const f = setup(); f.fetcher.mockResolvedValue(Response.json(response, { status: 502 }));
  expect(await f.service.validateReplacement(validationInput)).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
});
it('does not attach validation diagnostics to command outcomes', async () => {
  const f = setup(); f.fetcher.mockResolvedValue(Response.json({ diagnostic: 'jira-credentials-rejected' }, { status: 502 }));
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
});
it('discards late validation diagnostics when the scope changes', async () => {
  const f = setup(); let release!: (response: Response) => void; f.fetcher.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = f.service.validateReplacement(validationInput); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  f.change(); release(Response.json({ diagnostic: 'jira-credentials-rejected' }, { status: 502 })); await rejected;
});
