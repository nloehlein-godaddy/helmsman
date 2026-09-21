import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPersistence, type Persistence } from './persistence';
import { CampaignConflictError, openCampaignStore } from './campaigns';
import { createCampaignPublicService } from './campaigns-public-service';
import { handleCampaignPublicApi } from './campaigns-public-routes';
import type { CampaignCommandInputV1, CampaignCommandReceiptV1, CampaignCommandV1 } from '../../src/plugins/campaigns';

const caller = 'example.campaigns/panel'; const stores: Persistence[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function setup() {
  const persistence = openPersistence(':memory:'); stores.push(persistence); const store = openCampaignStore(persistence.sql);
  let repos = ['org/a', 'org/b']; let workflows = [{ ref: 'review@1', name: 'Review' }];
  const options = { persistence, store, repos: () => repos, workflows: () => workflows, authorize: vi.fn() };
  const service = createCampaignPublicService(options);
  const command = (input: CampaignCommandInputV1): CampaignCommandV1 => ({ ...input, requestId: randomUUID() });
  const submit = (input: CampaignCommandInputV1) => service.submit(caller, command(input), input.repo);
  const created = submit({ version: 1, repo: 'org/a', action: 'create', name: 'Campaign', workflowRef: 'review@1', concurrency: 1 });
  if (created.result?.kind !== 'created') throw new Error(JSON.stringify(created)); const campaign = created.result.campaign;
  const target = () => ({ campaignId: campaign.id, revision: service.detail(caller, { version: 1, repo: 'org/a', campaignId: campaign.id }, 'org/a').revision });
  const added = submit({ version: 1, repo: 'org/a', action: 'add-phase', target: target(), name: 'First' });
  if (added.result?.kind !== 'phase') throw new Error(JSON.stringify(added)); const phase = added.result.phase;
  const preview = (records: { task: string; repo?: string }[] = [{ task: 'do work' }]) => submit({ version: 1, repo: 'org/a', action: 'preview', target: target(), phaseId: phase.id, format: 'jsonl', content: records.map(record => JSON.stringify(record)).join('\n') });
  const confirm = (receipt: CampaignCommandReceiptV1) => { if (receipt.result?.kind !== 'preview') throw new Error(JSON.stringify(receipt)); return submit({ version: 1, repo: 'org/a', action: 'confirm', target: target(), previewId: receipt.result.preview.id, digest: receipt.result.preview.digest }); };
  return { persistence, store, service, options, command, submit, campaign, phase, target, preview, confirm, repos: (next: string[]) => { repos = next; }, workflows: () => { workflows = []; } };
}
describe('public campaign atomic commands', () => {
  it('replays durable receipts before current revision checks across restart, and conflicts on changed input', () => {
    const f = setup(); const input = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: f.target(), name: 'Second' });
    const first = f.service.submit(caller, input, 'org/a'); expect(first.status).toBe('succeeded');
    const restarted = createCampaignPublicService(f.options); expect(restarted.submit(caller, input, 'org/a')).toEqual(first);
    expect(f.store.phases(f.campaign.id)).toHaveLength(2);
    expect(() => restarted.submit(caller, { ...input, action: 'add-phase', target: f.target(), name: 'Changed' }, 'org/a')).toThrow('conflict');
    expect(f.service.receipt('example.other/panel', { repo: 'org/a', requestId: input.requestId }, 'org/a')).toBeNull();
  });
  it('rolls back mutations when receipt persistence fails and retries once with the same identity', () => {
    const f = setup(); const input = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: f.target(), name: 'Second' });
    f.persistence.sql.exec("CREATE TRIGGER reject_campaign_receipt BEFORE INSERT ON public_campaign_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    expect(() => f.service.submit(caller, input, 'org/a')).toThrow('injected receipt failure');
    expect(f.store.phases(f.campaign.id)).toHaveLength(1); expect(f.service.receipt(caller, { repo: 'org/a', requestId: input.requestId }, 'org/a')).toBeNull();
    f.persistence.sql.exec('DROP TRIGGER reject_campaign_receipt');
    expect(f.service.submit(caller, input, 'org/a').status).toBe('succeeded'); expect(f.store.phases(f.campaign.id)).toHaveLength(2);
  });
  it('retains stale-revision rejection and enforces phase membership and configured workflow gates', () => {
    const f = setup(); const stale = f.target(); f.submit({ version: 1, repo: 'org/a', action: 'add-phase', target: stale, name: 'Second' });
    const input = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: stale, name: 'Stale' });
    const rejected = f.service.submit(caller, input, 'org/a'); expect(rejected).toMatchObject({ status: 'rejected', reason: expect.stringContaining('changed') });
    expect(f.service.submit(caller, input, 'org/a')).toEqual(rejected);
    expect(f.submit({ version: 1, repo: 'org/a', action: 'phase', target: f.target(), phaseId: 'foreign-phase', operation: 'stop' }).status).toBe('rejected');
    f.confirm(f.preview()); f.workflows();
    expect(f.submit({ version: 1, repo: 'org/a', action: 'phase', target: f.target(), phaseId: f.phase.id, operation: 'start' })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('workflow') });
    expect(f.store.phase(f.phase.id)?.state).toBe('draft');
  });
  it('pins preview contents/digest and keeps explicit configured task galleon overrides visible', () => {
    const f = setup(); const preview = f.preview([{ task: 'do other work', repo: 'org/b' }]);
    expect(preview).toMatchObject({ status: 'succeeded', result: { kind: 'preview', preview: { records: [{ repo: 'org/b' }] } } });
    if (preview.result?.kind !== 'preview') throw new Error('preview missing'); const pinned = preview.result.preview;
    expect(f.submit({ version: 1, repo: 'org/a', action: 'confirm', target: f.target(), previewId: pinned.id, digest: '0'.repeat(64) }).status).toBe('rejected');
    const tampered = { ...pinned, records: [{ ...pinned.records[0]!, task: 'changed after preview' }] };
    f.persistence.sql.prepare('UPDATE campaign_previews SET payload=? WHERE id=?').run(JSON.stringify(tampered), pinned.id);
    expect(f.confirm(preview).status).toBe('rejected'); expect(f.store.tasks(f.phase.id)).toEqual([]);
    f.persistence.sql.prepare('UPDATE campaign_previews SET payload=? WHERE id=?').run(JSON.stringify(pinned), pinned.id);
    f.repos(['org/a']); expect(f.confirm(preview).status).toBe('rejected');
    f.repos(['org/a', 'org/b']); expect(f.confirm(preview).status).toBe('succeeded'); expect(f.store.tasks(f.phase.id)[0]?.record.repo).toBe('org/b');
  });
  it('preserves stop/finish task cancellation and failed-task retry attempt gates', () => {
    const f = setup(); f.confirm(f.preview());
    expect(f.submit({ version: 1, repo: 'org/a', action: 'phase', target: f.target(), phaseId: f.phase.id, operation: 'start' }).status).toBe('succeeded');
    const task = f.store.tasks(f.phase.id)[0]!; const claim = f.store.claim(task.id)!; f.store.markLaunched(task.id, claim.claimToken!); f.store.settle(task.id, task.runId, 'failed'); f.store.completePhases();
    expect(f.submit({ version: 1, repo: 'org/a', action: 'retry-task', target: f.target(), taskId: task.id, expectedAttempt: 2 }).status).toBe('rejected');
    const retried = f.submit({ version: 1, repo: 'org/a', action: 'retry-task', target: f.target(), taskId: task.id, expectedAttempt: 1 });
    expect(retried).toMatchObject({ status: 'succeeded', result: { kind: 'retried', task: { attempt: 2, state: 'queued' } } });
    expect(f.submit({ version: 1, repo: 'org/a', action: 'phase', target: f.target(), phaseId: f.phase.id, operation: 'finish' }).status).toBe('succeeded');
    expect(f.store.tasks(f.phase.id)[0]?.state).toBe('cancelled');
    expect(f.submit({ version: 1, repo: 'org/a', action: 'retry-task', target: f.target(), taskId: task.id, expectedAttempt: 2 }).status).toBe('rejected');
  });
  it('rejects foreign/header scope and invalid duplicate queries without state changes', async () => {
    const f = setup(); const input = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: f.target(), name: 'Forbidden' });
    expect(() => f.service.submit(caller, input, 'org/b')).toThrow('not-found');
    expect(() => f.service.detail(caller, { version: 1, repo: 'org/b', campaignId: f.campaign.id }, 'org/b')).toThrow('not-found');
    expect(() => f.service.list(caller, { version: 1, repo: null }, 'org/a')).toThrow('forbidden');
    expect(await handleCampaignPublicApi({ caller, service: f.service, method: 'GET', path: '/api/campaign-service/list', query: new URLSearchParams('version=1&repo=org/a&repo=org/b') })).toMatchObject({ status: 400 });
    expect(await handleCampaignPublicApi({ caller, service: f.service, method: 'POST', path: '/api/campaign-service/commands', query: new URLSearchParams(), body: { command: input } })).toMatchObject({ status: 400 });
    expect(f.store.phases(f.campaign.id)).toHaveLength(1);
  });
  it('refuses separate mutation connections and validates retained receipt integrity', () => {
    const f = setup(); const other = openPersistence(':memory:'); stores.push(other);
    expect(() => createCampaignPublicService({ ...f.options, persistence: other })).toThrow('same database connection');
    const input = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: f.target(), name: 'Second' }); f.service.submit(caller, input, 'org/a');
    f.persistence.sql.prepare('UPDATE public_campaign_receipts SET hash=? WHERE requestId=?').run('0'.repeat(64), input.requestId);
    expect(() => f.service.receipt(caller, { repo: 'org/a', requestId: input.requestId }, 'org/a')).toThrow('integrity');
  });
});

it('rolls back partial rejected mutations while committing the rejection receipt', () => {
  const f = setup(); const original = f.store.createPhase.bind(f.store);
  vi.spyOn(f.store, 'createPhase').mockImplementationOnce((campaignId, input) => { original(campaignId, input); throw new CampaignConflictError('Injected conflict after write'); });
  const command = f.command({ version: 1, repo: 'org/a', action: 'add-phase', target: f.target(), name: 'Rolled back' });
  expect(f.service.submit(caller, command, 'org/a')).toMatchObject({ status: 'rejected', reason: 'Injected conflict after write' });
  expect(f.store.phases(f.campaign.id)).toHaveLength(1);
  expect(f.service.receipt(caller, { repo: 'org/a', requestId: command.requestId }, 'org/a')?.status).toBe('rejected');
});

it('reopens an on-disk receipt after response loss and never creates a duplicate campaign', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-campaign-receipt-')); const file = join(directory, 'state.sqlite');
  let persistence = openPersistence(file);
  try {
    const options = { persistence, store: openCampaignStore(persistence.sql), repos: () => ['org/a'], workflows: () => [{ ref: 'review@1', name: 'Review' }], authorize: () => {} };
    const command: CampaignCommandV1 = { version: 1, requestId: randomUUID(), repo: 'org/a', action: 'create', name: 'Retained', workflowRef: 'review@1', concurrency: 1 };
    const first = createCampaignPublicService(options).submit(caller, command, 'org/a'); persistence.close();
    persistence = openPersistence(file); const store = openCampaignStore(persistence.sql);
    const restarted = createCampaignPublicService({ ...options, persistence, store });
    expect(restarted.submit(caller, command, 'org/a')).toEqual(first); expect(store.list()).toHaveLength(1);
  } finally { persistence.close(); rmSync(directory, { recursive: true, force: true }); }
});


it('accepts authored workflow references and delegates legacy alias availability without changing stored identities', () => {
  const f = setup(); let available = true;
  const service = createCampaignPublicService({ ...f.options, workflows: () => [{ ref: 'example.flow/coding@1', name: 'Authored coding' }],
    workflowAvailable: ref => available && ['example.flow/coding@1', 'coding@1'].includes(ref) });
  for (const workflowRef of ['example.flow/coding@1', 'coding@1']) {
    const receipt = service.submit(caller, f.command({ version: 1, action: 'create', repo: 'org/a', name: 'Authored', workflowRef, concurrency: 1 }), 'org/a');
    expect(receipt).toMatchObject({ status: 'succeeded', result: { kind: 'created', campaign: { workflowRef } } });
  }
  expect(service.list(caller, { version: 1, repo: 'org/a' }, 'org/a').workflows).toEqual([{ ref: 'example.flow/coding@1', name: 'Authored coding' }]);
  available = false;
  expect(service.submit(caller, f.command({ version: 1, action: 'create', repo: 'org/a', name: 'Unavailable', workflowRef: 'coding@1', concurrency: 1 }), 'org/a').status).toBe('rejected');
});
