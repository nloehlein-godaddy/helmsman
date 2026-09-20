import { afterEach, describe, expect, it } from 'vitest';
import { alternativeSource } from '../../../src/plugins/local-tasks-alternative/source';
import { todosProvider } from '../../../src/plugins/todos/provider';
import type { PluginJson } from '../../../src/plugins/backend';
import { fixture, binding } from './fixtures.test-support';
import { openLocalSourceAdapter } from './local-records';
import { createTaskSourceRegistry } from './registry';
import { createSourceAdmissionCoordinator } from './admission';
import type { Persistence } from '../persistence';
const opened: Persistence[] = [];
function setup(layout: 'documents' | 'legacy-todos' = 'documents', taskProvider = todosProvider) {
  const f = fixture(layout); opened.push(f.persistence);
  const local = openLocalSourceAdapter(f.store, () => '2026-09-20T01:00:00.000Z');
  const registry = createTaskSourceRegistry({ eligible: () => true }); registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], access: ['local-records'], effectIds: [], commandIds: ['create', 'update', 'delete'] }, taskProvider)]);
  const context = (instance: typeof f.instance, repo: string, signal: AbortSignal) => ({ instance, repo, signal, http: null, local: local.forContext(instance, repo, signal) });
  const coordinator = createSourceAdmissionCoordinator({ ...f, local, registry, context });
  const data = { version: 1, title: 'Task', description: 'Do it', acceptanceCriteria: '', priority: 'P2', state: 'todo' };
  const created = local.applyCommand({ requestId: 'create-one', commandId: 'create', commandInput: data, instance: f.instance, repo: 'owner/project', plan: { kind: 'create', schema: 'helmsman.local-task/v1', repo: 'owner/project', data } });
  return { ...f, local, registry, coordinator, created: created! };
}
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
for (const taskProvider of [todosProvider, alternativeSource]) for (const layout of ['documents', 'legacy-todos'] as const) describe(`source admission using ${taskProvider === todosProvider ? 'shipped' : 'replacement'} / ${layout}`, () => {
  it('rolls local claims and admission projection back together; completes through original disabled binding', async () => {
    const { coordinator, store, local, source, instance, created } = setup(layout, taskProvider);
    const claim = coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'a', runId: 'r', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
    const prepared = await coordinator.prepare({ claimId: claim.id, repo: created.repo, signal: new AbortController().signal });
    expect(() => coordinator.commit(prepared, () => { throw new Error('run insertion failed'); })).toThrow('run insertion failed');
    expect((local.get(source.id, created.ref.externalId)?.data as Record<string, PluginJson>).state).toBe('todo'); expect(store.claim(claim.id)?.state).toBe('reserved');
    const acknowledged = coordinator.commit(prepared, current => current);
    expect((local.get(source.id, created.ref.externalId)?.data as Record<string, PluginJson>).state).toBe('in_progress');
    store.configureInstance({ instanceId: instance.id, expectedRevision: 1, desiredEnabled: false });
    const settled = await coordinator.prepareSettlement({ purpose: 'completion', claimId: claim.id, repo: created.repo, signal: new AbortController().signal, request: { runId: 'r', attempt: 1, task: prepared.task, claimReceipt: acknowledged.receipt!, outcome: 'succeeded', publication: null } });
    coordinator.commitSettlement(settled, () => {});
    expect(store.claim(claim.id)?.state).toBe('settled'); expect((local.get(source.id, created.ref.externalId)?.data as Record<string, PluginJson>).state).toBe('in_review');
  });
  it('records idempotent commands and blocks edits while reserved', () => {
    const { coordinator, source, instance, created, local } = setup(layout, taskProvider);
    expect(local.commandResult({ requestId: 'create-one', commandId: 'create', commandInput: { version: 1, title: 'Task', description: 'Do it', acceptanceCriteria: '', priority: 'P2', state: 'todo' }, instance, repo: created.repo })).toEqual({ found: true, result: created });
    coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'a', runId: 'r', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
    expect(() => local.applyCommand({ requestId: 'delete', commandId: 'delete', commandInput: null, instance, repo: created.repo, plan: { kind: 'delete', ref: created.ref, expectedRevision: created.revision } })).toThrow(/Claimed/);
  });
  it('aborts a claimed preflight transactionally and releases ownership only after source restoration', async () => {
    const { coordinator, store, local, source, instance, created } = setup(layout, taskProvider);
    const claim = coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'a', runId: 'r', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
    const prepared = await coordinator.prepare({ claimId: claim.id, repo: created.repo, signal: new AbortController().signal });
    const acknowledged = coordinator.commit(prepared, current => current);
    const settlement = await coordinator.prepareSettlement({ purpose: 'abort', claimId: claim.id, repo: created.repo, signal: new AbortController().signal, request: { admissionId: 'a', runId: 'r', task: prepared.task, claimReceipt: acknowledged.receipt, reason: 'preflight-failed', claimSteps: [] } });
    expect(() => coordinator.commitSettlement(settlement, () => { throw new Error('failure'); })).toThrow('failure'); expect(store.activeClaim(created.ref)?.state).toBe('settling');
    coordinator.commitSettlement(settlement, () => {}); expect(store.activeClaim(created.ref)).toBeNull(); expect(local.get(source.id, created.ref.externalId)?.lastRunId).toBeNull(); expect((local.get(source.id, created.ref.externalId)?.data as Record<string, PluginJson>).state).toBe('todo');
  });
});

it('keeps one durable abort identity as observations and cancellation reasons change', async () => {
  const { coordinator, created, source, instance } = setup();
  const claim = coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'abort-repeat', runId: 'run-repeat', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
  const prepared = await coordinator.prepare({ claimId: claim.id, repo: created.repo, signal: new AbortController().signal });
  const acknowledged = coordinator.commit(prepared, value => value);
  const request = { admissionId: claim.admissionId, runId: claim.runId, task: prepared.task, claimReceipt: acknowledged.receipt, reason: 'cancelled' as const, claimSteps: [] };
  const first = await coordinator.prepareSettlement({ purpose: 'abort', claimId: claim.id, repo: created.repo, signal: new AbortController().signal, request });
  const second = await coordinator.prepareSettlement({ purpose: 'abort', claimId: claim.id, repo: created.repo, signal: new AbortController().signal, request: { ...request, reason: 'preflight-failed', claimSteps: [{ operationId: 'old-observation', state: 'unsent', evidence: null }] } });
  expect(second.requestHash).toBe(first.requestHash); expect('reason' in second.request && second.request.reason).toBe('cancelled');
  coordinator.commitSettlement(second, () => {});
});

it('rejects retry identity changes after reservation before invoking the provider', async () => {
  const { coordinator, created, source, instance } = setup();
  const claim = coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'plain', runId: 'new-run', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
  await expect(coordinator.prepare({ claimId: claim.id, repo: created.repo, signal: new AbortController().signal, retryOf: 'invented-owner' })).rejects.toThrow(/retry owner/);
});

it('persists abort intent and retains ownership when the pinned provider is unavailable', async () => {
  const { coordinator, created, source, instance, registry, persistence, store } = setup();
  const claim = coordinator.reserve({ ref: created.ref, repo: created.repo, admissionId: 'offline-abort', runId: 'offline-run', instanceId: instance.id, expectedInstanceRevision: 1, expectedSourceRevision: source.revision }, () => {});
  const prepared = await coordinator.prepare({ claimId: claim.id, repo: created.repo, signal: new AbortController().signal });
  const acknowledged = coordinator.commit(prepared, value => value);
  registry.removePlugin(binding.pluginId);
  await expect(coordinator.prepareSettlement({ purpose: 'abort', claimId: claim.id, repo: created.repo, signal: new AbortController().signal,
    request: { admissionId: claim.admissionId, runId: claim.runId, task: prepared.task, claimReceipt: acknowledged.receipt, reason: 'preflight-failed', claimSteps: [] } })).rejects.toThrow('unavailable');
  expect(store.claim(claim.id)?.state).toBe('settling');
  expect(persistence.sql.prepare('SELECT json FROM source_settlements').all()).toHaveLength(1);
  expect(store.activeClaim(created.ref)?.id).toBe(claim.id);
});
