// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePluginArchive } from './artifacts';
import { validatePluginImports } from './imports';

function archive(files: Record<string, string>) {
  return parsePluginArchive(JSON.stringify({
    format: 'helmsman-plugin', version: 1,
    package: {
      packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'example.imports', version: '1.0.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Imports', slots: [], panes: [] }] },
      node: { minMajor: 22, maxMajorExclusive: 100 }, entries: { page: 'page.js' },
    },
    files: Object.entries(files).map(([path, source]) => ({ path, base64: Buffer.from(source).toString('base64') })),
  }));
}

describe('plugin import boundaries', () => {
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
