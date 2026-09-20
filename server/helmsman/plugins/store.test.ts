// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COSTS_PAGE_ID, COSTS_PAGE_SLOT, createAppPageRegistry } from '../../../src/plugins/builtins';
import { installPluginArtifact, readPluginArtifact } from './artifacts';
import { installPlugin, loadPluginSnapshot, readPluginState, selectPluginPage, setPluginEnabled } from './store';

const nodeMajor = Number(process.versions.node.split('.')[0]);
function archive(id = 'example.costs', version = '1.0.0', options: { minMajor?: number; source?: string; slots?: string[] } = {}) {
  return Buffer.from(JSON.stringify({
    format: 'helmsman-plugin', version: 1,
    package: {
      packageVersion: 1,
      manifest: { manifestVersion: 1, id, version, sdkVersion: 1,
        pages: [{ id: 'page', title: 'Example costs', slots: options.slots ?? [COSTS_PAGE_SLOT], panes: [] }] },
      node: { minMajor: options.minMajor ?? nodeMajor, maxMajorExclusive: nodeMajor + 2 }, entries: { page: 'page.js' },
    },
    files: [{ path: 'page.js', base64: Buffer.from(options.source ?? 'export const mount = () => ({ update() {}, dispose() {} });').toString('base64') }],
  }));
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-plugin-store-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function replaceInstalledHash(id: string, hash: string): void {
  const db = new Database(join(root, 'catalog.sqlite'));
  try { db.prepare('UPDATE plugin_packages SET hash = ? WHERE id = ?').run(hash, id); }
  finally { db.close(); }
}

describe('plugin installation store', () => {
  it('installs without executing code and starts disabled', async () => {
    const marker = '__helmsmanPluginStoreExecuted';
    const installed = await installPlugin(root, archive('example.costs', '1.0.0', {
      source: `globalThis.${marker} = true; throw new Error('Installation executed plugin code'); export {};`,
    }));
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    expect(installed).toMatchObject({ id: 'example.costs', enabled: false });
    expect(readPluginState(root)).toEqual({ plugins: [installed], bindings: {} });
    expect((await loadPluginSnapshot(root)).catalog.plugins).toEqual([]);
    await setPluginEnabled(root, installed.id, true);
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.plugins.map(plugin => plugin.package.manifest.id)).toEqual([installed.id]);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });

  it('persists activation and explicit slot binding across independent store opens', async () => {
    const installed = await installPlugin(root, archive());
    await setPluginEnabled(root, installed.id, true);
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${installed.id}/page`);
    expect(readPluginState(root)).toEqual({ plugins: [{ ...installed, enabled: true }], bindings: { [COSTS_PAGE_SLOT]: `${installed.id}/page` } });
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.bindings[COSTS_PAGE_SLOT]).toBe(`${installed.id}/page`);
    expect(snapshot.artifacts.has(`${installed.id}/${installed.hash}`)).toBe(true);
    expect(snapshot.errors).toEqual([]);
  });

  it('rejects an active upgrade and permits reinstalling identical bytes without disabling', async () => {
    const installed = await installPlugin(root, archive());
    await setPluginEnabled(root, installed.id, true);
    await expect(installPlugin(root, archive('example.costs', '2.0.0'))).rejects.toThrow('Disable the plugin');
    await expect(installPlugin(root, archive())).resolves.toEqual({ ...installed, enabled: true });
    expect(readPluginState(root).plugins).toEqual([{ ...installed, enabled: true }]);
  });

  it('upgrades a disabled plugin while retaining the previous artifact and binding', async () => {
    const old = await installPlugin(root, archive());
    await setPluginEnabled(root, old.id, true);
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${old.id}/page`);
    await setPluginEnabled(root, old.id, false);
    const replacement = await installPlugin(root, archive(old.id, '2.0.0'));
    expect(replacement.enabled).toBe(false);
    expect(replacement.hash).not.toBe(old.hash);
    expect((await readPluginArtifact(root, old.hash)).package.manifest.version).toBe('1.0.0');
    expect((await readPluginArtifact(root, replacement.hash)).package.manifest.version).toBe('2.0.0');
    expect(readPluginState(root).bindings[COSTS_PAGE_SLOT]).toBe(`${old.id}/page`);
    expect((await loadPluginSnapshot(root)).catalog.plugins).toEqual([]);
  });

  it.each(['disabled', 'missing', 'corrupt', 'incompatible'] as const)('keeps %s selections unavailable while other installed pages load', async failure => {
    const selected = await installPlugin(root, archive('example.selected'));
    const healthy = await installPlugin(root, archive('example.healthy'));
    await setPluginEnabled(root, selected.id, true);
    await setPluginEnabled(root, healthy.id, true);
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${selected.id}/page`);
    const path = join(root, 'artifacts', `${selected.hash}.json`);
    if (failure === 'disabled') await setPluginEnabled(root, selected.id, false);
    if (failure === 'missing') await rm(path);
    if (failure === 'corrupt') await writeFile(path, `${await readFile(path, 'utf8')} `);
    if (failure === 'incompatible') {
      const incompatible = await installPluginArtifact(root, archive(selected.id, '2.0.0', { minMajor: nodeMajor + 1 }));
      replaceInstalledHash(selected.id, incompatible.hash);
    }
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.plugins.map(plugin => plugin.package.manifest.id)).toEqual([healthy.id]);
    expect(snapshot.artifacts.size).toBe(1);
    expect(snapshot.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: `${selected.id}/page` });
    expect(snapshot.catalog.bindings[COSTS_PAGE_SLOT]).not.toBe(COSTS_PAGE_ID);
    expect(snapshot.errors).toHaveLength(failure === 'disabled' ? 0 : 1);
    expect(snapshot.catalog.safeMode).toBe(false);
  });

  it('retains missing contribution selections instead of choosing a default', async () => {
    await selectPluginPage(root, COSTS_PAGE_SLOT, 'example.missing/page');
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: 'example.missing/page' });
    expect(snapshot.catalog.plugins).toEqual([]);
  });

  it('safe mode skips broken artifacts and preserves the selected binding and enabled records', async () => {
    const installed = await installPlugin(root, archive());
    await setPluginEnabled(root, installed.id, true);
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${installed.id}/page`);
    await rm(join(root, 'artifacts', `${installed.hash}.json`));
    const snapshot = await loadPluginSnapshot(root, true);
    expect(snapshot.catalog.safeMode).toBe(true);
    expect(snapshot.catalog.plugins).toEqual([]);
    expect(snapshot.artifacts.size).toBe(0);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: `${installed.id}/page` });
    expect(readPluginState(root).plugins).toEqual([{ ...installed, enabled: true }]);
  });

  it('preserves the selected contribution when a new manifest no longer supports the slot', async () => {
    const previous = await installPlugin(root, archive());
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${previous.id}/page`);
    await installPlugin(root, archive(previous.id, '2.0.0', { slots: [] }));
    await setPluginEnabled(root, previous.id, true);
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: `${previous.id}/page` });
    expect(snapshot.catalog.plugins[0]?.package.manifest.pages[0]?.slots).toEqual([]);
    const registry = createAppPageRegistry();
    for (const [slot, contribution] of Object.entries(snapshot.catalog.bindings)) registry.select(slot, contribution);
    for (const plugin of snapshot.catalog.plugins) registry.register(plugin.package.manifest);
    expect(registry.resolvePath('/outcomes')).toEqual({ contributionId: `${previous.id}/page`, slotId: COSTS_PAGE_SLOT, page: null });
    expect(snapshot.errors).toEqual([]);
  });

  it('rejects incompatible installs and invalid imports before recording an installation', async () => {
    await expect(installPlugin(root, archive('example.future', '1.0.0', { minMajor: nodeMajor + 1 }))).rejects.toThrow('does not support Node');
    await expect(installPlugin(root, archive('example.private', '1.0.0', { source: "import '/src/main.js';" }))).rejects.toThrow('bundle dependencies');
    expect(readPluginState(root)).toEqual({ plugins: [], bindings: {} });
  });

  it('rejects slot-incompatible contributions and allows explicit reset to the builtin default', async () => {
    const installed = await installPlugin(root, archive('example.other', '1.0.0', { slots: [] }));
    await expect(selectPluginPage(root, COSTS_PAGE_SLOT, `${installed.id}/page`)).rejects.toThrow('does not support this slot');
    await selectPluginPage(root, COSTS_PAGE_SLOT, COSTS_PAGE_ID);
    expect(readPluginState(root).bindings[COSTS_PAGE_SLOT]).toBe(COSTS_PAGE_ID);
    await selectPluginPage(root, COSTS_PAGE_SLOT, null);
    expect(readPluginState(root).bindings).toEqual({});
  });
});
