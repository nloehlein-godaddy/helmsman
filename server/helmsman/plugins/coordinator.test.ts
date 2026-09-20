// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../../src/plugins/usage';
import { openExecutionStore, type ExecutionStore } from '../execution-store';
import { claimApplicationStartup, openPersistence, pendingPersistenceIntents, registerPersistenceWriter, type Persistence } from '../persistence';
import { activateBackendPlugins, type BackendRuntime } from './backend';
import { parsePluginArchive } from './artifacts';
import { pluginCommand } from './cli';
import { openPluginLifecycle, type PluginLifecycle } from './lifecycle';
import { createPluginCoordinator, installPlugin, loadPluginSnapshot, readPluginState, type PluginCoordinator } from './store';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const id = 'example.coordinated';
function archive(version = '1.0.0', pluginId = id) {
  return Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1, manifest: { manifestVersion: 1, id: pluginId, version, sdkVersion: 1, pages: [] },
      node: { minMajor: nodeMajor, maxMajorExclusive: nodeMajor + 1 }, entries: {},
      backend: { entry: 'pricing.js', provides: [{ id: 'helmsman/pricing', version: 1, localId: 'fixed' }], settings: {}, storageVersion: 1 } },
    files: [{ path: 'pricing.js', base64: Buffer.from('export default { activate(ctx) { ctx.registerPricing("fixed", { estimate() { return null; } }); ctx.onDispose(() => { globalThis.__phaseCDisposed = (globalThis.__phaseCDisposed ?? 0) + 1; }); } };').toString('base64') }],
  }));
}
const usage: UsageSnapshot = { version: 1, currency: 'USD', repo: null, window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' }, runs: [], records: [], reported: { observedCostUsd: null, knownCostUsd: null, runsWithKnownCost: 0, runsWithoutUsage: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null } };
let root: string;
let plugins: string;
let persistence: Persistence;
let executions: ExecutionStore;
let lifecycle: PluginLifecycle;
let coordinator: PluginCoordinator;
let runtime: BackendRuntime | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'helmsman-plugin-coordinator-')); plugins = join(root, 'plugins');
  persistence = openPersistence(join(root, 'state.sqlite')); executions = openExecutionStore(persistence); lifecycle = openPluginLifecycle(persistence, executions);
  coordinator = await createPluginCoordinator({ root: plugins, persistence, executions, lifecycle });
  Reflect.deleteProperty(globalThis, '__phaseCDisposed');
});
afterEach(async () => { await runtime?.dispose(); runtime = undefined; coordinator.dispose(); persistence.close(); Reflect.deleteProperty(globalThis, '__phaseCDisposed'); rmSync(root, { recursive: true, force: true }); });

describe('coordinated plugin package lifecycle', () => {
  it('limits concurrent installs under the authoritative lock and acknowledges every successful installation', async () => {
    const results = await Promise.allSettled(Array.from({ length: 33 }, (_, index) => installPlugin(plugins, archive('1.0.0', `example.concurrent${index}`), coordinator)));
    const installed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const failed = results.flatMap(result => result.status === 'rejected' ? [result.reason as Error] : []);
    expect(installed).toHaveLength(32);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain('At most 32');
    expect(coordinator.lifecycle.list()).toHaveLength(32);
    expect(pendingPersistenceIntents(persistence)).toEqual([]);
    expect(readPluginState(plugins).plugins).toEqual([...installed].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await loadPluginSnapshot(plugins, false, coordinator)).errors).toEqual([]);
  });

  it('recovers a crash between catalog and data projections before activating pages or services', async () => {
    const installed = await installPlugin(plugins, archive(), coordinator);
    coordinator.dispose(); let fail = false;
    coordinator = await createPluginCoordinator({ root: plugins, persistence, executions, lifecycle, afterProjection: target => { if (fail && target === 'catalog') throw new Error('crash after catalog commit'); } });
    fail = true;
    await expect(coordinator.change(id, true)).rejects.toThrow('crash after catalog');
    expect(readPluginState(plugins).plugins[0]?.enabled).toBe(true);
    expect(pendingPersistenceIntents(persistence)).toHaveLength(1);
    expect(coordinator.canActivate(id)).toBe(false);
    expect((await loadPluginSnapshot(plugins, false, coordinator)).artifacts.size).toBe(0);
    coordinator.dispose();
    coordinator = await createPluginCoordinator({ root: plugins, persistence, executions, lifecycle });
    expect(pendingPersistenceIntents(persistence)).toEqual([]);
    expect(coordinator.canActivate(id, installed.hash)).toBe(true);
    expect((await loadPluginSnapshot(plugins, false, coordinator)).artifacts.size).toBe(1);
  });

  it('observes another CLI connection disabling a live plugin and stops new calls before cleanup', async () => {
    await installPlugin(plugins, archive(), coordinator); await coordinator.change(id, true);
    runtime = await activateBackendPlugins({ root: plugins, snapshot: await loadPluginSnapshot(plugins, false, coordinator), usage: { query: async () => usage }, coordinator });
    expect(runtime.activePluginIds()).toEqual([id]);
    expect((await runtime.pricing(usage)).estimate).toBeNull();
    const release = registerPersistenceWriter(persistence, 'running-application');
    try { await pluginCommand(['--dir', plugins, '--db', join(root, 'state.sqlite'), 'disable', id], { coordinate: true }); }
    finally { release(); }
    await expect(runtime.pricing(usage, { explicit: `${id}/fixed` })).rejects.toThrow('draining or disabled');
    await coordinator.reconcile();
    expect(runtime.activePluginIds()).toEqual([]);
    expect(Reflect.get(globalThis, '__phaseCDisposed')).toBe(1);
    expect(coordinator.state(id)).toMatchObject({ desiredEnabled: false, health: 'inactive', state: 'disabled' });
  });

  it('preserves draining obligation pins and rejects package replacement, uninstall and collection', async () => {
    const installed = await installPlugin(plugins, archive(), coordinator); await coordinator.change(id, true);
    runtime = await activateBackendPlugins({ root: plugins, snapshot: await loadPluginSnapshot(plugins, false, coordinator), usage: { query: async () => usage }, coordinator });
    persistence.sql.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT,runId TEXT); INSERT INTO operations VALUES('op-1','uncertain','run-1')");
    executions.retainPins([{ kind: 'operation', ownerId: 'op-1', pluginId: id, artifactHash: installed.hash }]);
    await coordinator.change(id, false);
    expect(coordinator.state(id)).toMatchObject({ desiredEnabled: false, state: 'failed', obligationsOnly: true });
    await expect(installPlugin(plugins, archive('2.0.0'), coordinator)).rejects.toThrow('Retained operation');
    await expect(coordinator.uninstall(id)).rejects.toThrow('referenced');
    await expect(coordinator.collect(installed.hash)).rejects.toThrow('Referenced');
    expect(await readFile(join(plugins, 'artifacts', `${installed.hash}.json`))).toBeDefined();
    expect(executions.pins(id)).toHaveLength(1);
  });

  it('uninstalls an idle disabled package, retains namespaces, and reinstalls with a newer projection revision', async () => {
    const installed = await installPlugin(plugins, archive(), coordinator);
    const priorRevision = coordinator.state(id)!.revision;
    await coordinator.uninstall(id);
    expect(readPluginState(plugins).plugins).toEqual([]);
    expect(coordinator.state(id)).toBeNull();
    await installPlugin(plugins, archive(), coordinator);
    expect(coordinator.state(id)!.revision).toBeGreaterThan(priorRevision + 1);
    expect(readPluginState(plugins).plugins).toEqual([installed]);
    await coordinator.uninstall(id);
    await coordinator.collect(installed.hash);
    await expect(readFile(join(plugins, 'artifacts', `${installed.hash}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects first-time coordinator migrations while a concurrent host owns the database writer barrier', async () => {
    const another = openPersistence(join(root, 'old-state.sqlite'));
    const release = registerPersistenceWriter(another, 'old-host');
    try {
      await expect(pluginCommand(['--dir', plugins, '--db', join(root, 'old-state.sqlite'), 'disable', id], { coordinate: true })).rejects.toThrow('active database writer');
    } finally { release(); another.close(); }
  });

  it('rejects CLI changes during another connection startup and permits the same changes after readiness', async () => {
    await installPlugin(plugins, archive(), coordinator); await coordinator.change(id, true);
    const startup = claimApplicationStartup(persistence);
    const args = ['--dir', plugins, '--db', join(root, 'state.sqlite'), 'disable', id];
    try {
      await expect(pluginCommand(args)).rejects.toThrow('application-startup');
      expect(coordinator.state(id)?.desiredEnabled).toBe(true);
      expect(readPluginState(plugins).plugins[0]?.enabled).toBe(true);
      startup.ready();
      await pluginCommand(args);
      expect(coordinator.state(id)?.desiredEnabled).toBe(false);
    } finally { startup.close(); }
  });

  it('refuses to select an artifact collected after publication and before installation commits', async () => {
    const bytes = archive();
    const parsed = parsePluginArchive(bytes);
    await installPlugin(plugins, bytes, coordinator);
    await coordinator.uninstall(id);
    await coordinator.collect(parsed.hash);
    await expect(coordinator.install(parsed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(coordinator.state(id)).toBeNull();
    expect(readPluginState(plugins).plugins).toEqual([]);
  });

  it('coordinates programmatic CLI mutations by default and preserves retained execution obligations', async () => {
    const installed = await installPlugin(plugins, archive(), coordinator);
    persistence.sql.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT,runId TEXT); INSERT INTO operations VALUES('op-1','uncertain','run-1')");
    executions.retainPins([{ kind: 'operation', ownerId: 'op-1', pluginId: id, artifactHash: installed.hash }]);
    const replacement = join(root, 'replacement.json');
    await writeFile(replacement, archive('2.0.0'));
    await expect(pluginCommand(['--dir', plugins, 'install', replacement], { dbPath: join(root, 'state.sqlite') })).rejects.toThrow('Retained operation');
    expect(readPluginState(plugins).plugins[0]?.hash).toBe(installed.hash);
    expect(coordinator.state(id)?.artifactHash).toBe(installed.hash);
  });
});
