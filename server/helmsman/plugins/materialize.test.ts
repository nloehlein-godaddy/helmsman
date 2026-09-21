// @vitest-environment node
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parsePluginArchive } from './artifacts';
import { materializePluginBackend } from './materialize';

let root: string;
const marker = '__materializedBackendEvaluations';
const leases: Array<Awaited<ReturnType<typeof materializePluginBackend>>> = [];
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-materialize-')); });
afterEach(async () => {
  await Promise.all(leases.splice(0).map(lease => lease.dispose()));
  await rm(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, marker);
});
function archive(version = '1.0.0') {
  const node = Number(process.versions.node.split('.')[0]);
  return parsePluginArchive(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1, manifest: { manifestVersion: 1, id: 'example.materialized', version, sdkVersion: 1, pages: [] },
      node: { minMajor: node, maxMajorExclusive: node + 1 }, entries: {},
      backend: { entry: 'backend.js', provides: [{ id: 'helmsman/pricing', version: 1, localId: 'fixed' }], settings: {}, storageVersion: 1 } },
    files: [
      { path: 'backend.js', base64: Buffer.from(`globalThis.${marker} = (globalThis.${marker} ?? 0) + 1; export default { value: async () => (await import('./helper.js')).value };`).toString('base64') },
      { path: 'helper.js', base64: Buffer.from(`export const value = '${version}';`).toString('base64') },
    ],
  }));
}
async function materialize(value = archive()) {
  const lease = await materializePluginBackend(root, value); leases.push(lease); return lease;
}
it('reuses one immutable module URL across repeated disposal and reactivation', async () => {
  let href: string | undefined;
  let module: unknown;
  for (let index = 0; index < 32; index++) {
    const lease = await materialize();
    const imported = await import(lease.href);
    if (index) { expect(lease.href).toBe(href); expect(imported).toBe(module); }
    href = lease.href; module = imported;
    expect(await imported.default.value()).toBe('1.0.0');
    await lease.dispose();
    expect(await readdir(join(root, 'runtime'))).toEqual([]);
  }
  expect(Reflect.get(globalThis, marker)).toBe(1);
});
it('keeps lazy imports available until every concurrent lease disposes and isolates artifact versions', async () => {
  const [first, second, third] = await Promise.all([materialize(), materialize(), materialize(archive('2.0.0'))]);
  expect(first.href).toBe(second.href); expect(third.href).not.toBe(first.href);
  const oldModule = await import(second.href);
  const newModule = await import(third.href);
  await first.dispose(); await first.dispose();
  expect(await readdir(join(root, 'runtime'))).toHaveLength(2);
  expect(await oldModule.default.value()).toBe('1.0.0');
  expect(await newModule.default.value()).toBe('2.0.0');
  await second.dispose();
  expect(await readdir(join(root, 'runtime'))).toHaveLength(1);
  expect(await newModule.default.value()).toBe('2.0.0');
  await third.dispose();
  expect(await readdir(join(root, 'runtime'))).toEqual([]);
  expect(Reflect.get(globalThis, marker)).toBe(2);
});
it('serializes overlapping releases and acquisitions without removing a live materialization', async () => {
  for (let index = 0; index < 24; index++) {
    const [first, second] = await Promise.all([materialize(), materialize()]);
    const releases = Promise.all([first.dispose(), second.dispose()]);
    const next = await materialize();
    await releases;
    expect(await readdir(join(root, 'runtime'))).toHaveLength(1);
    expect(await (await import(next.href)).default.value()).toBe('1.0.0');
    await next.dispose();
    expect(await readdir(join(root, 'runtime'))).toEqual([]);
  }
  expect(Reflect.get(globalThis, marker)).toBe(1);
});
