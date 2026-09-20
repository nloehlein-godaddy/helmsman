// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alternativeSource } from '../../src/plugins/local-tasks-alternative/source';
import { todosProvider } from '../../src/plugins/todos/provider';
import { fixture, binding, provider } from './task-sources/fixtures.test-support';
import { createTaskSourceRegistry } from './task-sources/registry';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceService } from './task-source-service';
import type { Persistence } from './persistence';
import { writeTaskSource } from './task-sources/store';
import type { TaskSnapshotV1 } from '../../src/plugins/tasks';
const opened: Persistence[] = [];
function setup() {
  const f = fixture(); opened.push(f.persistence);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const declaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records' as const] };
  const replacement = { ...binding, pluginId: 'example.alternative', providerId: 'example.alternative/collection', artifactHash: 'b'.repeat(64) };
  registry.publish([registry.stage(binding, declaration, todosProvider), registry.stage(replacement, declaration, alternativeSource)]);
  const service = createTaskSourceService({ store: f.store, registry, local: openLocalSourceAdapter(f.store), http: () => { throw new Error('HTTP not declared'); } });
  return { ...f, registry, service, replacement, signal: new AbortController().signal,
    input: { sourceId: f.source.id, sourceRevision: 1, providerId: replacement.providerId, artifactHash: replacement.artifactHash, repo: 'owner/project', actor: 'operator', reason: 'Replace local provider' } };
}
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
function remoteSetup() {
  const f = setup();
  const original = { ...binding, pluginId: 'example.remote', providerId: 'example.remote/issues' };
  const replacement = { ...original, pluginId: 'example.replacement', providerId: 'example.replacement/issues', artifactHash: 'b'.repeat(64) };
  const identityEvidence = { version: 1 as const, level: 'verified' as const, authority: { protocol: 'jira.cloud', authorityId: 'cloud-123', identityFormat: 'jira.issue-id/v1' }, verifiedAt: '2026-09-20T00:00:00.000Z', proof: null };
  const provisioned = f.store.provision({ provisioningKey: 'remote', label: 'Remote', identityEvidence, storageLayout: 'remote', binding: original, allowedRepos: ['owner/project'], settings: {} });
  writeTaskSource(f.store, { ...provisioned.source, conversionReady: true });
  const task: TaskSnapshotV1 = { version: 1, ref: { sourceId: provisioned.source.id, externalId: '10001' }, repo: 'owner/project', displayKey: 'TASK-1', title: 'Task', state: 'ready', priority: 1, url: null, revision: 'original-revision', requirements: { description: '', acceptanceCriteria: [], links: [] }, providerData: null };
  const declaration = { identityFormats: ['jira.issue-id/v1'], effectIds: [], commandIds: [], access: ['connection-http' as const] };
  const originalLoad = vi.fn(async () => task);
  const candidateLoad = vi.fn(async () => task);
  const validateAdoption = vi.fn(async (input: Parameters<typeof provider.validateAdoption>[0]) => ({ compatible: true, authority: identityEvidence, identityFormat: 'jira.issue-id/v1', readableSchemas: [], probeResults: input.probes.map(probe => ({ ref: probe.ref, matches: true, evidence: null })), diagnostic: null }));
  f.registry.publish([f.registry.stage(original, declaration, { ...provider, load: originalLoad }), f.registry.stage(replacement, declaration, { ...provider, load: candidateLoad, validateAdoption })]);
  const service = createTaskSourceService({ store: f.store, registry: f.registry, local: openLocalSourceAdapter(f.store), http: () => ({ get: async () => ({ status: 200, body: null }) }) });
  f.store.recordAlias({ ...task.ref, displayKey: task.displayKey, evidence: { repo: task.repo, revision: task.revision } });
  return { ...f, service, source: provisioned.source, instance: provisioned.instance, task, original, replacement, originalLoad, candidateLoad, validateAdoption,
    input: { ...f.input, sourceId: provisioned.source.id, providerId: replacement.providerId, artifactHash: replacement.artifactHash } };
}
describe('operator task source adoption', () => {
  it('rejects a remote candidate that certifies its own incompatible revision', async () => {
    const f = remoteSetup();
    f.candidateLoad.mockResolvedValue({ ...f.task, revision: 'candidate-format' });
    await expect(f.service.adoption.validate(f.input, f.signal)).rejects.toThrow('original observation');
    expect(f.validateAdoption).not.toHaveBeenCalled();
    expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
  });
  it('uses the live original provider as the baseline even when its instance is disabled', async () => {
    const f = remoteSetup();
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false });
    f.originalLoad.mockResolvedValue({ ...f.task, revision: 'current-revision' });
    f.candidateLoad.mockResolvedValue({ ...f.task, revision: 'current-revision' });
    const validation = await f.service.adoption.validate(f.input, f.signal);
    expect(f.originalLoad).toHaveBeenCalled();
    expect(f.validateAdoption).toHaveBeenCalledWith(expect.objectContaining({ probes: [{ ref: f.task.ref, revision: 'current-revision' }] }), expect.anything());
    f.service.adoption.commit(validation.validationId);
    expect(f.store.instance(validation.instanceId)?.desiredEnabled).toBe(false);
  });
  it('falls back to host-recorded revision evidence when the original artifact is unavailable', async () => {
    const f = remoteSetup(); f.registry.removePlugin(f.original.pluginId);
    f.candidateLoad.mockResolvedValueOnce({ ...f.task, revision: 'candidate-format' });
    await expect(f.service.adoption.validate(f.input, f.signal)).rejects.toThrow('original observation');
    const validation = await f.service.adoption.validate(f.input, f.signal);
    expect(f.originalLoad).not.toHaveBeenCalled();
    expect(f.service.adoption.commit(validation.validationId).currentInstanceId).toBe(validation.instanceId);
  });
  it('uses retained task snapshots when alias observations lack revision evidence', async () => {
    const f = remoteSetup(); f.registry.removePlugin(f.original.pluginId);
    f.store.recordAlias({ ...f.task.ref, displayKey: f.task.displayKey, evidence: { repo: f.task.repo } });
    await expect(f.service.adoption.validate(f.input, f.signal)).rejects.toThrow('recorded revision');
    f.store.retainTaskSnapshot(f.task, f.instance);
    const validation = await f.service.adoption.validate(f.input, f.signal);
    expect(f.service.adoption.commit(validation.validationId).currentInstanceId).toBe(validation.instanceId);
  });
  it('selects a registered candidate, validates host-selected records, and adopts only on explicit commit', async () => {
    const f = setup();
    const record = await f.service.command({ instanceId: f.instance.id, instanceRevision: 1, repo: 'owner/project', commandId: 'create', requestId: 'task', input: { title: 'Task', description: 'Implement it', repo: 'owner/project' } }, f.signal);
    expect(f.service.adoption.candidates(f.source.id).candidates).toEqual([{ providerId: f.replacement.providerId, artifactHash: f.replacement.artifactHash }]);
    const validation = await f.service.adoption.validate(f.input, f.signal);
    expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
    await expect(f.service.load({ instanceId: validation.instanceId, instanceRevision: 1, repo: 'owner/project', ref: record!.ref }, f.signal)).rejects.toThrow('selection');
    expect(f.service.adoption.commit(validation.validationId).currentInstanceId).toBe(validation.instanceId);
    expect((await f.service.load({ instanceId: validation.instanceId, instanceRevision: 1, repo: 'owner/project', ref: record!.ref }, f.signal))?.title).toBe('Task');
    expect(f.service.adoption.commit(validation.validationId).revision).toBe(2);
  });
  it('invalidates registered validation if the previous source configuration changes', async () => {
    const f = setup();
    const validation = await f.service.adoption.validate(f.input, f.signal);
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, allowedRepos: [] });
    expect(() => f.service.adoption.commit(validation.validationId)).toThrow('stale');
    expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
  });
  it('rejects unregistered candidates and unauthorized probe scope', async () => {
    const f = setup();
    await expect(f.service.adoption.validate({ ...f.input, artifactHash: 'c'.repeat(64) }, f.signal)).rejects.toThrow('unavailable');
    await expect(f.service.adoption.validate({ ...f.input, repo: 'other/project' }, f.signal)).rejects.toThrow('selection');
    expect(() => f.service.adoption.commit('fabricated')).toThrow('Registered');
  });
  it('preserves desired disablement when adopting another provider', async () => {
    const f = setup();
    f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false });
    const validation = await f.service.adoption.validate(f.input, f.signal);
    f.service.adoption.commit(validation.validationId);
    expect(f.store.instance(validation.instanceId)).toMatchObject({ desiredEnabled: false, revision: 2 });
    expect(f.service.instances('owner/project').every(instance => !instance.available)).toBe(true);
  });
});
