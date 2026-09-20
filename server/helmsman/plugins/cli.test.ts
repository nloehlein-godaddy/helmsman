// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COSTS_PAGE_SLOT } from '../../../src/plugins/builtins';
import { parsePluginArchive } from './artifacts';
import { pluginCommand } from './cli';
import { loadPluginSnapshot, readPluginState } from './store';
import { openPersistence, registerPersistenceWriter } from '../persistence';

const run = promisify(execFile);
const nodeMajor = Number(process.versions.node.split('.')[0]);
const source = 'export default { mount(element) { element.textContent = "External page"; return { update() {}, dispose() {} }; } };';
function descriptor() {
  return {
    packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'example.cli', version: '1.0.0', sdkVersion: 1,
      pages: [{ id: 'page', title: 'CLI example', slots: [COSTS_PAGE_SLOT], panes: [] }] },
    node: { minMajor: nodeMajor, maxMajorExclusive: nodeMajor + 2 }, entries: { page: 'dist/page.js' },
  };
}
let root: string;
let store: string;
let directory: string;
let archive: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-plugin-cli-'));
  store = join(root, 'store');
  directory = join(root, 'source');
  archive = join(root, 'example.helmsman-plugin');
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'plugin-package.json'), JSON.stringify(descriptor()));
  await writeFile(join(directory, 'dist', 'page.js'), source);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const command = (...args: string[]) => pluginCommand(['--dir', store, ...args], { coordinate: false });

describe('plugin CLI', () => {
  it('packs, installs, enables, selects, lists, disables, and resets a page using real artifacts', async () => {
    expect(await command('pack', directory, archive)).toMatch(/^Packed example\.cli: [a-f0-9]{64}$/);
    const packed = parsePluginArchive(await readFile(archive));
    expect(packed.package.manifest.id).toBe('example.cli');
    expect(Buffer.from(packed.files.get('dist/page.js') ?? []).toString()).toBe(source);
    expect(await command('install', archive)).toContain('Disabled; enable only packages you trust.');
    expect(JSON.parse(await command('list'))).toEqual({
      plugins: [{ id: 'example.cli', hash: packed.hash, enabled: false }], bindings: {},
    });
    expect((await loadPluginSnapshot(store)).catalog.plugins).toEqual([]);
    expect(await command('enable', 'example.cli')).toContain('Restart Helmsman and reload browser tabs');
    await command('select', COSTS_PAGE_SLOT, 'example.cli/page');
    const snapshot = await loadPluginSnapshot(store);
    expect(snapshot.catalog.plugins[0]?.hash).toBe(packed.hash);
    expect(snapshot.catalog.bindings[COSTS_PAGE_SLOT]).toBe('example.cli/page');
    expect(await command('install', archive)).toContain('Already enabled.');
    await command('disable', 'example.cli');
    const disabled = await loadPluginSnapshot(store);
    expect(disabled.catalog.plugins).toEqual([]);
    expect(disabled.catalog.bindings[COSTS_PAGE_SLOT]).toBe('example.cli/page');
    await command('select', COSTS_PAGE_SLOT, 'default');
    expect(readPluginState(store).bindings).toEqual({});
  });

  it('supports the executable entry point and returns a failing exit code for invalid arguments', async () => {
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const output = await run(process.execPath, ['--import', 'tsx', cli, '--dir', store, 'list']);
    expect(JSON.parse(output.stdout)).toEqual({ plugins: [], bindings: {} });
    expect(output.stderr).toBe('');
    await expect(run(process.execPath, ['--import', 'tsx', cli, '--dir', store, 'invalid'])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Usage: plugins'),
    });
  });

  it('backs up the selected offline databases with source metadata and documents artifact retention', async () => {
    await command('pack', directory, archive);
    const dbPath = join(root, 'main.sqlite');
    await pluginCommand(['--dir', store, '--db', dbPath, 'install', archive]);
    const destination = join(root, 'backup');
    expect(await pluginCommand(['--dir', store, '--db', dbPath, 'backup', destination])).toContain(destination);
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    expect(manifest.metadata).toMatchObject({ creator: 'helmsman-plugin-cli', pluginDirectory: store, databases: { main: dbPath, catalog: join(store, 'catalog.sqlite'), data: join(store, 'plugin-data.sqlite') } });
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(['main.sqlite', 'catalog.sqlite', 'data.sqlite']);
    const main = openPersistence(dbPath);
    const release = registerPersistenceWriter(main, 'application');
    try {
      await expect(pluginCommand(['--dir', store, '--db', dbPath, 'backup', join(root, 'blocked')])).rejects.toThrow('active database writer');
    } finally { release(); main.close(); }
    expect(await pluginCommand(['--help'])).toContain('Retain the plugin and runtime artifact stores');
  });

  it.each([
    [], ['--dir'], ['pack'], ['pack', 'source'], ['pack', 'source', 'out', 'extra'],
    ['install'], ['install', 'file', 'extra'], ['enable'], ['disable'], ['select'],
    ['select', COSTS_PAGE_SLOT], ['list', 'extra'], ['unknown'],
  ].map(args => ({ args })))('rejects incomplete or unsupported arguments $args', async ({ args }) => {
    await expect(pluginCommand(args, { coordinate: false })).rejects.toThrow('Usage: plugins');
  });

  it('refuses to overwrite an output archive', async () => {
    await writeFile(archive, 'keep this file');
    await expect(command('pack', directory, archive)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(archive, 'utf8')).toBe('keep this file');
  });

  it('does not execute package code when packing, installing, enabling, or listing', async () => {
    const marker = '__helmsmanCliPluginExecuted';
    await writeFile(join(directory, 'dist', 'page.js'), `globalThis.${marker} = true; throw new Error('Do not evaluate'); export {};`);
    await command('pack', directory, archive);
    await command('install', archive);
    await command('enable', 'example.cli');
    await command('list');
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });

  it.each(["import '/src/main.js';", "import 'react';", "import('https://external.example/page.js');", "import('../../escape.js');"])(
    'enforces import boundaries while packing %s', async invalid => {
      await writeFile(join(directory, 'dist', 'page.js'), invalid);
      await expect(command('pack', directory, archive)).rejects.toThrow(/bundle dependencies|outside the package/);
      await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('checks imports again when installing an independently constructed archive', async () => {
    await writeFile(archive, JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor(),
      files: [{ path: 'dist/page.js', base64: Buffer.from("import '/src/main.js';").toString('base64') }] }));
    await expect(command('install', archive)).rejects.toThrow('bundle dependencies');
    expect(readPluginState(store).plugins).toEqual([]);
  });

  it('rejects malformed descriptors, malformed archives, directories, and oversized archives', async () => {
    await writeFile(join(directory, 'plugin-package.json'), JSON.stringify({ packageVersion: 99 }));
    await expect(command('pack', directory, archive)).rejects.toThrow();
    await writeFile(archive, '{invalid json');
    await expect(command('install', archive)).rejects.toThrow(/JSON/);
    await expect(command('install', directory)).rejects.toThrow('regular files');
    await truncate(archive, 15 * 1024 * 1024 + 1);
    await expect(command('install', archive)).rejects.toThrow('size limit');
  });

  it('rejects unknown installations, invalid slots, and invalid contribution identifiers', async () => {
    await expect(command('enable', 'example.missing')).rejects.toThrow('not installed');
    await expect(command('disable', '../escape')).rejects.toThrow('not installed');
    await expect(command('select', 'unknown/slot', 'example.cli/page')).rejects.toThrow('Invalid page slot');
    await expect(command('select', COSTS_PAGE_SLOT, '../escape')).rejects.toThrow('Invalid page slot');
  });
});
