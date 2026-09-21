// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todosProvider } from '../../src/plugins/todos/provider';
import type { TaskSourceProviderV1 } from '../../src/plugins/tasks';
import { openPersistence, type Persistence } from './persistence';
import { createTaskSourceRegistry } from './task-sources/registry';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceService } from './task-source-service';

let root: string;
let persistence: Persistence;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'helmsman-source-service-')); persistence = openPersistence(join(root, 'main.sqlite')); });
afterEach(() => { persistence.close(); rmSync(root, { recursive: true, force: true }); });
function setup(provider: TaskSourceProviderV1 = todosProvider, readViews?: readonly ('underway' | 'history')[]) {
  const store = openTaskSourceStore(persistence);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const binding = { providerId: 'example.todos/todos', pluginId: 'example.todos', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'], ...(readViews ? { readViews } : {}) }, provider)]);
  const { source, instance } = store.provision({ provisioningKey: 'local', label: 'Tasks', identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'local', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: '2026-09-20T00:00:00Z', proof: {} }, storageLayout: 'documents', binding, settings: {}, allowedRepos: ['owner/project'] });
  persistence.transaction(() => writeTaskSource(store, { ...source, conversionReady: true }));
  const service = createTaskSourceService({ store, registry, local: openLocalSourceAdapter(store), http: () => { throw new Error('Undeclared HTTP'); } });
  const scope = { instanceId: instance.id, instanceRevision: instance.revision, repo: 'owner/project' };
  return { store, registry, source, instance, service, scope, signal: new AbortController().signal };
}

describe('core task source services', () => {
  it('requires explicit Underway declaration instead of falling back to the default list', async () => {
    const f = setup();
    await expect(f.service.listUnderway({ ...f.scope, cursor: null, limit: 10 }, f.signal)).rejects.toThrow('does not provide');
    expect(f.service.instances(f.scope.repo)[0]?.readViews).toEqual([]);
  });
  it('dispatches declared Underway views and fences results after source disablement', async () => {
    let disable: (() => void) | undefined;
    const view = vi.fn<NonNullable<TaskSourceProviderV1['listUnderway']>>(async () => { disable?.(); return { items: [], nextCursor: null }; });
    const f = setup({ ...todosProvider, listUnderway: view }, ['underway']);
    expect(f.service.instances(f.scope.repo)[0]?.readViews).toEqual(['underway']);
    expect(await f.service.listUnderway({ ...f.scope, cursor: null, limit: 10 }, f.signal)).toEqual({ items: [], nextCursor: null });
    expect(view).toHaveBeenCalledWith({ repo: f.scope.repo, cursor: null, limit: 10 }, expect.objectContaining({ repo: f.scope.repo }));
    disable = () => { f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false }); };
    await expect(f.service.listUnderway({ ...f.scope, cursor: null, limit: 10 }, f.signal)).rejects.toThrow('selection changed');
  });
  it('runs the public Todo provider through host records, commands and source-scoped discovery', async () => {
    const { service, scope, signal, instance } = setup();
    const created = await service.command({ ...scope, commandId: 'create', requestId: 'create-1', input: { title: 'Task', repo: scope.repo, description: 'Requirements' } }, signal);
    expect(created?.ref.sourceId).toBe(instance.sourceId);
    expect(created?.ref.externalId).toBe('TODO-1');
    expect((await service.list({ ...scope, state: 'ready', cursor: null, limit: 10 }, signal)).items.map(item => item.ref)).toEqual([created?.ref]);
    expect(await service.lookup({ ...scope, displayKey: 'TODO-1' }, signal)).toEqual(created?.ref);
    expect((await service.load({ ...scope, ref: created!.ref }, signal))?.requirements.description).toBe('Requirements');
    expect(service.instances(scope.repo)).toEqual([expect.objectContaining({ sourceId: instance.sourceId, available: true, commands: ['create', 'update', 'delete'] })]);
    expect(JSON.stringify(service.instances(scope.repo))).not.toContain('credentialHandle');
  });

  it('rejects source/galleon mismatches and read results after disablement', async () => {
    let disable: (() => void) | undefined;
    const original = todosProvider.list;
    const { service, scope, signal, store, instance } = setup({ ...todosProvider, list: async (input, context) => { const result = await original(input, context); disable?.(); return result; } });
    await expect(service.list({ ...scope, repo: 'other/project', state: null, cursor: null, limit: 10 }, signal)).rejects.toThrow('authorized');
    await expect(service.load({ ...scope, ref: { sourceId: '22222222-2222-4222-8222-222222222222', externalId: 'TODO-1' } }, signal)).rejects.toThrow('another source');
    disable = () => { store.configureInstance({ instanceId: instance.id, expectedRevision: 1, desiredEnabled: false }); };
    await expect(service.list({ ...scope, state: null, cursor: null, limit: 10 }, signal)).rejects.toThrow('selection changed');
    expect(service.instances(scope.repo)[0]?.available).toBe(false);
  });

  it('rejects malformed provider responses without committing aliases', async () => {
    const { service, scope, signal, store, source } = setup({ ...todosProvider, list: async () => ({ items: [null], nextCursor: null }) as never });
    await expect(service.list({ ...scope, state: null, cursor: null, limit: 10 }, signal)).rejects.toThrow();
    expect(store.alias(source.id, 'TODO-1')).toBeNull();
  });

  it('replays command receipts before preparing an update or deletion against changed records', async () => {
    const { service, scope, signal } = setup();
    const create = { ...scope, commandId: 'create', requestId: 'create', input: { title: 'Task', repo: scope.repo, description: 'Requirements' } };
    const record = await service.command(create, signal);
    expect(await service.command(create, signal)).toEqual(record);
    const update = { ...scope, commandId: 'update', requestId: 'update', input: { ref: { ...record!.ref }, expectedRevision: record!.revision, patch: { title: 'Updated' } } };
    const updated = await service.command(update, signal);
    expect(await service.command(update, signal)).toEqual(updated);
    const remove = { ...scope, commandId: 'delete', requestId: 'delete', input: { ref: { ...updated!.ref }, expectedRevision: updated!.revision } };
    expect(await service.command(remove, signal)).toBeNull();
    expect(await service.command(remove, signal)).toBeNull();
    await expect(service.command({ ...create, input: { ...create.input, title: 'Different' } }, signal)).rejects.toThrow('identity changed');
  });
});

it('validates launch scope and quarantine synchronously without provider calls before reservation', () => {
  const load = vi.fn(async () => null); const f = setup({ ...todosProvider, load });
  const input = { ...f.scope, ref: { sourceId: f.source.id, externalId: 'not-yet-loaded' } };
  expect(f.service.assertLaunch(input)).toBeUndefined(); expect(load).not.toHaveBeenCalled();
  expect(() => f.service.assertLaunch({ ...input, instanceRevision: 2 })).toThrow('revision');
  expect(() => f.service.assertLaunch({ ...input, repo: 'other/project' })).toThrow('authorized');
  expect(() => f.service.assertLaunch({ ...input, ref: { ...input.ref, sourceId: '22222222-2222-4222-8222-222222222222' } })).toThrow('another source');
  f.store.quarantine({ sourceId: f.source.id, externalId: input.ref.externalId, displayKey: null, reason: 'Historical ownership', evidence: null });
  expect(() => f.service.assertLaunch(input)).toThrow('quarantined'); expect(load).not.toHaveBeenCalled();
});


it('requires declared source history and fences immutable results after source revision changes', async () => {
  const query = { from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z', eventLimit: 50 };
  const legacy = setup(); await expect(legacy.service.readHistory({ ...legacy.scope, ...query }, legacy.signal)).rejects.toThrow('does not provide');
  let disable: (() => void) | undefined;
  const provider = { ...todosProvider, readHistory: async (input: Parameters<NonNullable<TaskSourceProviderV1['readHistory']>>[0], context: Parameters<NonNullable<TaskSourceProviderV1['readHistory']>>[1]) => {
    const result = await todosProvider.readHistory!(input, context); disable?.(); return result;
  } };
  const f = setup(provider, ['history']);
  expect((await f.service.readHistory({ ...f.scope, ...query }, f.signal)).throughputQuality).toBe('complete');
  disable = () => { f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, desiredEnabled: false }); };
  await expect(f.service.readHistory({ ...f.scope, ...query }, f.signal)).rejects.toThrow('selection changed');
});
