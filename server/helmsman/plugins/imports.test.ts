// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePluginArchive } from './artifacts';
import { validatePluginImports } from './imports';

function archive(files: Record<string, string>, backend = false, panel = false) {
  return parsePluginArchive(JSON.stringify({
    format: 'helmsman-plugin', version: 1,
    package: {
      packageVersion: 1,
      manifest: { manifestVersion: panel ? 2 : 1, id: 'example.imports', version: '1.0.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Imports', slots: [], panes: [] }],
        ...(panel ? { panels: [{ id: 'panel', title: 'Panel', contract: { id: 'helmsman/helm-panel', version: 1 }, requires: [] }] } : {}) },
      node: { minMajor: 22, maxMajorExclusive: 100 }, entries: { page: 'page.js' },
      ...(panel ? { panelEntries: { panel: 'panel.js' } } : {}),
      ...(backend ? { backend: { entry: 'backend.js', storageVersion: 1, provides: [{ id: 'helmsman/pricing', version: 1, localId: 'rates' }], settings: {} } } : {}),
    },
    files: Object.entries(files).map(([path, source]) => ({ path, base64: Buffer.from(source).toString('base64') })),
  }));
}

describe('plugin import boundaries', () => {
  it('includes panel entry dependencies in the browser boundary even when shared with backend code', async () => {
    for (const panel of ["import 'node:fs';", "import './shared.js';", "export const lazy = () => import('./shared.js');"]) {
      await expect(validatePluginImports(archive({ 'page.js': 'export default {};', 'panel.js': panel,
        'backend.js': "import './shared.js';", 'shared.js': "export { readFile } from 'node:fs/promises';" }, true, true))).rejects.toThrow('restricted to backend');
    }
    await expect(validatePluginImports(archive({ 'page.js': 'export default {};', 'panel.js': "export * from './shared.js';",
      'backend.js': "import 'node:fs'; import './shared.js';", 'shared.js': 'export const value = 1;' }, true, true))).resolves.toBeUndefined();
  });
  it('allows Node built-ins only in backend-reachable modules', async () => {
    await expect(validatePluginImports(archive({ 'page.js': 'export default {};',
      'backend.js': "import './server/helper.js';", 'server/helper.js': "import {readFile} from 'node:fs/promises'; export {readFile};" }, true))).resolves.toBeUndefined();
    await expect(validatePluginImports(archive({ 'page.js': "import './backend.js';",
      'backend.js': "import 'node:fs';" }, true))).rejects.toThrow('restricted to backend');
    await expect(validatePluginImports(archive({ 'page.js': 'export default {};', 'backend.js': 'export default {};',
      'unused.js': "import 'node:fs';" }, true))).rejects.toThrow('restricted to backend');
  });

  it('rejects native/bare backend dependencies, private imports, and CommonJS package scopes', async () => {
    for (const source of ["import 'better-sqlite3';", "import '../host.js';", "import 'node:nonexistent';"]) {
      await expect(validatePluginImports(archive({ 'page.js': 'export default {};', 'backend.js': source }, true))).rejects.toThrow();
    }
    await expect(validatePluginImports(archive({ 'page.js': 'export default {};', 'backend.js': 'export default {};',
      'package.json': '{"type":"commonjs"}' }, true))).rejects.toThrow('type module');
  });
  it('allows bundled relative static, re-exported, and literal dynamic modules', async () => {
    await expect(validatePluginImports(archive({
      'page.js': "import { value } from './lib/helpers.mjs'; export { value }; export const lazy = () => import('./lib/lazy.js'); export const url = import.meta.url; export const literal = () => import(`./lib/lazy.js`);",
      'lib/helpers.mjs': "export { value } from '../shared.js';",
      'lib/lazy.js': "import '../shared.js'; export default {};",
      'shared.js': 'export const value = 1;',
    }))).resolves.toBeUndefined();
  });

  it.each([
    ['bare dependency', "import 'react';"],
    ['private absolute module', "import '/src/main.ts';"],
    ['remote dependency', "import 'https://example.com/module.js';"],
    ['escape from the package', "import '../outside.js';"],
    ['missing bundled module', "import './missing.js';"],
    ['nonliteral dynamic import', "const path = './page.js'; import(path);"],
    ['computed template dynamic import', 'const file = \"page\"; import(`./${file}.js`);'],
    ['dynamic bare dependency', "import('react');"],
    ['private re-export', "export * from '../../src/main.js';"],
    ['encoded path', "import './%70age.js';"],
    ['asset query', "import './page.js?raw';"],
    ['asset fragment', "import './page.js#x';"],
    ['non-JavaScript import', "import './data.json';"],
  ])('rejects %s', async (_label, source) => {
    await expect(validatePluginImports(archive({ 'page.js': source, 'data.json': '{}' }))).rejects.toThrow();
  });

  it('validates the transitive bundled modules before activation', async () => {
    await expect(validatePluginImports(archive({
      'page.js': "import './lib/helper.js';",
      'lib/helper.js': "import '../../../src/main.js';",
    }))).rejects.toThrow('outside the package or missing');
  });
});
