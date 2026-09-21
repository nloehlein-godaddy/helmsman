import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSuggestedContactAdminJournal } from './suggested-contact-admin-journal';
import { createHostSuggestedContactAdminService } from './suggested-contact-admin-service';
import type { SuggestedContactAdminCommandV1, SuggestedContactAdminInputV1, SuggestedContactAdminReceiptV1 } from './suggested-contact-admin';

const caller = 'example.questions/contacts';
const input: SuggestedContactAdminInputV1 = { version: 1, scope: 'global', kind: 'create', name: 'Person', address: 'Slack account', enabled: true };
function receipt(command: SuggestedContactAdminCommandV1): SuggestedContactAdminReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, scope: 'global', requestId, input, status: 'succeeded', result: { id: input.id, revision: input.kind === 'create' ? 1 : input.expectedRevision + 1,
    name: input.name, address: input.address, enabled: input.enabled, createdAt: '2026-01-01T00:00:00Z' }, reason: null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createSuggestedContactAdminJournal(caller, { indexedDB });
  const lifetime = new AbortController(); const fetcher = vi.fn<typeof fetch>();
  const service = createHostSuggestedContactAdminService(lifetime.signal, { caller, scope: () => ({ repo: 'org/project', active: true, epoch: 1, signal: lifetime.signal }), fetch: fetcher, journal });
  return { indexedDB, journal, lifetime, fetcher, service };
}
it('reserves request and contact identities once across two tabs, changed drafts and reload', async () => {
  const f = setup(); const other = createSuggestedContactAdminJournal(caller, { indexedDB: f.indexedDB });
  const [first, second] = await Promise.all([f.journal.reserve(input), other.reserve({ ...input, name: ' Person ' })]);
  expect(first).toEqual(second); expect(first.requestId).not.toBe(first.id);
  await expect(other.reserve({ ...input, address: 'another' })).rejects.toThrow('original command');
  expect((await createSuggestedContactAdminJournal(caller, { indexedDB: f.indexedDB }).pending())[0]?.command).toEqual(first);
});
it('retries a lost create response with both original IDs without inheriting a repository', async () => {
  const f = setup(); let first!: SuggestedContactAdminCommandV1;
  f.fetcher.mockImplementation(async (_url, init) => { first = JSON.parse(String(init?.body)); expect(first).not.toHaveProperty('repo'); expect(first).not.toHaveProperty('scopeRepo'); throw new Error('Lost response'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  f.fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body))).toEqual(first); return Response.json(receipt(first)); });
  expect((await f.service.submit(input)).status).toBe('available');
  await f.service.acknowledge({ scope: 'global', requestId: first.requestId });
  const next = await f.journal.reserve(input); expect(next.id).not.toBe(first.id); expect(next.requestId).not.toBe(first.requestId);
});
it('retains global pending contact work alongside concrete repository scope and checks exact receipt content', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValue(Response.json(receipt({ ...command, enabled: false })));
  expect(await f.service.receipt({ scope: 'global', requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect((await f.service.pending())[0]?.receipt).toBeNull();
  f.fetcher.mockResolvedValue(Response.json(receipt(command)));
  expect((await f.service.receipt({ scope: 'global', requestId: command.requestId })).status).toBe('available');
  expect((await f.service.pending())[0]?.receipt).toEqual(receipt(command));
});
it('keeps each update identity fixed until a stale-revision rejection is acknowledged', async () => {
  const f = setup(); const update: SuggestedContactAdminInputV1 = { ...input, kind: 'update', id: 'legacy-contact', expectedRevision: 2 };
  const command = await f.journal.reserve(update);
  const rejected: SuggestedContactAdminReceiptV1 = { version: 1, scope: 'global', requestId: command.requestId, input: { ...update, id: update.id }, status: 'rejected', result: null, reason: 'revision-changed' };
  f.fetcher.mockResolvedValue(Response.json(rejected));
  expect(await f.service.submit(update)).toEqual({ status: 'available', value: rejected });
  await expect(f.journal.reserve({ ...update, expectedRevision: 3 })).rejects.toThrow('original command');
  await f.service.acknowledge({ scope: 'global', requestId: command.requestId });
  expect((await f.journal.reserve({ ...update, expectedRevision: 3 })).requestId).not.toBe(command.requestId);
});
it('uses explicitly global bounded read routes and validates returned contact identity', async () => {
  const f = setup(); const contact = receipt(await f.journal.reserve(input)).result!;
  f.fetcher.mockImplementation(async url => {
    const parsed = new URL(String(url), 'http://localhost'); expect(parsed.searchParams.get('scope')).toBe('global'); expect(parsed.searchParams.has('repo')).toBe(false);
    return Response.json(parsed.pathname.endsWith(contact.id) ? { ...contact, id: 'wrong' } : { version: 1, scope: 'global', items: [contact], nextCursor: null, observedAt: contact.createdAt });
  });
  expect((await f.service.list({ version: 1, scope: 'global', limit: 10, cursor: null })).status).toBe('available');
  expect(await f.service.load({ version: 1, scope: 'global', id: contact.id })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
