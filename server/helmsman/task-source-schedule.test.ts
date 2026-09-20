import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskSnapshotV1 } from '../../src/plugins/tasks';
import { openTaskSourceSchedule } from './task-source-schedule';
import { createTaskSourceService } from './task-source-service';
import { createTaskSourceRegistry } from './task-sources/registry';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { fixture, binding, provider } from './task-sources/fixtures.test-support';
import { writeTaskSource } from './task-sources/store';
import type { Persistence } from './persistence';
const opened: Persistence[] = [];
function setup() {
  const f = fixture(); opened.push(f.persistence); const local = openLocalSourceAdapter(f.store); const registry = createTaskSourceRegistry({ eligible: () => true });
  const list = vi.fn<NonNullable<typeof provider.list>>(async (request, context) => ({ items: [{ version: 1, ref: { sourceId: context.instance.sourceId, externalId: '1' }, revision: '1', displayKey: 'T-1', title: 'Work', repo: request.repo, url: null, state: 'ready', priority: 1, requirements: { description: 'Do work', acceptanceCriteria: [], links: [] }, providerData: null } as TaskSnapshotV1], nextCursor: null }));
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: [] }, { ...provider, list })]);
  const second = f.store.provision({ ...f.input, provisioningKey: 'second', collectionId: '00000000-0000-4000-8000-000000000003', identityEvidence: { ...f.input.identityEvidence, authority: { ...f.input.identityEvidence.authority, authorityId: '00000000-0000-4000-8000-000000000003' } } });
  f.persistence.transaction(() => writeTaskSource(f.store, { ...second.source, conversionReady: true }));
  const service = createTaskSourceService({ ...f, registry, local, http() { throw new Error('unused'); } });
  const unavailable = vi.fn(); const schedule = openTaskSourceSchedule(f.store, service, unavailable);
  return { ...f, second, list, service, schedule, unavailable };
}
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
describe('task source scheduling', () => {
  it('seeds only the prior source once and fairly rotates explicit coexisting sources', async () => {
    const f = setup(); const repo = 'owner/project';
    f.schedule.initialize({ repos: [repo], defaultSourceId: f.source.id });
    expect(f.schedule.selections(repo).instanceIds).toEqual([f.instance.id]);
    f.schedule.initialize({ repos: [repo], defaultSourceId: f.second.source.id });
    expect(f.schedule.selections(repo).instanceIds).toEqual([f.instance.id]);
    const configured = f.schedule.select(repo, [f.second.instance.id, f.instance.id], 1);
    const first = await f.schedule.next(repo, new AbortController().signal); const second = await f.schedule.next(repo, new AbortController().signal); const third = await f.schedule.next(repo, new AbortController().signal);
    expect([first?.sourceInstanceId, second?.sourceInstanceId, third?.sourceInstanceId]).toEqual([configured.instanceIds[0], configured.instanceIds[1], configured.instanceIds[0]]);
    expect(() => f.schedule.select(repo, [], 1)).toThrow(/changed/);
  });
  it('skips disabled, quarantined and already claimed work without using an unselected source', async () => {
    const f = setup(); const repo = 'owner/project';
    f.schedule.select(repo, [f.instance.id, f.second.instance.id], 0);
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false });
    const selected = await f.schedule.next(repo, new AbortController().signal); expect(selected?.sourceInstanceId).toBe(f.second.instance.id);
    f.store.quarantine({ sourceId: f.second.source.id, externalId: '1', displayKey: null, reason: 'old owner', evidence: null });
    expect(await f.schedule.next(repo, new AbortController().signal)).toBeNull();
    f.schedule.select(repo, [], 1); expect(await f.schedule.next(repo, new AbortController().signal)).toBeNull();
  });
  it('rejects galleon mismatch, duplicate namespaces and schedule changes during discovery', async () => {
    const f = setup(); const repo = 'owner/project';
    expect(() => f.schedule.select('owner/other', [f.instance.id], 0)).toThrow(/galleon/);
    const same = f.store.provision({ ...f.input, provisioningKey: 'same-namespace' });
    expect(() => f.schedule.select(repo, [f.instance.id, same.instance.id], 0)).toThrow(/logical source/);
    f.schedule.select(repo, [f.instance.id], 0);
    const original = f.list.getMockImplementation()!;
    f.list.mockImplementationOnce(async (...args) => { const result = await original(...args); f.schedule.select(repo, [f.second.instance.id], 1); return result; });
    await expect(f.schedule.next(repo, new AbortController().signal)).rejects.toThrow(/changed during discovery/);
  });
  it('detects concurrent discovery cursor races rather than issuing the same source turn twice', async () => {
    const f = setup(); const repo = 'owner/project'; f.schedule.select(repo, [f.instance.id, f.second.instance.id], 0);
    const results = await Promise.allSettled([f.schedule.next(repo, new AbortController().signal), f.schedule.next(repo, new AbortController().signal)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    f.schedule.select(repo, [f.instance.id], 1); await f.schedule.next(repo, new AbortController().signal);
    const single = await Promise.allSettled([f.schedule.next(repo, new AbortController().signal), f.schedule.next(repo, new AbortController().signal)]);
    expect(single.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('bounds pagination failures and preserves cancellation', async () => {
    const f = setup(); const repo = 'owner/project'; f.schedule.select(repo, [f.instance.id], 0);
    f.list.mockResolvedValue({ items: [], nextCursor: 'repeat' });
    expect(await f.schedule.next(repo, new AbortController().signal)).toBeNull(); expect(f.unavailable).toHaveBeenCalledWith(f.instance.id); expect(f.list).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort(); await expect(f.schedule.next(repo, controller.signal)).rejects.toThrow();
  });
});
