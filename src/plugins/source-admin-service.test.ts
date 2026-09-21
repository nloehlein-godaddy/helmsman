import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSourceAdminJournal } from './source-admin-journal';
import { createHostSourceAdminService } from './source-admin-service';
import { parseSourceAdminInputV1, parseSourceAdminReceiptV1, type SourceAdminCommandV1, type SourceAdminInputV1, type SourceAdminReceiptV1 } from './source-admin';
import { parseSourceSettingFieldsV1 } from './source-settings';

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
