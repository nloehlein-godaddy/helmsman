// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceInstanceV1 } from '../../../src/plugins/tasks';
import type { PluginBackendContext } from '../../../src/plugins/backend';
import { openPersistence, type Persistence } from '../persistence';
import { openExecutionStore, type ExecutionStore } from '../execution-store';
import { activateBackendPlugins, type BackendRuntime } from './backend';
import { createPluginCoordinator, installPlugin, loadPluginSnapshot, type PluginCoordinator } from './store';
import { openPluginLifecycle } from './lifecycle';
import { parsePluginArchive } from './artifacts';
import { openPluginData } from './data';

const id = 'example.tasks';
const methods = 'identify list lookup load planClaim planCompletion planAbort validateAdoption'.split(' ').map(name => `${name}: async () => null`).join(',');
function archive(tail = '', missing = false) {
  return Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: { entry: 'source.js', provides: [{ id: 'helmsman/task-source', version: 1, localId: 'tasks' }],
        taskSources: { tasks: { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: ['local-records'] } }, settings: {}, storageVersion: 1 } },
    files: [{ path: 'source.js', base64: Buffer.from(`export default { activate(ctx) {
      globalThis.__sourceSignal = ctx.signal;
      ctx.onDispose(() => { globalThis.__sourceDisposed = true; });
      ${missing ? '' : `ctx.registerTaskSource('tasks', { ${methods}, effects: {} });`}
      ${tail}
    } };`).toString('base64') }] }));
}
let root: string;
let persistence: Persistence;
let executions: ExecutionStore;
let coordinator: PluginCoordinator;
let runtime: BackendRuntime | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'helmsman-source-backend-'));
  persistence = openPersistence(join(root, 'main.sqlite'));
  executions = openExecutionStore(persistence);
  coordinator = await createPluginCoordinator({ root: join(root, 'plugins'), persistence, executions, lifecycle: openPluginLifecycle(persistence, executions) });
});
afterEach(async () => {
  await runtime?.dispose(); runtime = undefined; coordinator?.dispose(); persistence?.close(); if (root) rmSync(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, '__sourceSignal'); Reflect.deleteProperty(globalThis, '__sourceDisposed');
  Reflect.deleteProperty(globalThis, '__sourcePause'); Reflect.deleteProperty(globalThis, '__sourceProbe');
});
async function start(bytes = archive()) {
  const installed = await installPlugin(join(root, 'plugins'), bytes, coordinator);
  await coordinator.change(id, true);
  runtime = await activateBackendPlugins({ root: join(root, 'plugins'), snapshot: await loadPluginSnapshot(join(root, 'plugins'), false, coordinator),
    coordinator, usage: { query: async () => { throw new Error('Unused'); } } });
  return installed;
}
function instance(hash: string): SourceInstanceV1 {
  return { version: 1, id: '11111111-1111-4111-8111-111111111111', sourceId: '22222222-2222-4222-8222-222222222222', label: 'Tasks', revision: 1,
    desiredEnabled: true, identityLevel: 'verified', authority: { protocol: 'local', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' },
    binding: { pluginId: id, providerId: `${id}/tasks`, artifactHash: hash, contractVersion: 1, connectionId: null, credentialHandle: null }, settings: {}, allowedRepos: ['owner/project'] };
}

describe('task source backend activation', () => {
  it.each([['throw new Error("activation failed")', false], ['', true]])('does not publish failed or incomplete registrations', async (tail, missing) => {
    await start(archive(tail as string, missing as boolean));
    expect(runtime?.errors).toHaveLength(1);
    expect(runtime?.taskSources.list()).toEqual([]);
    expect(runtime?.activePluginIds()).toEqual([]);
  });

  it('rejects registering a pricing provider against a task source declaration', async () => {
    await start(archive("ctx.registerPricing('tasks', { estimate: () => null });", true));
    expect(runtime?.errors[0]).toContain('pricing');
    expect(runtime?.taskSources.list()).toEqual([]);
  });

  it('rolls back staged state when disabled during asynchronous activation', async () => {
    let paused!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { paused = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    Reflect.set(globalThis, '__sourcePause', async (context: PluginBackendContext) => {
      await context.storage.set('staged', 1);
      paused();
      await release;
    });
    const bytes = archive('return globalThis.__sourcePause(ctx);');
    const starting = start(bytes);
    await waiting;
    await coordinator.change(id, false);
    resume();
    await starting;
    expect(runtime?.errors[0]).toContain('disabled during activation');
    expect(runtime?.taskSources.list()).toEqual([]);
    const data = openPluginData(join(root, 'plugins'), parsePluginArchive(bytes).package);
    try { expect(data.read('staged')).toBeUndefined(); } finally { data.close(); }
  });

  it('denies ordinary services during obligation-only activation after restart', async () => {
    let probe: PromiseSettledResult<unknown>[] = [];
    Reflect.set(globalThis, '__sourceProbe', async (context: PluginBackendContext) => {
      probe = await Promise.allSettled([context.storage.set('unexpected', true), context.storage.get('cached'), context.usage.query({ version: 1, repo: null, from: '2026-01-01', to: '2026-02-01' })]);
    });
    const bytes = archive('if (ctx.signal.aborted) return globalThis.__sourceProbe(ctx);');
    const installed = await start(bytes);
    persistence.sql.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT,runId TEXT); INSERT INTO operations VALUES('op','uncertain','run')");
    executions.retainPins([{ kind: 'operation', ownerId: 'op', pluginId: id, artifactHash: installed.hash }]);
    await coordinator.change(id, false);
    await runtime?.dispose();
    runtime = await activateBackendPlugins({ root: join(root, 'plugins'), snapshot: await loadPluginSnapshot(join(root, 'plugins'), false, coordinator), coordinator,
      usage: { query: async () => { throw new Error('Usage must not be called'); } } });
    expect(runtime.errors).toEqual([]);
    expect(probe).toHaveLength(3);
    for (const result of probe) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(String(result.reason)).toContain('draining');
    }
    expect(runtime.taskSources.resolve(instance(installed.hash), 'obligation').binding.artifactHash).toBe(installed.hash);
  });

  it('rejects a duplicate activation without deleting the first published source', async () => {
    const installed = await installPlugin(join(root, 'plugins'), archive(), coordinator);
    await coordinator.change(id, true);
    const snapshot = await loadPluginSnapshot(join(root, 'plugins'), false, coordinator);
    const retained = snapshot.artifacts.values().next().value!;
    const duplicated = { ...snapshot, artifacts: new Map([...snapshot.artifacts, ['duplicate', retained]]) };
    runtime = await activateBackendPlugins({ root: join(root, 'plugins'), snapshot: duplicated, coordinator,
      usage: { query: async () => { throw new Error('Unused'); } } });
    expect(runtime.errors).toEqual([expect.stringContaining('Duplicate backend plugin identity')]);
    expect(runtime.taskSources.resolve(instance(installed.hash), 'admission').binding.artifactHash).toBe(installed.hash);
    expect(runtime.taskSources.list()).toHaveLength(1);
    expect(runtime.activePluginIds()).toEqual([id]);
  });

  it('drains only pinned source obligations while ordinary services stop, including after restart', async () => {
    const installed = await start();
    const selected = instance(installed.hash);
    expect(runtime?.errors).toEqual([]);
    expect(runtime?.taskSources.resolve(selected, 'admission').binding.artifactHash).toBe(installed.hash);
    persistence.sql.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT,runId TEXT); INSERT INTO operations VALUES('op','uncertain','run')");
    executions.retainPins([{ kind: 'operation', ownerId: 'op', pluginId: id, artifactHash: installed.hash }]);
    await coordinator.change(id, false);
    expect((Reflect.get(globalThis, '__sourceSignal') as AbortSignal).aborted).toBe(true);
    expect(Reflect.get(globalThis, '__sourceDisposed')).toBeUndefined();
    expect(() => runtime?.taskSources.resolve(selected, 'admission')).toThrow();
    expect(runtime?.taskSources.resolve(selected, 'obligation').binding.artifactHash).toBe(installed.hash);
    expect(runtime?.taskSources.list()).toEqual([]);
    await runtime?.dispose();
    runtime = await activateBackendPlugins({ root: join(root, 'plugins'), snapshot: await loadPluginSnapshot(join(root, 'plugins'), false, coordinator), coordinator,
      usage: { query: async () => { throw new Error('Unused'); } } });
    expect(runtime.errors).toEqual([]);
    expect(() => runtime?.taskSources.resolve(selected, 'admission')).toThrow();
    expect(runtime.taskSources.resolve(selected, 'obligation').binding.artifactHash).toBe(installed.hash);
    persistence.sql.prepare("UPDATE operations SET status='completed' WHERE id='op'").run();
    executions.releasePins('operation', 'op');
    await coordinator.reconcile();
    expect(() => runtime?.taskSources.resolve(selected, 'obligation')).toThrow();
    expect(runtime.activePluginIds()).toEqual([]);
  });
});
