// @vitest-environment node
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COSTS_PAGE_SLOT } from '../../../src/plugins/builtins';
import { readPluginArtifact } from './artifacts';
import { installPlugin, loadPluginSnapshot, readPluginState, selectPluginPage, setPluginEnabled } from './store';

const execute = promisify(execFile);
const nodeMajor = Number(process.versions.node.split('.')[0]);
function archive(version = '1.0.0') {
  return Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'example.recovery', version, sdkVersion: 1,
        pages: [{ id: 'page', title: 'Recovery', slots: [COSTS_PAGE_SLOT], panes: [] }] },
      node: { minMajor: nodeMajor, maxMajorExclusive: nodeMajor + 1 }, entries: { page: 'page.js' } },
    files: [{ path: 'page.js', base64: Buffer.from('export default { mount() { throw new Error("must not execute"); } };').toString('base64') }],
  }));
}
let root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-plugin-recovery-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function catalogSql(sql: string): void {
  const db = new Database(join(root, 'catalog.sqlite'));
  try { db.exec(sql); } finally { db.close(); }
}

describe('plugin installation recovery', () => {
  it('ignores interrupted staging files and can subsequently install the complete package', async () => {
    await mkdir(join(root, 'artifacts'));
    await writeFile(join(root, 'artifacts', '.stage-interrupted'), archive().subarray(0, 64));
    await selectPluginPage(root, COSTS_PAGE_SLOT, 'example.recovery/page');
    const before = await loadPluginSnapshot(root);
    expect(before.catalog.plugins).toEqual([]);
    expect(before.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: 'example.recovery/page' });
    expect(before.errors).toEqual([]);
    const installed = await installPlugin(root, archive());
    expect(installed.enabled).toBe(false);
    await setPluginEnabled(root, installed.id, true);
    expect((await loadPluginSnapshot(root)).catalog.plugins.map(plugin => plugin.hash)).toEqual([installed.hash]);
  });

  it('survives process death after artifact publication without activating orphaned package bytes', async () => {
    const installed = await installPlugin(root, archive());
    await setPluginEnabled(root, installed.id, true);
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${installed.id}/page`);
    const artifactModule = new URL('./artifacts.ts', import.meta.url).href;
    const script = `
      import { installPluginArtifact } from ${JSON.stringify(artifactModule)};
      await installPluginArtifact(process.argv[1], Buffer.from(process.argv[2], 'base64'));
      process.kill(process.pid, 'SIGKILL');
    `;
    await expect(execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, archive('2.0.0').toString('base64')]))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    expect((await readdir(join(root, 'artifacts'))).filter(path => path.endsWith('.json'))).toHaveLength(2);
    const recovered = await loadPluginSnapshot(root);
    expect(recovered.catalog.plugins.map(plugin => plugin.hash)).toEqual([installed.hash]);
    expect(recovered.catalog.bindings).toEqual({ [COSTS_PAGE_SLOT]: `${installed.id}/page` });
    expect(recovered.errors).toEqual([]);
    expect(readPluginState(root).plugins).toEqual([{ ...installed, enabled: true }]);
  });

  it('fails closed on a damaged catalog without replacing its contents', async () => {
    const damaged = Buffer.from('interrupted or damaged SQLite catalog');
    await writeFile(join(root, 'catalog.sqlite'), damaged);
    const snapshot = await loadPluginSnapshot(root);
    expect(snapshot.catalog.safeMode).toBe(true);
    expect(snapshot.catalog.plugins).toEqual([]);
    expect(snapshot.artifacts.size).toBe(0);
    expect(snapshot.errors).toEqual(['Plugin catalog could not be read; optional page loading is disabled.']);
    expect(await readFile(join(root, 'catalog.sqlite'))).toEqual(damaged);
  });

  it('keeps the previous installation and binding when catalog publication fails, then permits retry', async () => {
    const installed = await installPlugin(root, archive());
    await selectPluginPage(root, COSTS_PAGE_SLOT, `${installed.id}/page`);
    catalogSql("CREATE TRIGGER reject_update BEFORE UPDATE ON plugin_packages BEGIN SELECT RAISE(ABORT, 'injected catalog failure'); END;");
    await expect(installPlugin(root, archive('2.0.0'))).rejects.toThrow('injected catalog failure');
    expect(readPluginState(root)).toEqual({ plugins: [installed], bindings: { [COSTS_PAGE_SLOT]: `${installed.id}/page` } });
    expect((await loadPluginSnapshot(root)).catalog.plugins).toEqual([]);
    expect((await readPluginArtifact(root, installed.hash)).package.manifest.version).toBe('1.0.0');
    catalogSql('DROP TRIGGER reject_update;');
    const replacement = await installPlugin(root, archive('2.0.0'));
    expect(replacement.hash).not.toBe(installed.hash);
    expect(replacement.enabled).toBe(false);
    expect(readPluginState(root).bindings).toEqual({ [COSTS_PAGE_SLOT]: `${installed.id}/page` });
    await setPluginEnabled(root, replacement.id, true);
    expect((await loadPluginSnapshot(root)).catalog.plugins.map(plugin => plugin.hash)).toEqual([replacement.hash]);
  });
});
