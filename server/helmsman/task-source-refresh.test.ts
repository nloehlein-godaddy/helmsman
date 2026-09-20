// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPersistence, type Persistence } from './persistence';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { createTaskSourceRegistry } from './task-sources/registry';
import { provider } from './task-sources/fixtures.test-support';
import { openSourceConnectionStore } from './task-source-connections';
import { createTaskSourceRefreshService } from './task-source-refresh';
import type { SourceInstanceV1, TaskSnapshotV1 } from '../../src/plugins/tasks';
const opened: Persistence[] = [];
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const store = openTaskSourceStore(persistence); const connections = openSourceConnectionStore(persistence);
  const connection = connections.pin({ provisioningKey: 'jira', kind: 'jira', credentialHandle: 'jira-config', origin: 'https://example.atlassian.net', email: 'operator@example.com', subject: 'account-1', authorityId: null, verifiedAt: '2026-09-20T00:00:00.000Z' });
  const oldBinding = { pluginId: 'helmsman.jira', providerId: 'helmsman.jira/issues', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: connection.id, credentialHandle: connection.credentialHandle };
  const provisioned = store.provision({ provisioningKey: 'jira', label: 'Jira', identityEvidence: { version: 1, level: 'operator-seeded', authority: null, verifiedAt: connection.verifiedAt, proof: { connectionId: connection.id } }, storageLayout: 'remote', binding: oldBinding, allowedRepos: ['owner/project'], settings: { project: 'PROJ' } });
  writeTaskSource(store, { ...provisioned.source, conversionReady: true });
  const source = store.source(provisioned.source.id)!; const instance = provisioned.instance;
  const task: TaskSnapshotV1 = { version: 1, ref: { sourceId: source.id, externalId: '10001' }, revision: 'rev-2', displayKey: 'PROJ-1', title: 'Task', repo: 'owner/project', url: null, state: 'ready', priority: 2, requirements: { description: 'Implement', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } };
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const declaration = { identityFormats: ['jira.issue-id/v1'], effectIds: [], commandIds: [], access: ['connection-http' as const] };
  const replacement = { ...oldBinding, connectionId: null, credentialHandle: null, artifactHash: 'b'.repeat(64) };
  const identify = vi.fn(async () => source.identityEvidence); const load = vi.fn(async () => task); const list = vi.fn(async (): Promise<{ items: TaskSnapshotV1[]; nextCursor: string | null }> => ({ items: [task], nextCursor: null }));
  registry.publish([registry.stage(replacement, declaration, { ...provider, identify, load, list })]);
  const get = vi.fn(async (_request: { path: string; query: Readonly<Record<string, string>> }) => ({ status: 200, body: { accountId: connection.subject } }));
  const identityFormat = vi.fn(() => 'jira.issue-id/v1'); const getConnection = vi.fn((_instance: SourceInstanceV1) => connection);
  const reopen = () => createTaskSourceRefreshService({ store, registry, connection: getConnection, identityFormat, http: (_instance, _repo, _signal, _purpose, authorize) => ({ get: async request => { authorize(); return get(request); } }) });
  const refresh = reopen();
  store.recordAlias({ sourceId: source.id, displayKey: task.displayKey, externalId: task.ref.externalId, evidence: { repo: task.repo, revision: task.revision } });
  return { persistence, store, source, instance, connection, registry, declaration, replacement, identify, load, list, get, identityFormat, getConnection, refresh, reopen, task,
    input: { sourceId: source.id, sourceRevision: source.revision, providerId: oldBinding.providerId, artifactHash: replacement.artifactHash, repo: task.repo, actor: 'operator', reason: 'Upgrade installed Jira artifact' }, signal: new AbortController().signal };
}
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
describe('operator-seeded Jira artifact refresh', () => {
  it('switches only future work and preserves seeded namespace, connection, settings and old claims', async () => {
    const f = setup();
    const claim = f.store.reserveWork({ ref: f.task.ref, admissionId: 'old-admission', runId: 'old-run', instanceId: f.instance.id, expectedSourceRevision: 1, expectedInstanceRevision: 1 });
    const validation = await f.refresh.validate(f.input, f.signal);
    expect(f.get).toHaveBeenCalledWith({ path: '/rest/api/3/myself', query: {} });
    expect(f.load).toHaveBeenCalledWith(f.task.ref, expect.objectContaining({ local: null }));
    expect(f.store.instance(validation.instanceId)).toBeNull(); expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
    expect(f.refresh.commit(validation.validationId)).toMatchObject({ currentInstanceId: validation.instanceId, revision: 2 });
    expect(f.store.instance(validation.instanceId)).toEqual({ ...f.instance, id: validation.instanceId, binding: { ...f.instance.binding, artifactHash: f.replacement.artifactHash } });
    expect(f.store.claim(claim.id)).toEqual(claim); expect(f.store.instance(f.instance.id)).toEqual(f.instance);
    expect(f.store.source(f.source.id)?.identityEvidence).toEqual(f.source.identityEvidence);
    expect(f.refresh.commit(validation.validationId).revision).toBe(2);
    expect(f.persistence.sql.prepare('SELECT * FROM source_refreshes').all()).toHaveLength(1);
  });
  it('requires original format evidence, exact provider identity and host verified subject', async () => {
    const f = setup();
    f.identityFormat.mockReturnValueOnce('new-format'); expect(() => f.refresh.candidates(f.source.id)).toThrow('verification');
    await expect(f.refresh.validate({ ...f.input, providerId: 'example.jira/issues' }, f.signal)).rejects.toThrow('selection');
    f.get.mockResolvedValueOnce({ status: 200, body: { accountId: 'different-account' } });
    await expect(f.refresh.validate(f.input, f.signal)).rejects.toThrow('subject'); expect(f.load).not.toHaveBeenCalled();
    expect(f.store.instances(f.source.id)).toHaveLength(1);
  });
  it('blocks mismatched canonical probes and missing host-recorded probe scope', async () => {
    const f = setup(); f.load.mockResolvedValueOnce({ ...f.task, ref: { ...f.task.ref, externalId: '20002' } });
    await expect(f.refresh.validate(f.input, f.signal)).rejects.toThrow('canonical');
    f.store.recordAlias({ sourceId: f.source.id, displayKey: 'PROJ-2', externalId: '20002', evidence: null });
    await expect(f.refresh.validate(f.input, f.signal)).rejects.toThrow('scope');
    expect(f.list).not.toHaveBeenCalled();
  });
  it('keeps provider identity observations separate from authority promotion and preserves disablement', async () => {
    const f = setup(); f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false });
    f.identify.mockResolvedValueOnce({ ...f.source.identityEvidence, level: 'verified', authority: { protocol: 'jira.cloud', authorityId: 'new-cloud', identityFormat: 'jira.issue-id/v1' } });
    const validation = await f.refresh.validate(f.input, f.signal); f.refresh.commit(validation.validationId);
    expect(f.store.instance(validation.instanceId)).toMatchObject({ identityLevel: 'operator-seeded', authority: null, desiredEnabled: false });
    expect(f.store.source(f.source.id)?.identityEvidence.authority).toBeNull();
  });
  it('rejects source/configuration/connection races and unloaded candidates at commit', async () => {
    const f = setup(); const validation = await f.refresh.validate(f.input, f.signal);
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, label: 'Renamed' });
    expect(() => f.refresh.commit(validation.validationId)).toThrow('stale');
    const fresh = await f.refresh.validate(f.input, f.signal); f.registry.removePlugin(f.instance.binding.pluginId);
    expect(() => f.refresh.commit(fresh.validationId)).toThrow('unavailable');
    expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
  });
  it('validates empty source history against a fresh provider page and probes discovered canonical IDs', async () => {
    const f = setup(); f.persistence.sql.prepare('DELETE FROM source_aliases').run();
    const validation = await f.refresh.validate(f.input, f.signal);
    expect(f.list).toHaveBeenCalled(); expect(f.load).toHaveBeenCalled(); f.refresh.commit(validation.validationId);
  });
  it('accepts a proven empty collection but rejects incomplete empty page evidence', async () => {
    const f = setup(); f.persistence.sql.prepare('DELETE FROM source_aliases').run();
    f.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    const validation = await f.refresh.validate(f.input, f.signal); expect(f.load).not.toHaveBeenCalled(); f.refresh.commit(validation.validationId);
    const other = setup(); other.persistence.sql.prepare('DELETE FROM source_aliases').run();
    other.list.mockResolvedValueOnce({ items: [], nextCursor: 'next' });
    await expect(other.refresh.validate(other.input, other.signal)).rejects.toThrow('incomplete');
  });
  it('revalidates durable validation after service restart and rejects pinned connection drift', async () => {
    const f = setup(); const validation = await f.refresh.validate(f.input, f.signal);
    const reopened = f.reopen();
    f.getConnection.mockReturnValueOnce({ ...f.connection, subject: 'changed-subject' });
    expect(() => reopened.commit(validation.validationId)).toThrow('stale');
    expect(reopened.commit(validation.validationId).currentInstanceId).toBe(validation.instanceId);
  });
  it('rechecks cancellation and source configuration after asynchronous probe reads', async () => {
    const f = setup();
    f.load.mockImplementationOnce(async () => { f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, allowedRepos: [] }); return f.task; });
    await expect(f.refresh.validate(f.input, f.signal)).rejects.toThrow('stale');
    expect(f.persistence.sql.prepare('SELECT * FROM source_refresh_validations').all()).toHaveLength(0);
    const other = setup(); const controller = new AbortController();
    other.load.mockImplementationOnce(async () => { controller.abort(); return other.task; });
    await expect(other.refresh.validate(other.input, controller.signal)).rejects.toThrow();
    expect(other.persistence.sql.prepare('SELECT * FROM source_refresh_validations').all()).toHaveLength(0);
  });
  it('never treats inaccessible host-recorded work as proof of an empty source', async () => {
    const f = setup(); f.store.recordAlias({ sourceId: f.source.id, displayKey: 'OTHER-2', externalId: '20002', evidence: { repo: 'other/project' } });
    await expect(f.refresh.validate(f.input, f.signal)).rejects.toThrow('unauthorized');
    expect(f.list).not.toHaveBeenCalled(); expect(f.store.instances(f.source.id)).toHaveLength(1);
  });
  it('rejects fabricated and tampered validation receipts without switching source', async () => {
    const f = setup(); expect(() => f.refresh.commit('fabricated')).toThrow('Registered');
    const validation = await f.refresh.validate(f.input, f.signal);
    f.persistence.sql.prepare('UPDATE source_refresh_validations SET evidenceHash=? WHERE id=?').run('0'.repeat(64), validation.validationId);
    expect(() => f.refresh.commit(validation.validationId)).toThrow('integrity'); expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
  });
});
