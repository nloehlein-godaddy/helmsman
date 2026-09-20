// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginJson } from '../../../src/plugins/backend';
import type { SourceEffectHandlerV1, SourceMutationHttpV1, SourceMutationPlanV1, TaskSnapshotV1 } from '../../../src/plugins/tasks';
import { jiraProvider } from '../../../src/plugins/jira/provider';
import { jiraIssue } from '../../../src/plugins/jira/fixtures';
import { openPersistence, persistenceHash, stableJson, type Persistence } from '../persistence';
import { openOperationStore } from '../operations';
import { openExecutionStore } from '../execution-store';
import { dispatchOperation, type OperationContext } from '../operation-dispatcher';
import { createSourceHttp } from '../task-source-http';
import { createTaskSourceRegistry } from './registry';
import { openTaskSourceStore, writeTaskSource } from './store';
import { createSourceEffectCoordinator } from './effects';
import { createSourceAdmissionCoordinator } from './admission';
import { openLocalSourceAdapter } from './local-records';
import { provider as emptyProvider } from './fixtures.test-support';

const opened: Persistence[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
const repo = 'owner/project';
const artifactHash = 'a'.repeat(64);
const binding = { providerId: 'example.source/items', pluginId: 'example.source', artifactHash, contractVersion: 1 as const, connectionId: 'connection', credentialHandle: 'credential' };
const artifacts = [{ pluginId: binding.pluginId, artifactHash, packageVersion: '1.0.0', requires: [] }];
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const store = openTaskSourceStore(persistence);
  let now = Date.parse('2026-09-20T00:00:00.000Z');
  const executions = openExecutionStore(persistence, () => now);
  const operations = openOperationStore(persistence, executions, { now: () => now });
  const registry = createTaskSourceRegistry({ eligible: () => true });
  let writeResult: 'acknowledged' | 'unknown' = 'acknowledged';
  let reconcileSawSend = false;
  let observedInstance: unknown;
  const invoke = vi.fn<SourceEffectHandlerV1['invoke']>(async (input, context) => {
    observedInstance = context.instance;
    await context.http.send({ method: 'PUT', path: '/work/10001', body: input.payload });
    return writeResult === 'acknowledged' ? { status: 'acknowledged', receipt: { applied: true, operationId: context.operationId } }
      : { status: 'unknown', reason: 'Response lost', evidence: { attempted: true } };
  });
  const reconcile = vi.fn<SourceEffectHandlerV1['reconcile']>(async (_input, context) => {
    reconcileSawSend = 'send' in context.http;
    await context.http.get({ path: '/work/10001', query: {} });
    return { status: 'acknowledged', receipt: { reconciled: true } };
  });
  const handler: SourceEffectHandlerV1 = { delivery: 'reconcile', invoke, reconcile };
  const provider = { ...emptyProvider, effects: { write: handler } };
  registry.publish([registry.stage({ ...binding, connectionId: null, credentialHandle: null }, { identityFormats: ['fixture.item/v1'], effectIds: ['write'], commandIds: [], access: ['connection-http'] }, provider)]);
  const provisioned = store.provision({ provisioningKey: 'remote', label: 'Remote', identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'fixture', authorityId: 'authority', identityFormat: 'fixture.item/v1' }, verifiedAt: new Date(now).toISOString(), proof: null },
    storageLayout: 'remote', binding, settings: {}, allowedRepos: [repo] });
  persistence.transaction(() => writeTaskSource(store, { ...provisioned.source, conversionReady: true }));
  const instance = provisioned.instance;
  const task: TaskSnapshotV1 = { version: 1, ref: { sourceId: instance.sourceId, externalId: '10001' }, revision: 'revision-1', displayKey: 'WORK-1', title: 'Work', repo, url: null, state: 'ready', priority: 1,
    requirements: { description: 'Do this', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } };
  const snapshot = store.retainTaskSnapshot(task, instance);
  const claim = store.reserveWork({ ref: task.ref, admissionId: 'admission-1', runId: 'run-1', instanceId: instance.id, expectedSourceRevision: 1, expectedInstanceRevision: 1 });
  const fetcher = vi.fn<typeof fetch>(async (_url, request) => request?.method === 'GET' ? new Response('{}') : new Response(null, { status: 204 }));
  let afterResolve: (() => void) | null = null;
  let allowed = true;
  const authorize = vi.fn(() => { if (!allowed) throw new Error('Run authorization revoked'); });
  const options = { store, registry, operations, artifacts: () => artifacts, authorize, now: () => now,
    http(_operation: unknown, context: OperationContext, _instance: unknown, mutation: boolean, check: () => void) {
      const connection = { id: binding.connectionId, credentialHandle: binding.credentialHandle, origin: 'https://source.example.com', subject: 'bot', authorityId: 'authority' };
      return createSourceHttp({ connection, signal: context.signal, mutation, fetcher, authorize: () => check(),
        resolve: async () => { afterResolve?.(); return { ...connection, headers: {} }; } });
    },
  };
  const effects = createSourceEffectCoordinator(options);
  const plan: Extract<SourceMutationPlanV1, { kind: 'remote-effects' }> = { kind: 'remote-effects', effects: [
    { localId: 'second', handler: 'write', target: { item: '10001' }, payload: { stage: 'second' }, after: ['first'] },
    { localId: 'first', handler: 'write', target: { item: '10001' }, payload: { stage: 'first' }, after: [] },
  ] };
  const identity = { claimId: claim.id, purpose: 'claim' as const, requestHash: claim.admissionId };
  const prepare = () => effects.prepare({ claim, task: snapshot, plan, purpose: 'claim', requestHash: claim.admissionId });
  return { persistence, store, executions, operations, registry, provider, instance, task, snapshot, claim, effects, options, plan, identity, prepare, invoke, reconcile, fetcher, authorize,
    get now() { return now; }, set now(value) { now = value; }, set writeResult(value: typeof writeResult) { writeResult = value; }, set afterResolve(value: () => void) { afterResolve = value; },
    set allowed(value: boolean) { allowed = value; }, get reconcileSawSend() { return reconcileSawSend; }, get observedInstance() { return observedInstance; } };
}
describe('durable source effect bridge', () => {
  it('pins a stable ordered plan atomically without inventing a worker attempt', async () => {
    const f = setup(); f.prepare(); f.prepare();
    const ids = f.effects.operationIds(f.identity);
    expect(ids).toHaveLength(2); expect(f.operations.list()).toHaveLength(2);
    const first = f.operations.get(ids[0]!)!; const second = f.operations.get(ids[1]!)!;
    expect(first.origin).toMatchObject({ kind: 'source-claim', id: f.claim.id, runId: null, attempt: null });
    expect(first.target).toEqual({ version: 1, claimId: f.claim.id, ref: f.task.ref, repo, instanceId: f.instance.id, value: { item: '10001' } });
    expect(second.dependencies).toEqual([first.id]);
    expect(f.executions.pins().filter(pin => pin.kind === 'operation')).toHaveLength(2);
    expect((await dispatchOperation(f.operations, second.id, f.effects.resolve)).status).toBe('pending');
    expect(f.invoke).not.toHaveBeenCalled();
    expect((await dispatchOperation(f.operations, first.id, f.effects.resolve)).status).toBe('completed');
    expect(f.effects.acknowledged(f.identity).ready).toBe(false);
    expect((await dispatchOperation(f.operations, second.id, f.effects.resolve)).status).toBe('completed');
    expect(f.effects.acknowledged(f.identity)).toMatchObject({ ready: true, blocked: false });
    expect(f.effects.acknowledged(f.identity).operations).toHaveLength(2);
    expect(f.invoke.mock.calls[0]?.[0].target).toEqual({ item: '10001' });
    expect(f.executions.pins().filter(pin => pin.kind === 'operation')).toHaveLength(0);
  });
  it('rolls every operation and pin back when staging transaction fails', () => {
    const f = setup();
    expect(() => f.persistence.transaction(() => { f.prepare(); throw new Error('Admission failed'); })).toThrow('Admission failed');
    expect(f.operations.list()).toHaveLength(0); expect(f.effects.operationIds(f.identity)).toHaveLength(0); expect(f.executions.pins()).toHaveLength(0);
    f.prepare(); expect(f.operations.list()).toHaveLength(2);
  });
  it('rejects changed plan, task snapshot, admission identity and duplicate logical claim plans', () => {
    const f = setup(); f.prepare();
    expect(() => f.effects.prepare({ claim: f.claim, task: f.snapshot, plan: { ...f.plan, effects: [{ ...f.plan.effects[0]!, payload: { different: true } }, f.plan.effects[1]!] }, purpose: 'claim', requestHash: f.claim.admissionId })).toThrow('identity');
    expect(() => f.effects.prepare({ claim: f.claim, task: { ...f.snapshot, task: { ...f.task, title: 'Forged' } }, plan: f.plan, purpose: 'claim', requestHash: f.claim.admissionId })).toThrow('snapshot');
    expect(() => f.effects.prepare({ claim: f.claim, task: f.snapshot, plan: f.plan, purpose: 'claim', requestHash: 'another-admission' })).toThrow('changed');
  });
  it('reconciles ambiguous delivery after coordinator restart through a read-only context', async () => {
    const f = setup(); f.prepare(); f.writeResult = 'unknown'; const first = f.effects.operationIds(f.identity)[0]!;
    expect((await dispatchOperation(f.operations, first, f.effects.resolve)).status).toBe('uncertain');
    expect(f.effects.claimSteps(f.claim.id).map(step => step.state)).toEqual(['uncertain', 'unsent']);
    const restarted = createSourceEffectCoordinator(f.options);
    expect((await dispatchOperation(f.operations, first, restarted.resolve, { reconcile: true })).status).toBe('completed');
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.reconcileSawSend).toBe(false);
    expect(f.fetcher.mock.calls.filter(([, request]) => request?.method !== 'GET')).toHaveLength(1);
  });
  it('keeps retained operations on their original disabled instance and provider artifact', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false, settings: { changed: true } });
    expect((await dispatchOperation(f.operations, first, f.effects.resolve)).status).toBe('completed');
    expect(f.observedInstance).toEqual(f.instance);
  });
  it('blocks unavailable providers without falling back to another installed implementation', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    f.registry.removePlugin(binding.pluginId);
    expect((await dispatchOperation(f.operations, first, f.effects.resolve)).status).toBe('blocked');
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.executions.pins().filter(pin => pin.kind === 'operation')).toHaveLength(2);
  });
  it('fences unsent abort steps while retaining ambiguous work and its pins', async () => {
    const f = setup(); f.prepare(); f.writeResult = 'unknown'; const ids = f.effects.operationIds(f.identity);
    await dispatchOperation(f.operations, ids[0]!, f.effects.resolve);
    expect(() => f.effects.fenceUnsentClaim(f.claim.id)).toThrow('durable');
    f.store.beginSettlement(f.claim.id, f.claim.revision);
    expect(f.effects.fenceUnsentClaim(f.claim.id).map(step => step.state)).toEqual(['uncertain', 'unsent']);
    expect(f.effects.fenceUnsentClaim(f.claim.id).map(step => step.state)).toEqual(['uncertain', 'unsent']);
    expect(f.effects.acknowledged(f.identity)).toMatchObject({ ready: false, blocked: true, operations: [] });
    expect(f.operations.get(ids[1]!)?.status).toBe('completed');
    expect(f.executions.pins().filter(pin => pin.kind === 'operation')).toHaveLength(1);
    await dispatchOperation(f.operations, ids[1]!, f.effects.resolve);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('never marks a leased but uninvoked operation unsent until its lease is resolved', () => {
    const f = setup(); f.prepare(); const ids = f.effects.operationIds(f.identity);
    const lease = f.operations.lease(ids[0]!, 10_000)!;
    f.store.beginSettlement(f.claim.id, f.claim.revision);
    expect(f.effects.fenceUnsentClaim(f.claim.id).map(step => step.state)).toEqual(['uncertain', 'unsent']);
    f.operations.settle(lease, { status: 'definitely-not-applied', retryable: false, reason: 'No request sent', evidence: { unsent: true } });
    expect(f.effects.fenceUnsentClaim(f.claim.id).map(step => step.state)).toEqual(['unsent', 'unsent']);
  });
  it('rechecks claim authorization after asynchronous credential preparation before HTTP mutation', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    f.afterResolve = () => { f.store.beginSettlement(f.claim.id, f.claim.revision); };
    const result = await dispatchOperation(f.operations, first, f.effects.resolve);
    expect(['leased', 'uncertain']).toContain(result.status);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rechecks external run authorization at the final broker boundary', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    f.afterResolve = () => { f.allowed = false; };
    expect((await dispatchOperation(f.operations, first, f.effects.resolve)).status).toBe('uncertain');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects stale generations and elapsed leases even if an old handler still has a broker', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    f.afterResolve = () => { f.now += 100_000; };
    await dispatchOperation(f.operations, first, f.effects.resolve, { timeoutMs: 100, leaseMs: 500 });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('requires a matching staged settlement and preserves actual completion attempt', async () => {
    const f = setup(); f.prepare();
    for (const id of f.effects.operationIds(f.identity)) await dispatchOperation(f.operations, id, f.effects.resolve);
    const acknowledged = f.store.acknowledgeClaim({ claimId: f.claim.id, expectedRevision: f.claim.revision, taskSnapshotHash: f.snapshot.hash, localRecordRevision: null, operations: f.effects.acknowledged(f.identity).operations });
    const claim = f.store.beginSettlement(acknowledged.id, acknowledged.revision);
    const request = { runId: claim.runId, attempt: 3, task: f.task, claimReceipt: acknowledged.receipt, outcome: 'succeeded', publication: { repo, prNumber: 42 } };
    const requestHash = persistenceHash({ purpose: 'completion', request });
    const input = { claim, task: f.snapshot, plan: { kind: 'remote-effects' as const, effects: [f.plan.effects[1]!] }, purpose: 'completion' as const, requestHash, attempt: 3 };
    expect(() => f.effects.prepare(input)).toThrow('settlement identity');
    const record = { claimId: claim.id, purpose: 'completion', request, state: 'requested' };
    f.persistence.sql.prepare('INSERT INTO source_settlements VALUES (?,?,?)').run('settlement', requestHash, stableJson(record));
    f.effects.prepare(input);
    const id = f.effects.operationIds({ claimId: claim.id, purpose: 'completion', requestHash })[0]!;
    expect(f.operations.get(id)?.origin).toMatchObject({ runId: claim.runId, attempt: 3 });
    expect((await dispatchOperation(f.operations, id, f.effects.resolve)).status).toBe('blocked');
    f.persistence.sql.prepare('UPDATE source_settlements SET json=? WHERE id=?').run(stableJson({ ...record, state: 'staged' }), 'settlement');
    f.operations.retry(id, { actor: 'operator', reason: 'Settlement staged', evidence: { staged: true } });
    expect((await dispatchOperation(f.operations, id, f.effects.resolve)).status).toBe('completed');
  });
  it('detects corrupted stored plan contents before resolving or acknowledging operations', async () => {
    const f = setup(); f.prepare(); const first = f.effects.operationIds(f.identity)[0]!;
    const row = f.persistence.sql.prepare('SELECT id,json FROM source_effect_plans').get() as { id: string; json: string };
    const value = JSON.parse(row.json); value.definition.effects[0].payload = { redirected: true };
    f.persistence.sql.prepare('UPDATE source_effect_plans SET json=? WHERE id=?').run(JSON.stringify(value), row.id);
    expect(() => f.effects.acknowledged(f.identity)).toThrow('integrity');
    expect((await dispatchOperation(f.operations, first, f.effects.resolve)).status).toBe('blocked');
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('Jira admission through the public provider and durable bridge', () => {
  it('waits for assignment and transition before launch, then completes a disabled source through retained receipts', async () => {
    const f = setup();
    f.registry.removePlugin(binding.pluginId);
    const registrationBinding = { ...binding, connectionId: null, credentialHandle: null };
    f.registry.publish([f.registry.stage(registrationBinding, { identityFormats: ['jira.issue-id/v1'], effectIds: ['assign', 'transition', 'retain-claim'], commandIds: [], access: ['connection-http'] }, jiraProvider)]);
    const source = f.store.provision({ provisioningKey: 'jira', label: 'Jira', identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'jira.cloud', authorityId: 'tenant', identityFormat: 'jira.issue-id/v1' }, verifiedAt: '2026-09-20T00:00:00Z', proof: null }, storageLayout: 'remote', binding,
      settings: { baseUrl: 'https://jira.example.com', project: 'TASK', assigneeAccountId: 'bot' }, allowedRepos: [repo] });
    f.persistence.transaction(() => writeTaskSource(f.store, { ...source.source, conversionReady: true }));
    let issue = jiraIssue(); let writes = 0;
    const http: SourceMutationHttpV1 = {
      async get(input) {
        return { status: 200, body: input.path.endsWith('/transitions') ? { transitions: [{ id: '11', to: { id: '2', name: 'In Progress' } }, { id: '21', to: { id: '3', name: 'In Review' } }] } : issue as PluginJson };
      },
      async send(input) {
        writes++;
        if (input.method === 'PUT') issue = { ...issue, fields: { ...issue.fields, assignee: { accountId: 'bot' } } };
        else {
          const review = JSON.stringify(input.body).includes('21');
          issue = { ...issue, fields: { ...issue.fields, status: { id: review ? '3' : '2', name: review ? 'In Review' : 'In Progress', statusCategory: { key: 'indeterminate' } } } };
        }
        return { status: 204, body: null };
      },
    };
    const effects = createSourceEffectCoordinator({ ...f.options, http: (_operation, _context, _instance, _mutation, check) => ({ get: async input => { check(); return http.get(input); }, send: async input => { check(); return http.send(input); } }) });
    const coordinator = createSourceAdmissionCoordinator({ store: f.store, registry: f.registry, local: openLocalSourceAdapter(f.store), effects,
      context: (instance, repo, signal) => ({ instance, repo, signal, http: { get: input => http.get(input) }, local: null }) });
    const claim = coordinator.reserve({ ref: { sourceId: source.source.id, externalId: '10001' }, repo, instanceId: source.instance.id, expectedSourceRevision: 1, expectedInstanceRevision: 1, admissionId: 'jira-admission', runId: 'jira-run' }, () => {});
    const prepared = await coordinator.prepare({ claimId: claim.id, repo, signal: new AbortController().signal });
    const snapshot = coordinator.stageRemoteClaim(prepared);
    let launches = 0;
    const launch = () => { launches++; };
    expect(() => coordinator.commitRemoteClaim({ claimId: claim.id, taskSnapshotHash: snapshot.hash }, launch)).toThrow('not acknowledged');
    const identity = { claimId: claim.id, purpose: 'claim' as const, requestHash: claim.admissionId };
    const ids = effects.operationIds(identity);
    await dispatchOperation(f.operations, ids[0]!, effects.resolve);
    expect(() => coordinator.commitRemoteClaim({ claimId: claim.id, taskSnapshotHash: snapshot.hash }, launch)).toThrow('not acknowledged');
    await dispatchOperation(f.operations, ids[1]!, effects.resolve);
    coordinator.commitRemoteClaim({ claimId: claim.id, taskSnapshotHash: snapshot.hash }, launch);
    expect(launches).toBe(1); expect(writes).toBe(2);
    const claimed = f.store.claim(claim.id)!;
    f.store.configureInstance({ instanceId: source.instance.id, expectedRevision: 1, desiredEnabled: false });
    const settlement = await coordinator.prepareSettlement({ claimId: claim.id, repo, signal: new AbortController().signal, purpose: 'completion', request: { runId: claim.runId, attempt: 2, task: snapshot.task, claimReceipt: claimed.receipt!, outcome: 'succeeded', publication: { repo, prNumber: 42 } } });
    coordinator.stageRemoteSettlement(settlement);
    const completion = { claimId: claim.id, purpose: 'completion' as const, requestHash: settlement.requestHash };
    for (const id of effects.operationIds(completion)) await dispatchOperation(f.operations, id, effects.resolve);
    coordinator.commitRemoteSettlement(completion, () => {});
    expect(f.store.activeClaim(claim.ref)).toBeNull(); expect(writes).toBe(3); expect(issue.fields.status.name).toBe('In Review');
  });
});
