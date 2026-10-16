import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltinFrontendCatalogEntry } from './runtime';
import { builtinFrontendManifests } from './frontend-manifests';

const hash = 'a'.repeat(64);
const entries = (ids = ['helmsman.costs', 'helmsman.helm', 'helmsman.backlog']): BuiltinFrontendCatalogEntry[] => ids.map(id => {
  const manifest = builtinFrontendManifests.find(item => item.id === id);
  if (!manifest) throw new Error(`Missing builtin manifest: ${id}`);
  return { id, version: manifest.version, hash, enabled: true };
});

async function setup() {
  const builtins = await import('./builtins');
  const modules = await import('./builtin-modules');
  const { appPanels } = await import('./panels');
  const runtime = await import('./runtime');
  return { ...builtins, ...modules, ...runtime, panels: appPanels };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shipped frontend plugin lifecycle', () => {
  it('registers the read-only Agents overview without panels and retains its route when disabled', async () => {
    const app = await setup(); const metadata = entries(['helmsman.agents-overview']);
    app.syncBuiltinFrontend(metadata, false);
    expect(app.appPages.resolvePath('/agents-overview')).toMatchObject({ contributionId: app.AGENTS_OVERVIEW_PAGE_ID,
      slotId: app.AGENTS_OVERVIEW_PAGE_SLOT, page: { title: 'Agents overview', requires: [] } });
    expect(app.appPages.resolvePath(`/plugins/${app.AGENTS_OVERVIEW_PAGE_ID}`)?.page?.title).toBe('Agents overview');
    expect(app.appPageModules.get(app.AGENTS_OVERVIEW_PAGE_ID)).not.toBeNull();
    expect(app.panels.get('helmsman.agents-overview/panel')).toBeNull();
    app.syncBuiltinFrontend(metadata.map(entry => ({ ...entry, enabled: false })), false);
    expect(app.appPageModules.get(app.AGENTS_OVERVIEW_PAGE_ID)).toBeNull();
    expect(app.appPages.resolvePath('/agents-overview')).toMatchObject({ contributionId: app.AGENTS_OVERVIEW_PAGE_ID, page: null });
    app.syncBuiltinFrontend(metadata, false);
    expect(app.appPageModules.get(app.AGENTS_OVERVIEW_PAGE_ID)).not.toBeNull();
  });

  it('registers enabled contributions without importing implementations and loads only the mounted page', async () => {
    const costsLoaded = vi.fn(); const backlogLoaded = vi.fn();
    const mount = vi.fn(() => ({ update() {}, dispose() {} }));
    vi.doMock('./costs/page', () => { costsLoaded(); return { default: { mount } }; });
    vi.doMock('./backlog/panel', () => { backlogLoaded(); return { default: { mount } }; });
    try {
      const app = await setup();
      app.syncBuiltinFrontend(entries(), false);
      expect(costsLoaded).not.toHaveBeenCalled(); expect(backlogLoaded).not.toHaveBeenCalled();
      const module = app.appPageModules.get(app.COSTS_PAGE_ID);
      expect(module).not.toBeNull();
      await module?.mount(document.createElement('div'), { state: {
        repo: null, themeId: 'default', pirateMode: false, visible: true, pane: null,
      }, signal: new AbortController().signal, navigate() {}, onDispose() {} });
      expect(costsLoaded).toHaveBeenCalledOnce(); expect(backlogLoaded).not.toHaveBeenCalled();
      expect(mount).toHaveBeenCalledOnce();
    } finally { vi.doUnmock('./costs/page'); vi.doUnmock('./backlog/panel'); }
  });

  it('preserves module identity until a hash change and renews identities on re-enable', async () => {
    const app = await setup(); const metadata = entries();
    app.syncBuiltinFrontend(metadata, false);
    const original = app.appPageModules.get(app.HELM_PAGE_ID);
    const originalPanel = app.panels.getModule('helmsman.backlog/panel');
    app.syncBuiltinFrontend(metadata, false);
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).toBe(original);
    expect(app.panels.getModule('helmsman.backlog/panel')).toBe(originalPanel);
    const changed = metadata.map(entry => ({ ...entry, hash: 'b'.repeat(64) }));
    app.syncBuiltinFrontend(changed, false);
    const replacement = app.appPageModules.get(app.HELM_PAGE_ID);
    expect(replacement).not.toBeNull(); expect(replacement).not.toBe(original);
    expect(app.panels.getModule('helmsman.backlog/panel')).not.toBe(originalPanel);
    app.syncBuiltinFrontend(changed, true);
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).toBeNull();
    app.syncBuiltinFrontend(changed, false);
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).not.toBe(replacement);
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).not.toBeNull();
  });

  it('activates task pages and both source-settings panels through the shared catalog lifecycle', async () => {
    const app = await setup();
    const taskIds = ['helmsman.todos-ui', 'helmsman.triage', 'helmsman.bugs', 'helmsman.source-settings'];
    const metadata = taskIds.map(id => {
      const manifest = app.builtinFrontendManifests.find(manifest => manifest.id === id);
      if (!manifest) throw new Error(`Missing builtin manifest: ${id}`);
      return { id, version: manifest.version, hash, enabled: true };
    });
    app.syncBuiltinFrontend(metadata, false);
    for (const [index, alias] of ['/todos', '/triage', '/bugs', '/source-settings'].entries()) {
      const id = taskIds[index]!;
      expect(app.appPages.resolvePath(alias)?.page?.contributionId).toBe(`${id}/page`);
      expect(app.appPageModules.get(`${id}/page`)).not.toBeNull();
      expect(app.panels.getModule(`${id}/panel`)).not.toBeNull();
    }
    expect(app.panels.getModule('helmsman.source-settings/automatic')).not.toBeNull();
    app.appPages.select(app.TODOS_PAGE_SLOT, 'example.missing/page');
    app.syncBuiltinFrontend(metadata, true);
    for (const id of taskIds) {
      expect(app.appPageModules.get(`${id}/page`)).toBeNull();
      expect(app.panels.getModule(`${id}/panel`)).toBeNull();
    }
    expect(app.panels.getModule('helmsman.source-settings/automatic')).toBeNull();
    app.syncBuiltinFrontend(metadata, false);
    expect(app.appPages.resolvePath('/todos')).toMatchObject({ contributionId: 'example.missing/page', page: null });
    app.appPages.select(app.TODOS_PAGE_SLOT, null);
    expect(app.appPages.resolvePath('/todos')?.page?.contributionId).toBe(app.TODOS_PAGE_ID);
  });

  it('registers shipped manifests and modules only from explicit compatible metadata', async () => {
    const app = await setup();
    app.syncBuiltinFrontend(entries(), false);
    expect(app.appPages.resolvePath('/')?.page?.contributionId).toBe(app.HELM_PAGE_ID);
    expect(app.appPages.resolvePath('/helm')?.page?.contributionId).toBe(app.HELM_PAGE_ID);
    expect(app.appPages.resolvePath('/outcomes')?.page?.contributionId).toBe(app.COSTS_PAGE_ID);
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).not.toBeNull();
    expect(app.appPageModules.get(app.COSTS_PAGE_ID)).not.toBeNull();
    expect(app.panels.get('helmsman.backlog/panel')?.title).toBe('Backlog');
    expect(app.panels.getModule('helmsman.backlog/panel')).not.toBeNull();
  });

  it('removes disabled manifests and modules, preserves unavailable routes, and re-enables them', async () => {
    const app = await setup();
    app.syncBuiltinFrontend(entries(), false);
    app.syncBuiltinFrontend(entries().map(entry => ({ ...entry, enabled: false })), false);
    for (const id of [app.COSTS_PAGE_ID, app.HELM_PAGE_ID]) {
      expect(app.appPages.getPage(id)).toBeNull();
      expect(app.appPageModules.get(id)).toBeNull();
    }
    expect(app.panels.get('helmsman.backlog/panel')).toBeNull();
    expect(app.panels.getModule('helmsman.backlog/panel')).toBeNull();
    for (const path of ['/', '/helm']) expect(app.appPages.resolvePath(path)).toMatchObject({ contributionId: app.HELM_PAGE_ID, page: null });
    expect(app.appPages.resolvePath('/outcomes')).toMatchObject({ contributionId: app.COSTS_PAGE_ID, page: null });
    app.syncBuiltinFrontend(entries(), false);
    expect(app.appPages.resolvePath('/')?.page?.contributionId).toBe(app.HELM_PAGE_ID);
    expect(app.appPageModules.get(app.COSTS_PAGE_ID)).not.toBeNull();
    expect(app.panels.getModule('helmsman.backlog/panel')).not.toBeNull();
  });

  it.each(['safe-mode', 'version-mismatch', 'omitted-entries'] as const)('fails closed without a fallback for %s', async reason => {
    const app = await setup();
    app.syncBuiltinFrontend(entries(), false);
    app.syncBuiltinFrontend(reason === 'omitted-entries' ? [] : entries().map(entry => ({ ...entry,
      version: reason === 'version-mismatch' ? '9.9.9' : entry.version })), reason === 'safe-mode');
    expect(app.appPages.resolvePath('/')?.page).toBeNull();
    expect(app.appPages.resolvePath('/outcomes')?.page).toBeNull();
    expect(app.appPageModules.get(app.HELM_PAGE_ID)).toBeNull();
    expect(app.appPageModules.get(app.COSTS_PAGE_ID)).toBeNull();
    expect(app.panels.get('helmsman.backlog/panel')).toBeNull();
    expect(app.panels.getModule('helmsman.backlog/panel')).toBeNull();
  });

  it('preserves an unavailable operator binding instead of falling back to the shipped Helm', async () => {
    const app = await setup();
    app.syncBuiltinFrontend(entries(), false);
    app.appPages.select(app.HELM_PAGE_SLOT, 'example.missing/page');
    app.syncBuiltinFrontend([], false);
    app.syncBuiltinFrontend(entries(), false);
    expect(app.appPages.resolvePath('/')).toMatchObject({ contributionId: 'example.missing/page', page: null });
  });

  it('applies live enablement and binding removal through catalog polling', async () => {
    vi.useFakeTimers();
    const app = await setup();
    let value = { version: 1, safeMode: false, plugins: [], builtins: entries(),
      bindings: { [app.HELM_PAGE_SLOT]: 'example.missing/page' } as Record<string, string> };
    const runtime = await app.loadPluginCatalog(app.appPages, app.appPageModules, { panels: app.panels,
      applyBuiltins: app.syncBuiltinFrontend, pollIntervalMs: 100,
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value))) });
    try {
      expect(runtime.errors).toEqual([]);
      expect(app.appPages.resolvePath('/')).toMatchObject({ contributionId: 'example.missing/page', page: null });
      value = { ...value, bindings: {}, builtins: entries().map(entry => ({ ...entry, enabled: false })) };
      await vi.advanceTimersByTimeAsync(100);
      expect(app.appPages.resolvePath('/')).toMatchObject({ contributionId: app.HELM_PAGE_ID, page: null });
      expect(app.appPageModules.get(app.HELM_PAGE_ID)).toBeNull();
      expect(app.panels.getModule('helmsman.backlog/panel')).toBeNull();
      value = { ...value, builtins: entries() };
      await vi.advanceTimersByTimeAsync(100);
      expect(app.appPages.resolvePath('/')?.page?.contributionId).toBe(app.HELM_PAGE_ID);
      expect(app.panels.getModule('helmsman.backlog/panel')).not.toBeNull();
    } finally { runtime.dispose(); }
  });

  it('rejects spoofed builtin identities and executable metadata', async () => {
    const app = await setup();
    const base = { version: 1, safeMode: false, plugins: [], bindings: {} };
    for (const entry of [
      { ...entries()[0], id: 'example.costs' },
      { ...entries()[0], id: 'helmsman.spoof' },
      { ...entries()[0], entry: '/plugin-assets/evil.js' },
    ]) expect(() => app.parsePluginCatalog({ ...base, builtins: [entry] })).toThrow();
    expect(() => app.parsePluginCatalog({ ...base, plugins: [{ hash, package: {
      packageVersion: 1, manifest: app.costsManifest, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'dist/page.js' },
    } }] })).toThrow();
  });

  it('does not execute builtin array accessors or custom iterators', async () => {
    const app = await setup();
    const base = { version: 1, safeMode: false, plugins: [], bindings: {} };
    const getter = vi.fn(() => entries()[0]);
    const accessor = entries(); Object.defineProperty(accessor, 0, { get: getter });
    expect(() => app.parsePluginCatalog({ ...base, builtins: accessor })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const iterator = vi.fn(function* () { yield entries()[0]; });
    const iterable = entries(); Object.defineProperty(iterable, Symbol.iterator, { value: iterator });
    expect(() => app.parsePluginCatalog({ ...base, builtins: iterable })).toThrow();
    expect(iterator).not.toHaveBeenCalled();
  });
});

it('binds the authored clarification alias while retaining separate compatibility recovery and optional contacts', async () => {
  const app = await setup(); const ids = ['helmsman.clarifications', 'helmsman.suggested-contacts', 'helmsman.compat-clarifications'];
  const metadata = entries(ids); app.syncBuiltinFrontend(metadata, false);
  expect(app.appPages.resolvePath('/clarifications')?.page).toMatchObject({ contributionId: app.CLARIFICATIONS_PAGE_ID, composition: { accepts: [{ id: app.CLARIFICATIONS_PANEL_CONTRACT, version: 1 }, { id: 'helmsman/suggested-contacts-panel', version: 1 }] } });
  expect(app.appPages.resolvePath('/plugins/helmsman.compat-clarifications/page')?.page?.contributionId).toBe('helmsman.compat-clarifications/page');
  app.syncBuiltinFrontend(metadata.map(entry => ({ ...entry, enabled: entry.id !== 'helmsman.suggested-contacts' })), false);
  expect(app.appPages.resolvePath('/clarifications')?.page?.contributionId).toBe(app.CLARIFICATIONS_PAGE_ID);
  expect(app.panels.getModule('helmsman.suggested-contacts/panel')).toBeNull();
  app.syncBuiltinFrontend(metadata.map(entry => ({ ...entry, enabled: entry.id !== 'helmsman.clarifications' })), false);
  expect(app.appPages.resolvePath('/clarifications')).toMatchObject({ contributionId: app.CLARIFICATIONS_PAGE_ID, page: null });
  expect(app.appPageModules.get('helmsman.compat-clarifications/page')).not.toBeNull();
  app.appPages.select(app.CLARIFICATIONS_PAGE_SLOT, 'example.missing/page'); app.syncBuiltinFrontend(metadata, false);
  expect(app.appPages.resolvePath('/clarifications')).toMatchObject({ contributionId: 'example.missing/page', page: null });
  app.appPages.select(app.CLARIFICATIONS_PAGE_SLOT, null); expect(app.appPages.resolvePath('/clarifications')?.page?.contributionId).toBe(app.CLARIFICATIONS_PAGE_ID);
});
