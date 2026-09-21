import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createCampaignCommandJournal } from './campaigns-command-journal';
import { createHostCampaignService } from './campaigns-service';
import { CAMPAIGN_LIMITS, parseCampaignCommandInputV1, parseCampaignDetailSnapshotV1, type CampaignCommandInputV1, type CampaignCommandV1, type CampaignCommandReceiptV1 } from './campaigns';

const caller = 'example.campaigns/panel';
const input: CampaignCommandInputV1 = { version: 1, repo: 'org/a', action: 'create', name: 'Campaign', workflowRef: 'review@1', concurrency: 2 };
function receipt(command: CampaignCommandV1): CampaignCommandReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status: 'succeeded', reason: null, result: { kind: 'created', campaign: { id: 'campaign-1', repo: 'org/a', name: 'Campaign', workflowRef: 'review@1', concurrency: 2, createdAt: '2026-09-21T00:00:00Z' } } };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createCampaignCommandJournal(caller, { indexedDB });
  const fetcher = vi.fn<typeof fetch>(); const scope = { repo: 'org/a' as string | null, epoch: 1, active: true, signal: new AbortController().signal };
  const options = { caller, scope: () => scope, journal, fetch: fetcher };
  return { indexedDB, journal, scope, options, fetcher, service: createHostCampaignService(new AbortController().signal, options) };
}
it('reserves before transport and reuses exact original command after response loss and reload', async () => {
  const f = setup(); let original!: CampaignCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => { original = JSON.parse(String(init?.body)).command; expect((await f.journal.pending())[0]?.command).toEqual(original); throw new Error('response lost'); });
  expect(await f.service.submit(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  const reloaded = createHostCampaignService(new AbortController().signal, { ...f.options, journal: createCampaignCommandJournal(caller, { indexedDB: f.indexedDB }) });
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(url).toBe('/api/campaign-service/commands'); expect(JSON.parse(String(init?.body))).toEqual({ command: original, scopeRepo: 'org/a' }); return Response.json(receipt(original)); });
  expect(await reloaded.retry({ repo: 'org/a', requestId: original.requestId })).toMatchObject({ status: 'available', value: { requestId: original.requestId } });
  expect((await reloaded.pending())[0]?.receipt).toEqual(receipt(original));
  await reloaded.acknowledge({ repo: 'org/a', requestId: original.requestId }); expect(await reloaded.pending()).toEqual([]);
  expect(await reloaded.retry({ repo: 'org/a', requestId: original.requestId })).toMatchObject({ status: 'unavailable', reason: 'not-found' }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('serializes unresolved intent per galleon and never clears missing evidence', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  expect(await f.service.submit({ ...input, name: 'Changed' })).toMatchObject({ status: 'unavailable', reason: 'conflict' });
  expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher.mockResolvedValueOnce(Response.json(null)); expect(await f.service.receipt({ repo: 'org/a', requestId: command.requestId })).toMatchObject({ status: 'available', value: null });
  await expect(f.service.acknowledge({ repo: 'org/a', requestId: command.requestId })).rejects.toThrow();
  expect((await f.service.pending())[0]?.command).toEqual(command);
});
it('rejects altered command receipts while preserving original journal', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValueOnce(Response.json({ ...receipt(command), input: { ...input, concurrency: 3 } }));
  expect(await f.service.receipt({ repo: 'org/a', requestId: command.requestId })).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
  expect((await f.service.pending())[0]?.receipt).toBeNull();
});
it('enforces active scope for list, detail and retries without dispatch', async () => {
  const f = setup(); const command = await f.journal.reserve(input); f.scope.repo = 'org/b'; f.scope.epoch++;
  expect(await f.service.retry({ repo: 'org/a', requestId: command.requestId })).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(await f.service.detail({ version: 1, repo: 'org/a', campaignId: 'campaign-1' })).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(await f.service.list({ version: 1, repo: null })).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(await f.service.pending()).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
});
it('cancels a delayed journal reservation after scope change before dispatch', async () => {
  const f = setup(); const reserve = f.journal.reserve.bind(f.journal);
  f.journal.reserve = async (input, signal) => { const command = await reserve(input, signal); f.scope.repo = 'org/b'; f.scope.epoch++; return command; };
  await expect(f.service.submit(input)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.journal.pending()).toHaveLength(1);
});
it('bounds import bytes and rejects foreign membership in read DTOs', () => {
  expect(() => parseCampaignCommandInputV1({ version: 1, repo: 'org/a', action: 'preview', target: { campaignId: 'campaign-1', revision: 'a'.repeat(64) }, phaseId: 'phase-1', format: 'jsonl', content: 'é'.repeat(CAMPAIGN_LIMITS.importBytes) })).toThrow();
  const result = receipt({ ...input, requestId: '10000000-0000-4000-8000-000000000001' }).result;
  if (result?.kind !== 'created') throw new Error('Expected created campaign');
  expect(() => parseCampaignDetailSnapshotV1({ version: 1, revision: 'a'.repeat(64), campaign: result.campaign,
    phases: [{ phase: { id: 'phase-1', campaignId: 'foreign-campaign', name: 'Foreign', position: 0, state: 'draft', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' }, tasks: [] }] })).toThrow();
});
