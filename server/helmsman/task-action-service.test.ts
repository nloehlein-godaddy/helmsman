// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceEffectHandlerV1, TaskSourceProviderV1 } from '../../src/plugins/tasks';
import type { SourceRemoteActionPlanV1, SourceRemoteActionCommandV1 } from '../../src/plugins/task-actions';
import { openExecutionStore } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { createRecoveryService } from './recovery-service';
import { openOperationStore } from './operations';
import { type Persistence } from './persistence';
import { createTaskSourceRegistry } from './task-sources/registry';
import { fixture as sourceFixture, binding, provider } from './task-sources/fixtures.test-support';
import { writeTaskSource } from './task-sources/store';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceService } from './task-source-service';
import { createTaskActionService, type TaskActionServerOptions } from './task-action-service';
import { handleTaskActionApi } from './task-action-routes';
import { ClarificationServiceError } from './clarification-service-common';
const databases: Persistence[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
const caller = 'example.tasks/triage';
function fixture() {
  const f = sourceFixture(); databases.push(f.persistence);
  const executions = openExecutionStore(f.persistence);
  const operations = openOperationStore(f.persistence, executions);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const ref = { sourceId: f.source.id, externalId: '42' };
  const command: SourceRemoteActionCommandV1 = { version: 1, action: 'assign-self', requestId: '00000000-0000-4000-8000-000000000123',
    selection: { version: 1, sourceId: f.source.id, instanceId: f.instance.id, instanceRevision: f.instance.revision, repo: 'owner/project' }, sourceRevision: f.source.revision,
    target: { ref, repo: 'owner/project', expectedRevision: 'before' } };
  const result = { ref, repo: command.target.repo, revision: 'after', accountId: 'authenticated-self' };
  const plan: SourceRemoteActionPlanV1 = { version: 1, action: 'assign-self', kind: 'effect', effectId: 'assign', target: { ref }, payload: { accountId: result.accountId }, receipt: { ref, repo: result.repo, accountId: result.accountId } };
  const send = vi.fn(async (_input: { method: string; path: string; body: unknown }) => ({ status: 204, body: null }));
  const get = vi.fn(async (_input: { path: string }) => ({ status: 200, body: {} }));
  const invoke = vi.fn<SourceEffectHandlerV1['invoke']>(async (_input, context) => { await context.http.send({ method: 'PUT', path: '/issue/42/assignee', body: {} }); return { status: 'acknowledged', receipt: { result } }; });
  const reconcile = vi.fn<SourceEffectHandlerV1['reconcile']>(async (_input, context) => { await context.http.get({ path: '/issue/42', query: {} }); return { status: 'acknowledged', receipt: { result } }; });
  const prepare = vi.fn<NonNullable<TaskSourceProviderV1['prepareRemoteAction']>>(async () => plan);
  const load = vi.fn<TaskSourceProviderV1['load']>(async () => ({ version: 1, ref, revision: 'before', displayKey: 'TASK-42', title: 'Task', repo: result.repo, url: null, state: 'ready', priority: null, requirements: { description: '', acceptanceCriteria: [], links: [] }, providerData: null }));
  const taskProvider = { ...provider, load, prepareRemoteAction: prepare, effects: { assign: { delivery: 'reconcile' as const, invoke, reconcile } } };
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: ['assign'], commandIds: [], access: ['connection-http'], remoteActions: [{ id: 'assign-self', effectId: 'assign' }] }, taskProvider)]);
  const sources = createTaskSourceService({ store: f.store, registry, local: openLocalSourceAdapter(f.store), http: () => ({ get }) });
  const authorize = vi.fn((value: string) => { if (value !== caller) throw new ClarificationServiceError(403, 'forbidden'); });
  const options: TaskActionServerOptions = { ...f, registry, operations, service: sources, repos: () => ['owner/project'], authorize,
    actionArtifacts: () => [{ pluginId: binding.pluginId, artifactHash: binding.artifactHash, packageVersion: '1.0.0', requires: [] }], verifyArtifacts: vi.fn(async () => {}),
    actionHttp: (_instance, _signal, mutation, assert) => ({ get: async input => { assert(); return get(input); }, ...(mutation ? { send: async (input: Parameters<typeof send>[0]) => { assert(); return send(input); } } : {}) }) };
  const service = createTaskActionService(options);
  return { ...f, options, executions, operations, registry, sources, service, command, result, plan, prepare, invoke, reconcile, load, send, get, authorize,
    query: { repo: command.selection.repo, requestId: command.requestId } };
}
describe('durable remote source actions', () => {
  it('commits the reservation and operation before sending; replays without another effect', async () => {
    const f = fixture();
    f.send.mockImplementation(async () => {
      expect(f.persistence.sql.inTransaction).toBe(false);
      expect(f.service.receipt(caller, f.query, null)?.status).toBe('recovery-required');
      expect(f.operations.list()[0]).toMatchObject({ status: 'leased', deliveryAttempts: 1, requiresReconciliation: true });
      return { status: 204, body: null };
    });
    expect(await f.service.submit(caller, f.command, null)).toMatchObject({ status: 'succeeded', result: f.result });
    expect(await f.service.submit(caller, f.command, null)).toMatchObject({ status: 'succeeded' });
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.operations.list()).toHaveLength(1);
  });
  it('reserves immutable input before async preparation and deduplicates concurrent requests', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementation(async () => { await wait; return f.plan; });
    const first = f.service.submit(caller, f.command, null);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('pending');
    await expect(f.service.submit(caller, { ...f.command, target: { ...f.command.target, expectedRevision: 'changed' } }, null)).rejects.toThrow('content changed');
    release(); expect((await first).status).toBe('succeeded'); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('fences interrupted preparation after restart without dispatching a write', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementation(async () => { await wait; return f.plan; });
    const first = f.service.submit(caller, f.command, null); await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled());
    const restarted = createTaskActionService(f.options);
    expect(restarted.receipt(caller, f.query, null)?.status).toBe('rejected');
    release(); expect((await first).status).toBe('rejected'); expect(f.send).not.toHaveBeenCalled();
    expect((await restarted.submit(caller, f.command, null)).status).toBe('rejected');
  });
  it('supports provider-proven already-self completion with no operation or write', async () => {
    const f = fixture(); f.prepare.mockResolvedValue({ version: 1, action: 'assign-self', kind: 'acknowledged', result: f.result });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('succeeded');
    expect(f.operations.list()).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it('reconciles a lost reply with retained settings after source disablement and restart', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error('Reply lost'));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: f.instance.revision, desiredEnabled: false, settings: { project: 'changed' } });
    const restarted = createTaskActionService(f.options);
    expect((await restarted.retry(caller, f.query, null)).status).toBe('succeeded');
    expect(f.reconcile.mock.calls[0]?.[1].instance.settings).toEqual(f.instance.settings);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('exposes assignment failures in the core-owned repository Recovery scope', async () => {
    const f = fixture();
    const providerTarget = { sourceId: f.source.id, issueId: '42', repo: 'untrusted/project' };
    f.prepare.mockResolvedValue({ ...f.plan, target: providerTarget });
    f.send.mockRejectedValue(new Error('Reply lost'));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    const operation = f.operations.list()[0]!;
    expect(operation.target).toEqual({ repo: f.command.selection.repo, providerTarget });
    expect(f.invoke.mock.calls[0]?.[0].target).toEqual(providerTarget);
    const recovery = createRecoveryService({ db: { activeRuns: () => [], getRun: () => null }, executions: f.executions,
      admissions: openAdmissionStore(f.persistence, f.executions), operations: f.operations, lifecycle: { list: () => [] },
      callbacks: { reconcileOperation: async id => { await f.service.dispatch(id); } } });
    const selected = recovery.snapshot(f.command.selection.repo);
    expect(selected.errors).toEqual([]);
    expect(selected.operations).toMatchObject([{ id: operation.id, status: 'uncertain', actions: ['reconcile-operation'] }]);
    expect(selected.pins).toMatchObject([{ kind: 'operation', ownerId: operation.id }]);
    expect(recovery.snapshot('other/project').operations).toEqual([]);
    expect(recovery.snapshot('untrusted/project').operations).toEqual([]);
    expect(recovery.snapshot('untrusted/project').pins).toEqual([]);
    await recovery.act({ action: 'reconcile-operation', id: operation.id });
    expect(f.reconcile.mock.calls[0]?.[0].target).toEqual(providerTarget);
    expect(f.service.receipt(caller, f.query, null)?.status).toBe('succeeded');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('keeps repeated unknown reconciliations from replaying a remote write', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('Reply lost'));
    f.reconcile.mockResolvedValue({ status: 'unknown', reason: 'No proof', evidence: {} });
    await f.service.submit(caller, f.command, null);
    for (let i = 0; i < 3; i++) expect((await f.service.retry(caller, f.query, null)).status).toBe('recovery-required');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('requires explicit retry after definite no-write proof and preserves the original operation', async () => {
    const f = fixture(); f.invoke.mockResolvedValueOnce({ status: 'definitely-not-applied', retryable: true, reason: 'Preflight failed', evidence: {} });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    await f.service.submit(caller, f.command, null); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect((await f.service.retry(caller, f.query, null)).status).toBe('succeeded');
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.operations.list()).toHaveLength(1);
  });
  it('projects conclusive nonretryable no-write evidence as rejection with stable resolution', async () => {
    const f = fixture(); f.invoke.mockResolvedValue({ status: 'definitely-not-applied', retryable: false, reason: 'Another actor already owns the task', evidence: { assignee: 'other' } });
    const first = await f.service.submit(caller, f.command, null);
    expect(first).toMatchObject({ status: 'rejected', resolution: { version: 1, kind: 'not-applied' } });
    expect(f.service.receipt(caller, f.query, null)).toEqual(first);
    expect(await f.service.retry(caller, f.query, null)).toEqual(first);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('can resolve an uncertain delivery only from provider no-write proof', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('Reply lost'));
    f.reconcile.mockResolvedValue({ status: 'definitely-not-applied', retryable: false, reason: 'Exact evidence proves no assignment occurred', evidence: { proved: true } });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    expect(await f.service.retry(caller, f.query, null)).toMatchObject({ status: 'rejected', resolution: { kind: 'not-applied' } });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('checks current claims on every read and send within an invoked effect', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (_input, context) => {
      f.store.reserveWork({ ref: f.command.target.ref, admissionId: 'admission', runId: 'run', instanceId: f.instance.id, expectedSourceRevision: f.source.revision, expectedInstanceRevision: f.instance.revision });
      await context.http.send({ method: 'PUT', path: '/issue/42/assignee', body: {} });
      return { status: 'acknowledged', receipt: { result: f.result } };
    });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('fences a stale generation before any HTTP delivery', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (_input, context) => {
      f.persistence.sql.prepare('UPDATE operations SET generation=generation+1 WHERE id=?').run(context.operationId);
      await context.http.send({ method: 'PUT', path: '/issue/42/assignee', body: {} });
      return { status: 'acknowledged', receipt: { result: f.result } };
    });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required'); expect(f.send).not.toHaveBeenCalled();
  });
  it('verifies pinned artifacts again before dispatch', async () => {
    const f = fixture(); vi.mocked(f.options.verifyArtifacts).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Artifact changed'));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    expect(f.prepare).toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('checks source revision independently from selected instance revision', async () => {
    const f = fixture(); f.persistence.transaction(() => writeTaskSource(f.store, { ...f.source, revision: 7 }));
    expect(f.service.discover(caller, f.command.selection, null)).toMatchObject({ sourceRevision: 7, selection: { instanceRevision: 1 } });
    await expect(f.service.submit(caller, f.command, null)).rejects.toThrow('source revision');
    expect((await f.service.submit(caller, { ...f.command, sourceRevision: 7 }, null)).status).toBe('succeeded');
  });
  it('rejects stale task revisions before provider preparation or dispatch', async () => {
    const f = fixture(); expect((await f.service.submit(caller, { ...f.command, target: { ...f.command.target, expectedRevision: 'stale' } }, null)).status).toBe('rejected');
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects active work claims before preparation', async () => {
    const f = fixture(); f.store.reserveWork({ ref: f.command.target.ref, admissionId: 'admission', runId: 'run', instanceId: f.instance.id, expectedSourceRevision: f.source.revision, expectedInstanceRevision: f.instance.revision });
    await expect(f.service.submit(caller, f.command, null)).rejects.toThrow('active voyage'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('fences sends after provider preparation loses source authority', async () => {
    const f = fixture(); f.prepare.mockImplementation(async () => { f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: f.instance.revision, desiredEnabled: false }); return f.plan; });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('rejected'); expect(f.send).not.toHaveBeenCalled();
  });
  it('refuses mismatched completion actors and keeps the operation recoverable', async () => {
    const f = fixture(); f.invoke.mockResolvedValue({ status: 'acknowledged', receipt: { result: { ...f.result, accountId: 'another-actor' } } });
    expect((await f.service.submit(caller, f.command, null)).status).toBe('recovery-required');
    expect(f.operations.list()[0]?.requiresReconciliation).toBe(true);
  });
  it('enforces contribution, scope, and strict discovery authority fields at routes', async () => {
    const f = fixture(); const request = { method: 'POST', path: '/api/task-action/discover', query: new URLSearchParams(), caller, service: f.service, body: { selection: f.command.selection, scopeRepo: null } };
    expect((await handleTaskActionApi(request))?.status).toBe(200);
    expect((await handleTaskActionApi({ ...request, caller: 'example.other/triage' }))?.status).toBe(403);
    expect((await handleTaskActionApi({ ...request, body: { ...request.body, selection: { ...f.command.selection, accountId: 'injected' } } }))?.status).toBe(400);
    expect((await handleTaskActionApi({ ...request, body: { ...request.body, scopeRepo: 'other/project' } }))?.status).toBe(403);
  });
});
