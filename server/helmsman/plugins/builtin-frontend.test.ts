// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COSTS_PAGE_ID, COSTS_PAGE_SLOT, HELM_PAGE_ID, HELM_PAGE_SLOT } from '../../../src/plugins/frontend-manifests';
import { parsePluginPackage } from '../../../src/plugins/package';
import { openPersistence, type Persistence } from '../persistence';
import { openExecutionStore } from '../execution-store';
import { openPluginLifecycle } from './lifecycle';
import { builtinFrontendArtifacts, builtinFrontendPackages } from './builtin-frontend';
import { builtinPluginPackage, readBuiltinPluginStates } from './data';
import { activateBackendPlugins, type BackendRuntime } from './backend';
import { builtinPricing } from './builtin-pricing';
import { createPluginCoordinator, installPlugin, loadPluginSnapshot, readPluginState, selectPluginPage, setPluginEnabled, type PluginCoordinator } from './store';
import { retainActivatedPluginPages } from './activation';
let root: string; let persistence: Persistence | undefined; let coordinator: PluginCoordinator | undefined; let backend: BackendRuntime | undefined;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'builtin-frontend-')); });
afterEach(async () => { await backend?.dispose(); backend = undefined; coordinator?.dispose(); coordinator = undefined; persistence?.close(); persistence = undefined; rmSync(root, { recursive: true, force: true }); });
const runtimeArtifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
function options() {
  persistence ??= openPersistence(join(root, 'main.sqlite'));
  const executions = openExecutionStore(persistence); const lifecycle = openPluginLifecycle(persistence, executions);
  return { root, persistence, executions, lifecycle, runtimeArtifact,
    builtins: [...builtinFrontendArtifacts(runtimeArtifact.artifactHash), { package: builtinPricing.package, artifactHash: runtimeArtifact.artifactHash }] };
}
describe('trusted shipped frontend lifecycle', () => {
  it('keeps authored shipped metadata aligned with independently buildable package descriptors', () => {
    for (const pkg of builtinFrontendPackages.filter(pkg => pkg.manifest.id !== 'helmsman.compat-clarifications')) {
      const name = pkg.manifest.id.replace(/^helmsman\./, '');
      const descriptor = parsePluginPackage(JSON.parse(readFileSync(new URL(`../../../src/plugins/${name}/plugin-package.json`, import.meta.url), 'utf8')), { allowBuiltin: true });
      expect({ ...descriptor.manifest, id: pkg.manifest.id }).toEqual(pkg.manifest);
    }
  });
  it('publishes trusted identity/version/hash metadata without executable artifact URLs', async () => {
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.builtins).toEqual(builtinFrontendPackages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version, hash: expect.stringMatching(/^[a-f\d]{64}$/), enabled: true })));
    expect(snapshot.catalog.plugins).toEqual([]); expect(snapshot.artifacts.size).toBe(0);
    expect(() => builtinFrontendArtifacts('unverified')).toThrow('hash');
    expect(builtinPluginPackage(root, 'helmsman.backlog')?.manifest).toMatchObject({ manifestVersion: 2, panels: [{ id: 'panel' }] });
  });
  it('keeps disabled pages/panels and their explicit page bindings unavailable across independent reads', async () => {
    await loadPluginSnapshot(root);
    await selectPluginPage(root, HELM_PAGE_SLOT, HELM_PAGE_ID); await selectPluginPage(root, COSTS_PAGE_SLOT, COSTS_PAGE_ID);
    for (const id of builtinFrontendPackages.map(pkg => pkg.manifest.id)) await setPluginEnabled(root, id, false);
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.builtins?.every(item => !item.enabled)).toBe(true);
    expect(snapshot.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: COSTS_PAGE_ID, [HELM_PAGE_SLOT]: HELM_PAGE_ID });
    expect(readBuiltinPluginStates(root).every(item => !item.enabled)).toBe(true);
    await setPluginEnabled(root, 'helmsman.helm', true);
    expect((await loadPluginSnapshot(root)).catalog.builtins?.filter(item => item.enabled).map(item => item.id)).toEqual(['helmsman.helm']);
  });
  it('disables frontend catalog entries in safe mode without changing saved operator enablement', async () => {
    const safe = await loadPluginSnapshot(root, true);
    expect(safe.catalog.safeMode).toBe(true); expect(safe.catalog.builtins?.every(item => !item.enabled)).toBe(true);
    expect(safe.artifacts.size).toBe(0); expect(safe.catalog.plugins).toEqual([]);
    expect(readBuiltinPluginStates(root).every(item => item.enabled)).toBe(true);
    expect((await loadPluginSnapshot(root)).catalog.builtins?.every(item => item.enabled)).toBe(true);
  });
  it('retains unavailable external Helm selections and rejects mismatched or invented shipped contributions', async () => {
    await selectPluginPage(root, HELM_PAGE_SLOT, 'example.missing/page');
    expect((await loadPluginSnapshot(root)).catalog.bindings[HELM_PAGE_SLOT]).toBe('example.missing/page');
    await expect(selectPluginPage(root, HELM_PAGE_SLOT, COSTS_PAGE_ID)).rejects.toThrow('does not support');
    await expect(selectPluginPage(root, COSTS_PAGE_SLOT, HELM_PAGE_ID)).rejects.toThrow('does not support');
    await expect(selectPluginPage(root, HELM_PAGE_SLOT, 'helmsman.spoof/page')).rejects.toThrow('does not support');
    await selectPluginPage(root, HELM_PAGE_SLOT, null); expect(readPluginState(root).bindings).toEqual({});
  });
  it('never publishes operator-injected reserved namespaces as trusted frontend modules', async () => {
    await loadPluginSnapshot(root);
    const sql = new Database(join(root, 'plugin-data.sqlite'));
    try { sql.prepare('INSERT INTO builtin_plugins VALUES(?,?,NULL)').run('helmsman.spoof', 1); } finally { sql.close(); }
    expect((await loadPluginSnapshot(root)).catalog.builtins?.map(item => item.id)).not.toContain('helmsman.spoof');
    const pkg = builtinFrontendPackages[0]!;
    await expect(installPlugin(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: pkg, files: [{ path: 'bundled/page.js', base64: Buffer.from('export default {};').toString('base64') }] })))).rejects.toThrow('reserved');
  });
  it.each([
    undefined,
    { id: 'example/other-layout', version: 1, accepts: [{ id: 'helmsman/helm-panel', version: 1 }] },
    { id: HELM_PAGE_SLOT, version: 1, accepts: [{ id: 'example/other-panel', version: 1 }] },
  ])('rejects a Helm selection with an incompatible composition contract %j', async composition => {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    await installPlugin(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: {
      packageVersion: 1, manifest: { manifestVersion: 2, id: 'example.invalid-helm', version: '1.0.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Incompatible Helm', slots: [HELM_PAGE_SLOT], panes: [], ...(composition ? { composition } : {}) }], panels: [] },
      node: { minMajor: nodeMajor, maxMajorExclusive: nodeMajor + 2 }, entries: { page: 'page.js' }, panelEntries: {},
    }, files: [{ path: 'page.js', base64: Buffer.from('export default { mount() {} };').toString('base64') }] })));
    await selectPluginPage(root, HELM_PAGE_SLOT, HELM_PAGE_ID);
    await expect(selectPluginPage(root, HELM_PAGE_SLOT, 'example.invalid-helm/page')).rejects.toThrow('does not support');
    expect(readPluginState(root).bindings[HELM_PAGE_SLOT]).toBe(HELM_PAGE_ID);
  });
  it('keeps frontend toggles separate from active built-in backend registration and preserves disablement across restart', async () => {
    const setup = options(); coordinator = await createPluginCoordinator(setup);
    const snapshot = await loadPluginSnapshot(root, false, coordinator);
    expect(snapshot.catalog.builtins?.every(item => item.hash === runtimeArtifact.artifactHash && item.enabled)).toBe(true);
    backend = await activateBackendPlugins({ root, snapshot, coordinator, builtins: [builtinPricing], usage: { async query() { throw new Error('Unused query'); } } });
    expect(backend.providers()).toEqual(['helmsman.standard-pricing/standard']);
    await coordinator.change('helmsman.helm', false);
    const disabled = retainActivatedPluginPages(await loadPluginSnapshot(root, false, coordinator), backend.activePluginIds());
    expect(disabled.catalog.builtins?.find(item => item.id === 'helmsman.helm')?.enabled).toBe(false);
    expect(disabled.catalog.builtins?.find(item => item.id === 'helmsman.backlog')?.enabled).toBe(true);
    expect(backend.providers()).toEqual(['helmsman.standard-pricing/standard']);
    await backend.dispose(); backend = undefined; coordinator.dispose(); coordinator = await createPluginCoordinator({ ...setup, resetHealth: true });
    expect((await loadPluginSnapshot(root, false, coordinator)).catalog.builtins?.find(item => item.id === 'helmsman.helm')?.enabled).toBe(false);
  });
  it('retires frontend health on disable and safe mode while restoring it on re-enable', async () => {
    coordinator = await createPluginCoordinator(options());
    await loadPluginSnapshot(root, false, coordinator);
    for (const pkg of builtinFrontendPackages) expect(coordinator.state(pkg.manifest.id)).toMatchObject({ desiredEnabled: true, health: 'active', state: 'active' });
    await coordinator.change('helmsman.helm', false);
    await loadPluginSnapshot(root, false, coordinator);
    expect(coordinator.state('helmsman.helm')).toMatchObject({ desiredEnabled: false, health: 'inactive', state: 'disabled', obligationsOnly: false });
    expect(coordinator.state('helmsman.backlog')?.health).toBe('active');
    await coordinator.change('helmsman.helm', true);
    await loadPluginSnapshot(root, false, coordinator);
    expect(coordinator.state('helmsman.helm')).toMatchObject({ desiredEnabled: true, health: 'active', state: 'active' });
    await loadPluginSnapshot(root, true, coordinator);
    for (const pkg of builtinFrontendPackages) expect(coordinator.state(pkg.manifest.id)).toMatchObject({ desiredEnabled: true, health: 'inactive', state: 'installed', obligationsOnly: false });
    await loadPluginSnapshot(root, false, coordinator);
    for (const pkg of builtinFrontendPackages) expect(coordinator.state(pkg.manifest.id)?.health).toBe('active');
  });
  it('fails closed while disablement projection is interrupted and recovers the saved intent', async () => {
    const setup = options(); let fail = false;
    coordinator = await createPluginCoordinator({ ...setup, afterProjection: target => { if (fail && target === 'catalog') throw new Error('projection interrupted'); } });
    await loadPluginSnapshot(root, false, coordinator); fail = true;
    await expect(coordinator.change('helmsman.costs', false)).rejects.toThrow('interrupted');
    expect((await loadPluginSnapshot(root, false, coordinator)).catalog.builtins?.find(item => item.id === 'helmsman.costs')?.enabled).toBe(false);
    coordinator.dispose(); coordinator = await createPluginCoordinator({ ...setup, resetHealth: true });
    expect((await loadPluginSnapshot(root, false, coordinator)).catalog.builtins?.find(item => item.id === 'helmsman.costs')?.enabled).toBe(false);
  });
  it('publishes changed and reset operator page selections without a lifecycle toggle or restart', async () => {
    coordinator = await createPluginCoordinator(options());
    const seen: Record<string, string>[] = [];
    const unsubscribe = coordinator.subscribe(async () => { seen.push({ ...(await loadPluginSnapshot(root, false, coordinator)).catalog.bindings }); });
    await selectPluginPage(root, HELM_PAGE_SLOT, 'example.replacement/helm'); await coordinator.reconcile();
    expect(seen.at(-1)).toEqual({ [HELM_PAGE_SLOT]: 'example.replacement/helm' });
    await selectPluginPage(root, HELM_PAGE_SLOT, null); await coordinator.reconcile();
    expect(seen.at(-1)).toEqual({}); unsubscribe();
  });
  it('rejects stored builtin packages whose owner differs from the package identity', async () => {
    await loadPluginSnapshot(root); const sql = new Database(join(root, 'plugin-data.sqlite'));
    try { sql.prepare('UPDATE builtin_plugins SET package=? WHERE id=?').run(JSON.stringify(builtinFrontendPackages[1]), 'helmsman.costs'); } finally { sql.close(); }
    expect(() => builtinPluginPackage(root, 'helmsman.costs')).toThrow('identity'); expect(() => readBuiltinPluginStates(root)).toThrow('identity');
  });
});
