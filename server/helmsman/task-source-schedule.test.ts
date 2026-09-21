import { roundRobinSchedulingProvider } from '../../src/plugins/scheduling/provider';
import type { SchedulingProviderV1 } from '../../src/plugins/scheduling-provider';
import { createSchedulingProviderRegistry } from './scheduling-providers';
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
function setup(policy: SchedulingProviderV1 = roundRobinSchedulingProvider) {
  const f = fixture(); opened.push(f.persistence); const local = openLocalSourceAdapter(f.store); const registry = createTaskSourceRegistry({ eligible: () => true });
  const list = vi.fn<NonNullable<typeof provider.list>>(async (request, context) => ({ items: [{ version: 1, ref: { sourceId: context.instance.sourceId, externalId: '1' }, revision: '1', displayKey: 'T-1', title: 'Work', repo: request.repo, url: null, state: 'ready', priority: 1, requirements: { description: 'Do work', acceptanceCriteria: [], links: [] }, providerData: null } as TaskSnapshotV1], nextCursor: null }));
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: [] }, { ...provider, list })]);
  const second = f.store.provision({ ...f.input, provisioningKey: 'second', collectionId: '00000000-0000-4000-8000-000000000003', identityEvidence: { ...f.input.identityEvidence, authority: { ...f.input.identityEvidence.authority, authorityId: '00000000-0000-4000-8000-000000000003' } } });
  f.persistence.transaction(() => writeTaskSource(f.store, { ...second.source, conversionReady: true }));
  const service = createTaskSourceService({ ...f, registry, local, http() { throw new Error('unused'); } });
  let policyRevision = 'first'; let policyEnabled = true;
  const policies = createSchedulingProviderRegistry({ eligible: () => policyEnabled });
  const registration = policies.stage({ providerId: 'example.scheduler/policy', pluginId: 'example.scheduler', artifactHash: 'b'.repeat(64), contractVersion: 1 }, policy); policies.publish([registration]);
  const unavailable = vi.fn(); const schedule = openTaskSourceSchedule(f.store, service, unavailable, () => ({ registration: policies.resolve(registration.binding), revision: policyRevision }));
  return { ...f, second, list, service, schedule, unavailable, policyChanged: () => { policyRevision += 'x'; }, disablePolicy: () => { policyEnabled = false; } };
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

it('lets an alternate policy choose a different source and a task beyond the first page', async () => {
  const f = setup({ intervalMs: 1000, async select(input, context) {
    const source = input.sources.at(-1)!;
    const first = await context.list({ instanceId: source.instanceId, cursor: null, limit: 1 });
    const second = await context.list({ instanceId: source.instanceId, cursor: first.nextCursor, limit: 1 });
    return { candidateId: second.items[0]!.candidateId };
  } });
  const repo = 'owner/project'; const configured = f.schedule.select(repo, [f.instance.id, f.second.instance.id], 0);
  const original = f.list.getMockImplementation()!;
  f.list.mockImplementation(async (...args) => {
    const page = await original(...args); const later = args[0].cursor !== null;
    return { items: page.items.map(task => ({ ...task, ref: { ...task.ref, externalId: later ? '2' : '1' }, displayKey: later ? 'T-2' : 'T-1', priority: later ? 0 : 9 })), nextCursor: later ? null : 'next-private-source-cursor' };
  });
  const ticket = await f.schedule.next(repo, new AbortController().signal);
  expect(ticket).toMatchObject({ sourceInstanceId: configured.instanceIds.at(-1), ticketId: 'T-2' });
  const evidence = f.persistence.transaction(() => f.schedule.assertAdmission({ ...ticket!, repo }));
  expect(evidence).toMatchObject({ provider: { providerId: 'example.scheduler/policy', artifactHash: 'b'.repeat(64) }, taskRevision: '1' });
  expect(() => f.schedule.assertAdmission({ ...ticket!, repo })).toThrow(/unavailable/);
});
it('rejects forged choices and discovery outside the scoped sources', async () => {
  const forged = setup({ intervalMs: 1000, async select() { return { candidateId: 'invented' }; } });
  forged.schedule.select('owner/project', [forged.instance.id], 0);
  await expect(forged.schedule.next('owner/project', new AbortController().signal)).rejects.toThrow('undiscovered');
  const outside = setup({ intervalMs: 1000, async select(_input, context) { await context.list({ instanceId: 'unselected', cursor: null, limit: 1 }); return null; } });
  outside.schedule.select('owner/project', [outside.instance.id], 0);
  await expect(outside.schedule.next('owner/project', new AbortController().signal)).rejects.toThrow('outside');
});
it('fences policy changes and disablement during discovery and before final admission', async () => {
  for (const change of ['policyChanged', 'disablePolicy'] as const) {
    const f = setup(); const repo = 'owner/project'; f.schedule.select(repo, [f.instance.id], 0);
    const ticket = await f.schedule.next(repo, new AbortController().signal); f[change]();
    expect(() => f.schedule.assertAdmission({ ...ticket!, repo })).toThrow();
    const g = setup(); g.schedule.select(repo, [g.instance.id], 0); const original = g.list.getMockImplementation()!;
    g.list.mockImplementationOnce(async (...args) => { const page = await original(...args); g[change](); return page; });
    await expect(g.schedule.next(repo, new AbortController().signal)).rejects.toThrow();
  }
});
it('fences source changes, quarantine, concurrent claims and modified decisions at admission', async () => {
  for (const change of ['source', 'quarantine', 'claim', 'schedule', 'ticket'] as const) {
    const f = setup(); const repo = 'owner/project'; f.schedule.select(repo, [f.instance.id], 0);
    const ticket = await f.schedule.next(repo, new AbortController().signal); const body = { ...ticket!, repo };
    if (change === 'source') f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: f.instance.revision, desiredEnabled: false });
    if (change === 'quarantine') f.store.quarantine({ sourceId: f.source.id, externalId: '1', displayKey: null, reason: 'conflict', evidence: null });
    if (change === 'claim') f.store.reserveWork({ ref: ticket!.workRef!, admissionId: 'other', runId: 'other', instanceId: f.instance.id, expectedInstanceRevision: f.instance.revision, expectedSourceRevision: f.source.revision });
    if (change === 'schedule') f.schedule.select(repo, [], 1);
    if (change === 'ticket') body.title = 'changed';
    expect(() => f.schedule.assertAdmission(body)).toThrow();
  }
  expect(setup().schedule.assertAdmission({ repo: 'owner/project' })).toBeNull();
});
it('cancels providers that ignore the signal and rejects retained discovery callbacks', async () => {
  let retained: Parameters<SchedulingProviderV1['select']>[1] | undefined;
  const f = setup({ intervalMs: 1000, async select(_input, context) { retained = context; return new Promise(() => {}); } });
  f.schedule.select('owner/project', [f.instance.id], 0); const controller = new AbortController();
  const pending = f.schedule.next('owner/project', controller.signal); await Promise.resolve(); controller.abort();
  await expect(pending).rejects.toThrow();
  await expect(retained!.list({ instanceId: f.instance.id, cursor: null, limit: 1 })).rejects.toThrow(); expect(f.list).not.toHaveBeenCalled();
});
