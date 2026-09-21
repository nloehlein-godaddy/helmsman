// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAppPageRegistry } from '../../../src/plugins/builtins';
import { builtinFrontendManifests, COSTS_PAGE_ID, COSTS_PAGE_SLOT, HELM_PAGE_ID, HELM_PAGE_SLOT } from '../../../src/plugins/frontend-manifests';
import { parsePluginPackage } from '../../../src/plugins/package';
import { PluginPageRegistry } from '../../../src/plugins/registry';
import type { PluginCatalog } from '../../../src/plugins/runtime';
import { createServerPageCatalog } from './page-catalog';

const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);
const builtinEntries = () => builtinFrontendManifests.map(manifest => ({ id: manifest.id, version: manifest.version, hash: firstHash, enabled: true }));
function external(options: { hash?: string; title?: string; slots?: string[]; composition?: string } = {}) {
  return { hash: options.hash ?? firstHash, package: parsePluginPackage({ packageVersion: 1, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'page.js' }, panelEntries: {},
    manifest: { manifestVersion: 2, id: 'example.helm', version: '1.0.0', sdkVersion: 1, panels: [], pages: [{ id: 'page', title: options.title ?? 'Independent Helm', slots: options.slots ?? [HELM_PAGE_SLOT], panes: [],
      composition: { id: options.composition ?? HELM_PAGE_SLOT, version: 1, accepts: [{ id: 'helmsman/helm-panel', version: 1 }] }, requires: [{ id: 'helmsman/composition', version: 1 }] }] } }) };
}
function catalog(changes: Partial<PluginCatalog> = {}): PluginCatalog { return { version: 1, safeMode: false, plugins: [], builtins: builtinEntries(), bindings: {}, ...changes }; }

describe('server frontend page catalog projection', () => {
  it('owns static Costs and registers Helm aliases before restoring persisted bindings', () => {
    const registry = createAppPageRegistry(); expect(registry.getPage(COSTS_PAGE_ID)).not.toBeNull();
    const host = createServerPageCatalog(registry); expect(registry.getPage(COSTS_PAGE_ID)).toBeNull();
    host.apply(catalog({ plugins: [external()], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')?.page?.contributionId).toBe('example.helm/page');
    expect(registry.resolvePath('/helm')?.page?.contributionId).toBe('example.helm/page');
    expect(registry.resolvePath('/outcomes')?.page?.contributionId).toBe(COSTS_PAGE_ID);
    expect(registry.resolvePath('/plugins/example.helm/page')?.page?.title).toBe('Independent Helm');
  });
  it('also initializes known slots in an otherwise empty registry', () => {
    const registry = new PluginPageRegistry([]); const host = createServerPageCatalog(registry); host.apply(catalog());
    expect(registry.resolvePath('/')?.page?.contributionId).toBe(HELM_PAGE_ID);
    expect(registry.resolvePath('/outcomes')?.page?.contributionId).toBe(COSTS_PAGE_ID);
  });
  it('unregisters disabled or missing builtins without selecting an external fallback', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry); host.apply(catalog());
    host.apply(catalog({ plugins: [external()], builtins: builtinEntries().map(entry => ({ ...entry, enabled: false })) }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: HELM_PAGE_ID, page: null });
    expect(registry.resolvePath('/outcomes')).toMatchObject({ contributionId: COSTS_PAGE_ID, page: null });
    host.apply(catalog({ builtins: undefined }));
    expect(registry.resolvePath('/')?.page).toBeNull(); expect(registry.resolvePath('/outcomes')?.page).toBeNull();
    host.apply(catalog()); expect(registry.resolvePath('/')?.page?.contributionId).toBe(HELM_PAGE_ID);
  });
  it('replaces external registration when the selected artifact changes', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    host.apply(catalog({ plugins: [external()], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    const previous = registry.getPage('example.helm/page');
    host.apply(catalog({ plugins: [external({ hash: secondHash, title: 'Updated Helm' })], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')?.page?.title).toBe('Updated Helm'); expect(registry.getPage('example.helm/page')).not.toBe(previous);
    host.apply(catalog({ bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.helm/page', page: null });
  });
  it('restores incompatible saved selections as unavailable instead of blocking catalog publication', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    host.apply(catalog({ plugins: [external({ slots: [] })], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.helm/page', page: null });
    expect(registry.resolvePath('/plugins/example.helm/page')?.page).not.toBeNull();
    expect(() => registry.select(HELM_PAGE_SLOT, 'example.helm/page')).toThrow('support');
    host.apply(catalog({ plugins: [external()], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')?.page?.contributionId).toBe('example.helm/page');
    host.apply(catalog({ plugins: [external({ hash: secondHash, composition: 'example/other-layout' })], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.helm/page', page: null });
    expect(registry.getPage('example.helm/page')?.composition?.id).toBe('example/other-layout');
  });
  it('resets bindings removed from the persisted catalog and retains explicit missing targets', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    host.apply(catalog({ bindings: { [HELM_PAGE_SLOT]: 'example.missing/page', [COSTS_PAGE_SLOT]: 'example.costs/page' } }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.missing/page', page: null });
    host.apply(catalog({ bindings: {} }));
    expect(registry.resolvePath('/')?.page?.contributionId).toBe(HELM_PAGE_ID);
    expect(registry.resolvePath('/outcomes')?.page?.contributionId).toBe(COSTS_PAGE_ID);
  });
  it('uses trusted builtin declarations and keeps version-mismatched frontend code unavailable', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    host.apply(catalog({ builtins: builtinEntries().map(entry => entry.id === 'helmsman.helm' ? { ...entry, version: '99.0.0' } : entry) }));
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: HELM_PAGE_ID, page: null });
    expect(registry.getPage(COSTS_PAGE_ID)?.title).toBe('Costs & Outcomes');
  });
  it('safe mode removes all presentation registrations while preserving selection identity', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    const selected = catalog({ plugins: [external()], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }); host.apply(selected);
    host.apply({ ...selected, safeMode: true });
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.helm/page', page: null }); expect(registry.getPage(COSTS_PAGE_ID)).toBeNull();
    host.apply(selected); expect(registry.resolvePath('/')?.page?.contributionId).toBe('example.helm/page');
  });
  it('does not churn unchanged registrations and makes disposal idempotent', () => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry);
    const selected = catalog({ plugins: [external()], bindings: { [HELM_PAGE_SLOT]: 'example.helm/page' } }); host.apply(selected);
    const original = registry.getPage('example.helm/page'); const listener = vi.fn(); registry.subscribe(listener);
    host.apply(selected); expect(registry.getPage('example.helm/page')).toBe(original); expect(listener).not.toHaveBeenCalled();
    host.dispose(); host.dispose(); host.apply(selected);
    expect(registry.resolvePath('/')).toMatchObject({ contributionId: 'example.helm/page', page: null });
  });
  it.each(['binding', 'duplicate', 'spoofed-builtin', 'hash', 'sparse', 'builtin-null'])('rejects invalid %s data before mutating registered pages', flaw => {
    const registry = createAppPageRegistry(); const host = createServerPageCatalog(registry); host.apply(catalog());
    let invalid: unknown;
    if (flaw === 'binding') invalid = catalog({ bindings: { 'example/unknown-slot': 'example.helm/page' } });
    else if (flaw === 'duplicate') invalid = catalog({ plugins: [external(), external()] });
    else if (flaw === 'spoofed-builtin') invalid = catalog({ builtins: [{ id: 'helmsman.unknown', hash: firstHash, enabled: true, version: '1.0.0' }] });
    else if (flaw === 'hash') invalid = catalog({ plugins: [{ ...external(), hash: 'invalid' }] });
    else if (flaw === 'builtin-null') invalid = { ...catalog(), builtins: null };
    else invalid = catalog({ plugins: new Array(1) });
    expect(() => host.apply(invalid as PluginCatalog)).toThrow(); expect(registry.resolvePath('/')?.page?.contributionId).toBe(HELM_PAGE_ID);
    expect(registry.resolvePath('/outcomes')?.page?.contributionId).toBe(COSTS_PAGE_ID);
  });
});
