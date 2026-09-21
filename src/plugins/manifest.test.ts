import { describe, expect, it } from 'vitest';
import { parsePluginManifest, PluginManifestError } from './manifest';

function manifest() {
  return {
    manifestVersion: 1, id: 'acme.costs', version: '1.0.0', sdkVersion: 1,
    pages: [{ id: 'summary', title: 'Costs', slots: ['helmsman/costs-page'], panes: ['history'] }],
  };
}

describe('plugin manifest validation', () => {
  const composed = () => ({ ...manifest(), manifestVersion: 2,
    pages: [{ ...manifest().pages[0], composition: { id: 'helmsman/helm-page', version: 1,
      accepts: [{ id: 'helmsman/helm-panel', version: 1 }] }, requires: [{ id: 'helmsman/composition', version: 1 }] }],
    panels: [{ id: 'backlog', title: 'Backlog', contract: { id: 'helmsman/helm-panel', version: 1 },
      requires: [{ id: 'helmsman/task-read', version: 1 }] }] });

  it('supports independently declared composition pages and panels in version 2', () => {
    const input = composed();
    const parsed = parsePluginManifest(input);
    expect(parsed.manifestVersion).toBe(2);
    if (parsed.manifestVersion !== 2) throw new Error('Expected version 2');
    input.panels[0]!.title = 'Changed';
    expect(parsed.panels[0]?.title).toBe('Backlog');
    expect(Object.isFrozen(parsed.panels[0]?.requires)).toBe(true);
    expect(Object.isFrozen(parsed.pages[0]?.composition?.accepts[0])).toBe(true);
    expect(() => parsePluginManifest({ ...input, pages: [], panels: [] })).not.toThrow();
  });

  it('rejects duplicate IDs across contribution kinds and unsupported contract versions', () => {
    const input = composed();
    expect(() => parsePluginManifest({ ...input, panels: [{ ...input.panels[0], id: 'summary' }] })).toThrow(/unique/);
    expect(() => parsePluginManifest({ ...input, panels: [{ ...input.panels[0], contract: { id: 'helmsman/helm-panel', version: 2 } }] })).toThrow();
    expect(() => parsePluginManifest({ ...input, panels: [{ ...input.panels[0], requires: [{ id: 'private/service', version: 1 }] }] })).toThrow();
    expect(() => parsePluginManifest({ ...input, panels: [{ ...input.panels[0], requires: [input.panels[0]!.requires[0], input.panels[0]!.requires[0]] }] })).toThrow(/unique/);
  });

  it('keeps version 1 strict and rejects malformed composition and accessor fields', () => {
    const input = composed();
    expect(() => parsePluginManifest({ ...manifest(), pages: input.pages })).toThrow();
    expect(() => parsePluginManifest({ ...input, pages: [{ ...input.pages[0], composition: null }] })).toThrow();
    expect(() => parsePluginManifest({ ...input, pages: [{ ...input.pages[0], get composition() { throw new Error('executed'); } }] })).toThrow(PluginManifestError);
    expect(() => parsePluginManifest({ ...input, panels: new Array(1) })).toThrow();
  });

  it('copies and freezes all manifest records and arrays', () => {
    const input = manifest();
    const parsed = parsePluginManifest(input);
    input.pages[0]!.title = 'Changed';
    input.pages[0]!.slots.push('acme/other');
    input.pages.push({ id: 'other', title: 'Other', slots: [], panes: [] });
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]?.title).toBe('Costs');
    expect(parsed.pages[0]?.slots).toEqual(['helmsman/costs-page']);
    for (const value of [parsed, parsed.pages, parsed.pages[0], parsed.pages[0]?.slots, parsed.pages[0]?.panes]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it.each([null, undefined, [], 'manifest', 1, new Date(), Object.create({ id: 'acme.costs' })])('rejects non-record input %j', value => {
    expect(() => parsePluginManifest(value)).toThrow(PluginManifestError);
  });

  it.each([
    { manifestVersion: 2 }, { sdkVersion: 2 }, { manifestVersion: '1' }, { sdkVersion: null },
    { id: 'costs' }, { id: 'Acme.costs' }, { id: 'acme..costs' }, { id: 'acme.costs/../other' },
    { id: 'acme.costs%2fother' }, { id: 'acme.costs#fragment' },
    { version: 'latest' }, { version: '1.0' }, { version: '^1.0.0' }, { version: '01.0.0' },
    { version: '1.0.0-01' }, { version: null }, { version: '1.0.0\n' },
    { pages: null }, { pages: [null] }, { pages: [undefined] }, { pages: new Array(1) },
    { unexpected: true },
  ])('rejects invalid manifest fields %j', override => {
    expect(() => parsePluginManifest({ ...manifest(), ...override })).toThrow(PluginManifestError);
  });

  it.each(['0.0.0', '1.2.3', '1.2.3-alpha.1', '1.2.3+build.001', '1.2.3-rc.2+build'])('accepts semantic package version %s', version => {
    expect(parsePluginManifest({ ...manifest(), version }).version).toBe(version);
  });

  it.each([
    { id: '../summary' }, { id: 'summary/child' }, { id: 'Summary' }, { id: '' },
    { title: '' }, { title: '  ' }, { title: null }, { title: 'Title\nInjected' },
    { slots: ['helmsman/costs-page', 'helmsman/costs-page'] }, { slots: ['unqualified'] },
    { slots: new Array(1) }, { slots: [null] }, { slots: null },
    { panes: ['history', 'history'] }, { panes: ['../history'] }, { panes: [null] },
    { panes: new Array(1) }, { panes: null }, { unknown: true },
  ])('rejects invalid page fields %j', override => {
    const input = manifest();
    expect(() => parsePluginManifest({ ...input, pages: [{ ...input.pages[0], ...override }] })).toThrow(PluginManifestError);
  });

  it('rejects duplicate page IDs', () => {
    const input = manifest();
    expect(() => parsePluginManifest({ ...input, pages: [...input.pages, ...input.pages] })).toThrow(/unique/);
  });

  it('rejects missing fields, symbols, and accessors without evaluating them', () => {
    expect(() => parsePluginManifest({ ...manifest(), [Symbol('extra')]: true })).toThrow(PluginManifestError);
    const input: Record<string, unknown> = manifest();
    delete input.sdkVersion;
    expect(() => parsePluginManifest(input)).toThrow(PluginManifestError);
    const accessor = { ...manifest(), get id() { throw new Error('accessor executed'); } };
    expect(() => parsePluginManifest(accessor)).toThrow(PluginManifestError);
  });
});
