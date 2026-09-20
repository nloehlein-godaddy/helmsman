// @vitest-environment node
import { expect, it } from 'vitest';
import { retainActivatedPluginPages } from './activation';
import { parsePluginArchive } from './artifacts';
import type { PluginSnapshot } from './store';

it('publishes combined package pages/assets only after backend activation while preserving explicit bindings', () => {
  const archive = (id: string, backend: boolean) => parsePluginArchive(Buffer.from(JSON.stringify({
    format: 'helmsman-plugin', version: 1, package: {
      packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Page', slots: ['helmsman/costs-page'], panes: [] }] },
      node: { minMajor: 1, maxMajorExclusive: 1000 }, entries: { page: 'page.js' },
      ...(backend ? { backend: { entry: 'backend.js', provides: [{ id: 'helmsman/pricing', version: 1, localId: 'price' }], settings: {}, storageVersion: 1 } } : {}),
    }, files: ['page.js', 'backend.js'].map(path => ({ path, base64: Buffer.from('export default {};').toString('base64') })),
  })));
  const failed = archive('example.failed', true), good = archive('example.good', true), page = archive('example.page', false);
  const artifacts = [failed, good, page];
  const snapshot: PluginSnapshot = { catalog: { version: 1, safeMode: false,
    plugins: artifacts.map(archive => ({ package: archive.package, hash: archive.hash })), bindings: { 'helmsman/costs-page': 'example.failed/page' } },
    artifacts: new Map(artifacts.map(archive => [`${archive.package.manifest.id}/${archive.hash}`, archive])), errors: [] };
  const result = retainActivatedPluginPages(snapshot, ['example.good']);
  expect(result.catalog.plugins.map(plugin => plugin.package.manifest.id)).toEqual(['example.good', 'example.page']);
  expect(result.catalog.bindings).toEqual(snapshot.catalog.bindings);
  expect([...result.artifacts.values()]).toEqual([good, page]);
  expect(result.errors).toEqual(['Plugin example.failed backend failed; its pages remain unavailable.']);
  expect(snapshot.catalog.plugins).toHaveLength(3);
  expect(snapshot.artifacts.size).toBe(3);
});
