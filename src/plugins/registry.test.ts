import { describe, expect, it, vi } from 'vitest';
import { PluginManifestError } from './manifest';
import { PluginPageRegistry } from './registry';
import type { PageSlot } from './sdk';

const costsSlot = (): PageSlot => ({ id: 'helmsman/costs-page', alias: '/outcomes', defaultContributionId: 'acme.costs/summary' });
function manifest(id = 'acme.costs', slots = ['helmsman/costs-page']) {
  return { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [{ id: 'summary', title: 'Costs', slots, panes: ['history'] }] };
}
const registry = () => new PluginPageRegistry([costsSlot()], ['/', '/helm', '/config']);

describe('plugin page registry', () => {
  it('lists immutable snapshots in deterministic contribution order without selecting pages', () => {
    const host = registry();
    const remove = host.register(manifest('zebra.costs'));
    host.register(manifest());
    const snapshot = host.listPages();
    expect(snapshot.map(page => page.contributionId)).toEqual(['acme.costs/summary', 'zebra.costs/summary']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(() => (snapshot as unknown[]).pop()).toThrow();
    expect(host.selected('helmsman/costs-page').contributionId).toBe('acme.costs/summary');
    expect(() => host.register({ ...manifest('broken.costs'), pages: [null] })).toThrow();
    expect(host.listPages()).toEqual(snapshot);
    remove();
    expect(snapshot).toHaveLength(2);
    expect(host.listPages().map(page => page.contributionId)).toEqual(['acme.costs/summary']);
    host.register(manifest('zebra.costs'));
    expect(host.listPages()).toEqual(snapshot);
  });

  it('resolves slot aliases and namespaced canonical routes', () => {
    const host = registry();
    host.register(manifest());
    const page = host.getPage('acme.costs/summary');
    expect(page).toMatchObject({ contributionId: 'acme.costs/summary', pluginId: 'acme.costs', canonicalPath: '/plugins/acme.costs/summary' });
    expect(host.resolvePath('/outcomes')).toEqual({ contributionId: 'acme.costs/summary', slotId: 'helmsman/costs-page', page });
    expect(host.resolvePath('/plugins/acme.costs/summary')).toEqual({ contributionId: 'acme.costs/summary', slotId: null, page });
    expect(host.resolvePath('/helm')).toBeNull();
    expect(host.getPage('missing.plugin/page')).toBeNull();
  });

  it('retains canonical missing pages but rejects malformed plugin paths', () => {
    const host = registry();
    expect(host.resolvePath('/plugins/missing.plugin/page')).toEqual({ contributionId: 'missing.plugin/page', slotId: null, page: null });
    for (const path of ['/plugins/page', '/plugins/acme.costs/../page', '/plugins/acme.costs/page?x=1', '/plugins/acme.costs/page/child', '/plugins/acme.costs/%70age', '/plugins//page']) {
      expect(host.resolvePath(path)).toBeNull();
    }
  });

  it('replaces a slot explicitly and preserves missing bindings through registration changes', () => {
    const host = registry();
    host.register(manifest());
    host.select('helmsman/costs-page', 'other.costs/summary');
    expect(host.selected('helmsman/costs-page')).toEqual({ contributionId: 'other.costs/summary', slotId: 'helmsman/costs-page', page: null });
    const unregister = host.register(manifest('other.costs'));
    expect(host.selected('helmsman/costs-page').page?.pluginId).toBe('other.costs');
    unregister();
    expect(host.selected('helmsman/costs-page').contributionId).toBe('other.costs/summary');
    expect(host.selected('helmsman/costs-page').page).toBeNull();
    host.select('helmsman/costs-page', null);
    expect(host.selected('helmsman/costs-page').page?.pluginId).toBe('acme.costs');
  });

  it('rejects selecting an installed page for an unsupported slot', () => {
    const host = registry();
    host.register(manifest('other.costs', ['other/plugin-page']));
    expect(() => host.select('helmsman/costs-page', 'other.costs/summary')).toThrow(/support/);
    expect(host.selected('helmsman/costs-page').contributionId).toBe('acme.costs/summary');
  });

  it('keeps a saved selection unavailable when its later registration does not support the slot', () => {
    const host = registry();
    host.select('helmsman/costs-page', 'other.costs/summary');
    host.register(manifest('other.costs', []));
    expect(host.selected('helmsman/costs-page').page).toBeNull();
    expect(host.resolvePath('/plugins/other.costs/summary')?.page).not.toBeNull();
  });

  it('rejects unknown slots and malformed explicit contribution IDs', () => {
    const host = registry();
    expect(() => host.selected('missing/slot')).toThrow(PluginManifestError);
    expect(() => host.select('missing/slot', null)).toThrow(PluginManifestError);
    expect(() => host.select('helmsman/costs-page', '../page')).toThrow(PluginManifestError);
  });

  it('validates the entire registration before publishing anything', () => {
    const host = registry();
    const listener = vi.fn();
    host.subscribe(listener);
    const input = manifest();
    expect(() => host.register({ ...input, pages: [...input.pages, null] })).toThrow(PluginManifestError);
    expect(host.getPage('acme.costs/summary')).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    host.register(input);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => host.register({ ...input, version: '2.0.0' })).toThrow(/already/);
    expect(listener).toHaveBeenCalledOnce();
    expect(host.getPage('acme.costs/summary')).not.toBeNull();
  });

  it('makes stale and repeated unregister calls harmless', () => {
    const host = registry();
    const unregister = host.register(manifest());
    unregister();
    unregister();
    const unregisterNew = host.register(manifest());
    unregister();
    expect(host.getPage('acme.costs/summary')).not.toBeNull();
    unregisterNew();
    expect(host.getPage('acme.costs/summary')).toBeNull();
  });

  it('isolates registration, slot, and returned record mutations', () => {
    const slot = { ...costsSlot() };
    const host = new PluginPageRegistry([slot]);
    slot.alias = '/changed';
    slot.defaultContributionId = 'other.costs/summary';
    const input = manifest();
    host.register(input);
    input.pages[0]!.title = 'changed';
    input.pages[0]!.slots.length = 0;
    const resolved = host.resolvePath('/outcomes');
    expect(resolved?.page?.title).toBe('Costs');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.page)).toBe(true);
    expect(Object.isFrozen(resolved?.page?.panes)).toBe(true);
    expect(host.resolvePath('/changed')).toBeNull();
  });

  it('isolates listener failures after committing state and supports independent disposers', () => {
    const host = registry();
    host.subscribe(() => { throw new Error('broken listener'); });
    const listener = vi.fn(() => { expect(host.getPage('acme.costs/summary')).not.toBeNull(); });
    const disposeOne = host.subscribe(listener);
    const disposeTwo = host.subscribe(listener);
    expect(() => host.register(manifest())).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(2);
    disposeOne();
    host.select('helmsman/costs-page', 'acme.costs/summary');
    expect(listener).toHaveBeenCalledTimes(3);
    disposeTwo();
    host.select('helmsman/costs-page', null);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it.each(['/plugins', '/plugins/acme.costs/page', '/outcomes/', '//outcomes', '/outcomes?x=1', '/outcomes#x', '/%6futcomes', '/../outcomes', 'outcomes', '/'])('rejects malformed or reserved alias %s', alias => {
    expect(() => new PluginPageRegistry([{ ...costsSlot(), alias }])).toThrow(PluginManifestError);
  });

  it('rejects duplicate slots, aliases, and legacy-path collisions', () => {
    expect(() => new PluginPageRegistry([costsSlot(), costsSlot()])).toThrow(PluginManifestError);
    expect(() => new PluginPageRegistry([costsSlot(), { ...costsSlot(), id: 'other/costs-page' }])).toThrow(PluginManifestError);
    expect(() => new PluginPageRegistry([costsSlot()], ['/outcomes'])).toThrow(PluginManifestError);
    expect(() => new PluginPageRegistry([], ['/helm', '/helm'])).toThrow(PluginManifestError);
    expect(() => new PluginPageRegistry([], ['/plugins/acme.costs/page'])).toThrow(PluginManifestError);
    expect(() => new PluginPageRegistry([], new Array(1))).toThrow(PluginManifestError);
  });

  it('keeps root aliases and retained Helm selections unavailable for incompatible composition declarations', () => {
    const host = new PluginPageRegistry([]);
    host.registerSlot({ id: 'helmsman/helm-page', alias: '/helm', aliases: ['/'], defaultContributionId: 'example.helm/page' });
    host.register({ manifestVersion: 2, id: 'example.helm', version: '1.0.0', sdkVersion: 1, panels: [],
      pages: [{ id: 'page', title: 'Helm', slots: ['helmsman/helm-page'], panes: [],
        composition: { id: 'example/different-layout', version: 1, accepts: [{ id: 'helmsman/helm-panel', version: 1 }] } }] });
    expect(() => host.select('helmsman/helm-page', 'example.helm/page')).toThrow(/support/);
    host.restoreSelection('helmsman/helm-page', 'example.helm/page');
    expect(host.resolvePath('/')).toEqual(host.resolvePath('/helm'));
    expect(host.resolvePath('/')?.page).toBeNull();
    host.unregister('example.helm');
    expect(host.resolvePath('/')?.contributionId).toBe('example.helm/page');
    expect(() => host.registerSlot({ id: 'other/page', alias: '/other', aliases: ['/'], defaultContributionId: 'other.page/page' })).toThrow();
  });
});
