import { describe, expect, it, vi } from 'vitest';
import { isPluginAssetPath, parsePluginPackage } from './package';

function descriptor() {
  return { packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'acme.example', version: '1.0.0', sdkVersion: 1,
      pages: [{ id: 'example', title: 'Example', slots: [], panes: [] }] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { example: 'dist/page.js' } };
}

describe('plugin packages', () => {
  it('copies and deeply freezes the descriptor', () => {
    const input = descriptor();
    const result = parsePluginPackage(input);
    input.entries.example = 'other.js';
    input.manifest.pages[0]!.title = 'Changed';
    expect(result.entries.example).toBe('dist/page.js');
    expect(result.manifest.pages[0]?.title).toBe('Example');
    for (const item of [result, result.node, result.entries, result.manifest, result.manifest.pages,
      result.manifest.pages[0], result.manifest.pages[0]?.slots]) expect(Object.isFrozen(item)).toBe(true);
  });

  it.each([null, [], undefined, 1, 'package', new Date()])('rejects invalid record %j', input => {
    expect(() => parsePluginPackage(input)).toThrow();
  });

  it.each([{ packageVersion: 2 }, { extra: 1 }, { node: {} }, { entries: {} },
    { entries: { example: 'page.ts' } }, { entries: { example: 'page.js', extra: 'other.js' } },
    { node: { minMajor: 22, maxMajorExclusive: 22 } }, { node: { minMajor: 0, maxMajorExclusive: 22 } },
    { node: { minMajor: 22.1, maxMajorExclusive: 30 } }, { node: { minMajor: 22, maxMajorExclusive: 1001 } },
    { node: { minMajor: 22, maxMajorExclusive: Infinity } }, { node: { minMajor: '22', maxMajorExclusive: 30 } },
    { node: { minMajor: 22, maxMajorExclusive: 30, other: true } }])('rejects invalid fields %j', override => {
    expect(() => parsePluginPackage({ ...descriptor(), ...override })).toThrow();
  });

  it('reserves the builtin namespace', () => {
    const input = descriptor();
    input.manifest.id = 'helmsman.example';
    expect(() => parsePluginPackage(input)).toThrow(/reserved/);
  });

  it('rejects getters at every depth without running them', () => {
    const getter = vi.fn(() => 'page.js');
    const input = descriptor();
    Object.defineProperty(input.entries, 'example', { get: getter });
    expect(() => parsePluginPackage(input)).toThrow();
    const arrayInput = descriptor();
    Object.defineProperty(arrayInput.manifest.pages, '0', { get: getter });
    expect(() => parsePluginPackage(arrayInput)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects sparse arrays, symbols, cycles, and missing fields', () => {
    expect(() => parsePluginPackage({ ...descriptor(), [Symbol('x')]: 1 })).toThrow();
    const input = descriptor();
    input.manifest.pages = new Array(1);
    expect(() => parsePluginPackage(input)).toThrow();
    const cycle: Record<string, unknown> = descriptor();
    cycle.node = cycle;
    expect(() => parsePluginPackage(cycle)).toThrow();
    const missing: Record<string, unknown> = descriptor();
    delete missing.node;
    expect(() => parsePluginPackage(missing)).toThrow();
  });

  it.each(['page.js', 'dist/page.mjs', 'assets/icon-2.svg', 'a_b/C0.css'])('accepts safe path %s', path => {
    expect(isPluginAssetPath(path)).toBe(true);
  });

  it.each(['', '.', '..', '/page.js', '../page.js', 'a/../page.js', 'a/./page.js', 'a//page.js',
    'a\\page.js', 'page.js?x=1', 'page.js#x', '%70age.js', 'c:/page.js', 'page\n.js', 'page.js\n', 'café.js',
    'a/'.repeat(260), 'a'.repeat(129), '.hidden', null, 1])('rejects unsafe path %j', path => {
    expect(isPluginAssetPath(path)).toBe(false);
  });
});
