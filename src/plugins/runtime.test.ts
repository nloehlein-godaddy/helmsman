import { afterEach, describe, expect, it, vi } from 'vitest';
import { COSTS_PAGE_ID, COSTS_PAGE_SLOT, createAppPageRegistry } from './builtins';
import { PluginPageModules } from './modules';
import { loadPluginCatalog, parsePluginCatalog } from './runtime';
import type { PluginPageContext, PluginPageInstance } from './sdk';

const hash = 'a'.repeat(64);
const plugin = (id = 'example.costs') => ({
  packageVersion: 1,
  manifest: { manifestVersion: 1, sdkVersion: 1, id, version: '1.0.0',
    pages: [{ id: 'page', title: 'External costs', slots: [COSTS_PAGE_SLOT], panes: [] }] },
  node: { minMajor: 22, maxMajorExclusive: 30 },
  entries: { page: 'dist/page.js' },
});
const catalog = () => ({ version: 1, safeMode: false, plugins: [{ package: plugin(), hash }], bindings: {} });
const lifecycle = (): PluginPageInstance => ({ update() {}, dispose() {} });
const context = (signal = new AbortController().signal): PluginPageContext => ({
  state: { repo: 'org/galleon', themeId: 'default', pirateMode: false, visible: true, pane: null },
  signal, navigate() {}, onDispose() {},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const fetchCatalog = (value: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)));
const setup = () => ({ registry: createAppPageRegistry(), modules: new PluginPageModules() });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('plugin catalog validation', () => {
  it('returns a deeply frozen defensive snapshot', () => {
    const source = catalog();
    const parsed = parsePluginCatalog(source);
    source.plugins[0]!.package.entries.page = 'different.js';
    expect(parsed.plugins[0]?.package.entries.page).toBe('dist/page.js');
    for (const value of [parsed, parsed.plugins, parsed.plugins[0], parsed.plugins[0]?.package, parsed.bindings]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it.each([
    null, [], {}, { ...catalog(), version: 2 }, { ...catalog(), safeMode: 'false' },
    { ...catalog(), extra: true }, { ...catalog(), plugins: null },
    { ...catalog(), plugins: [...catalog().plugins, ...catalog().plugins] },
    { ...catalog(), plugins: Array.from({ length: 33 }, (_, index) => ({ package: plugin(`example.plugin${index}`), hash })) },
    { ...catalog(), plugins: [{ package: plugin(), hash: '../entry.js' }] },
    { ...catalog(), plugins: [{ package: plugin(), hash: 'A'.repeat(64) }] },
    { ...catalog(), plugins: [{ package: plugin('helmsman.other'), hash }] },
    { ...catalog(), plugins: [{ package: { ...plugin(), entries: { page: '../entry.js' } }, hash }] },
    { ...catalog(), bindings: { 'unknown/slot': 'example.costs/page' } },
    { ...catalog(), bindings: { [COSTS_PAGE_SLOT]: '../../page' } },
    { ...catalog(), bindings: [] },
  ])('rejects invalid catalog %j', value => {
    expect(() => parsePluginCatalog(value)).toThrow();
  });

  it('rejects accessors without executing them', () => {
    const getter = vi.fn(() => false);
    const value = catalog();
    Object.defineProperty(value, 'safeMode', { get: getter });
    expect(() => parsePluginCatalog(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects array accessors and custom iterators without executing them', () => {
    const getter = vi.fn(() => catalog().plugins[0]);
    const value = catalog();
    Object.defineProperty(value.plugins, 0, { get: getter });
    expect(() => parsePluginCatalog(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const iterator = vi.fn();
    Object.defineProperty(value.plugins, Symbol.iterator, { value: iterator });
    expect(() => parsePluginCatalog(value)).toThrow();
    expect(iterator).not.toHaveBeenCalled();
  });
});

describe('external plugin catalog loading', () => {
  it('registers metadata without evaluating code and lazily imports the namespaced immutable URL', async () => {
    const { registry, modules } = setup();
    const instance = lifecycle();
    const mount = vi.fn(() => instance);
    const importer = vi.fn(async () => ({ default: { mount } }));
    const fetcher = fetchCatalog(catalog());
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetcher, importModule: importer });
    expect(runtime.errors).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith('/api/plugins/catalog', expect.objectContaining({ credentials: 'same-origin' }));
    expect(registry.getPage('example.costs/page')?.canonicalPath).toBe('/plugins/example.costs/page');
    expect(importer).not.toHaveBeenCalled();
    const module = modules.get('example.costs/page')!;
    const supplied = context();
    const element = document.createElement('div');
    expect(await module.mount(element, supplied)).toBe(instance);
    expect(importer).toHaveBeenCalledExactlyOnceWith(`/plugin-assets/example.costs/${hash}/dist/page.js`);
    expect(mount).toHaveBeenCalledWith(element, supplied);
    await module.mount(document.createElement('div'), context());
    expect(importer).toHaveBeenCalledOnce();
    runtime.dispose();
    runtime.dispose();
    expect(registry.getPage('example.costs/page')).toBeNull();
    expect(modules.get('example.costs/page')).toBeNull();
    expect(registry.getPage(COSTS_PAGE_ID)).not.toBeNull();
  });

  it('coalesces concurrent imports', async () => {
    const { registry, modules } = setup();
    const imported = deferred<unknown>();
    const importer = vi.fn(() => imported.promise);
    await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()), importModule: importer });
    const module = modules.get('example.costs/page')!;
    const first = module.mount(document.createElement('div'), context());
    const second = module.mount(document.createElement('div'), context());
    expect(importer).toHaveBeenCalledOnce();
    const mount = vi.fn(lifecycle);
    imported.resolve({ default: { mount } });
    await Promise.all([first, second]);
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it.each(['aborted', 'removed'] as const)('never mounts code after an import completes for a %s page', async reason => {
    const { registry, modules } = setup();
    const imported = deferred<unknown>();
    const importer = vi.fn(() => imported.promise);
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()), importModule: importer });
    const module = modules.get('example.costs/page')!;
    const controller = new AbortController();
    const pending = module.mount(document.createElement('div'), context(controller.signal));
    if (reason === 'aborted') controller.abort();
    else runtime.dispose();
    const mount = vi.fn(lifecycle);
    imported.resolve({ default: { mount } });
    const instance = await pending;
    expect(mount).not.toHaveBeenCalled();
    expect(() => instance.dispose()).not.toThrow();
  });

  it('does not import for an already aborted mount', async () => {
    const { registry, modules } = setup();
    const importer = vi.fn();
    await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()), importModule: importer });
    const controller = new AbortController();
    controller.abort();
    await modules.get('example.costs/page')?.mount(document.createElement('div'), context(controller.signal));
    expect(importer).not.toHaveBeenCalled();
  });

  it.each([null, {}, { default: () => {} }, { default: {} }, { default: { mount: true } }])('rejects invalid page exports %j', async exported => {
    const { registry, modules } = setup();
    await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()), importModule: async () => exported });
    await expect(modules.get('example.costs/page')?.mount(document.createElement('div'), context())).rejects.toThrow('default-export');
  });

  it('keeps a failed import rejected without importing repeatedly', async () => {
    const { registry, modules } = setup();
    const importer = vi.fn(async () => { throw new Error('Import failed'); });
    await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()), importModule: importer });
    for (let attempt = 0; attempt < 2; ++attempt) {
      await expect(modules.get('example.costs/page')?.mount(document.createElement('div'), context())).rejects.toThrow('Import failed');
    }
    expect(importer).toHaveBeenCalledOnce();
  });

  it('validates the complete catalog before registering any package', async () => {
    const { registry, modules } = setup();
    const value = { ...catalog(), plugins: [...catalog().plugins, { package: {}, hash }] };
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(value) });
    expect(runtime.safeMode).toBe(true);
    expect(runtime.errors).toHaveLength(1);
    expect(registry.getPage('example.costs/page')).toBeNull();
    expect(modules.get('example.costs/page')).toBeNull();
    expect(registry.getPage(COSTS_PAGE_ID)).not.toBeNull();
  });

  it('rolls back partial module registration and continues with another package', async () => {
    const { registry, modules } = setup();
    const existing = { mount: () => lifecycle() };
    modules.register('example.costs/second', existing);
    const original = modules.get('example.costs/second');
    const first = plugin();
    first.manifest.pages.push({ ...first.manifest.pages[0]!, id: 'second' });
    Object.assign(first.entries, { second: 'dist/second.js' });
    const value = { ...catalog(), plugins: [{ package: first, hash }, { package: plugin('example.other'), hash }] };
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(value) });
    expect(runtime.errors).toEqual(['Plugin example.costs could not be registered.']);
    expect(modules.get('example.costs/page')).toBeNull();
    expect(registry.getPage('example.costs/page')).toBeNull();
    expect(modules.get('example.costs/second')).toBe(original);
    expect(registry.getPage('example.other/page')).not.toBeNull();
    runtime.dispose();
    expect(modules.get('example.costs/second')).toBe(original);
  });

  it('rolls back modules when metadata registration fails without removing existing metadata', async () => {
    const { registry, modules } = setup();
    registry.register(plugin().manifest);
    const original = registry.getPage('example.costs/page');
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(catalog()) });
    expect(runtime.errors).toHaveLength(1);
    expect(modules.get('example.costs/page')).toBeNull();
    expect(registry.getPage('example.costs/page')).toBe(original);
  });

  it('retains an unavailable explicit selection', async () => {
    const { registry, modules } = setup();
    const value = { ...catalog(), bindings: { [COSTS_PAGE_SLOT]: 'missing.plugin/page' } };
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(value) });
    expect(runtime.errors).toEqual([]);
    expect(registry.selected(COSTS_PAGE_SLOT)).toMatchObject({ contributionId: 'missing.plugin/page', page: null });
    runtime.dispose();
    expect(registry.selected(COSTS_PAGE_SLOT).contributionId).toBe('missing.plugin/page');
  });

  it('preserves an explicit binding when an upgraded page no longer supports its slot', async () => {
    const { registry, modules } = setup();
    const value = { ...catalog(), bindings: { [COSTS_PAGE_SLOT]: 'example.costs/page' } };
    value.plugins[0]!.package.manifest.pages[0]!.slots = [];
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(value) });
    expect(runtime.errors).toEqual([]);
    expect(registry.getPage('example.costs/page')).not.toBeNull();
    expect(registry.selected(COSTS_PAGE_SLOT)).toMatchObject({ contributionId: 'example.costs/page', page: null });
  });

  it('selects an installed replacement and keeps it unavailable after removal', async () => {
    const { registry, modules } = setup();
    const value = { ...catalog(), bindings: { [COSTS_PAGE_SLOT]: 'example.costs/page' } };
    const runtime = await loadPluginCatalog(registry, modules, { fetch: fetchCatalog(value) });
    expect(registry.selected(COSTS_PAGE_SLOT).page?.contributionId).toBe('example.costs/page');
    runtime.dispose();
    expect(registry.selected(COSTS_PAGE_SLOT)).toMatchObject({ contributionId: 'example.costs/page', page: null });
  });

  it('does not register or evaluate external pages in safe mode', async () => {
    const { registry, modules } = setup();
    const importer = vi.fn();
    const runtime = await loadPluginCatalog(registry, modules, {
      fetch: fetchCatalog({ ...catalog(), safeMode: true, bindings: { [COSTS_PAGE_SLOT]: 'example.costs/page' } }), importModule: importer,
    });
    expect(runtime.safeMode).toBe(true);
    expect(runtime.errors).toEqual([]);
    expect(registry.getPage('example.costs/page')).toBeNull();
    expect(modules.get('example.costs/page')).toBeNull();
    expect(importer).not.toHaveBeenCalled();
    expect(registry.selected(COSTS_PAGE_SLOT)).toMatchObject({ contributionId: 'example.costs/page', page: null });
  });

  it.each(['fetch', 'json'] as const)('bounds a hung %s even if the transport ignores abort', async operation => {
    vi.useFakeTimers();
    const { registry, modules } = setup();
    const pending = deferred<Response>();
    const json = deferred<unknown>();
    const fetcher = vi.fn<typeof fetch>(() => operation === 'fetch' ? pending.promise
      : Promise.resolve({ ok: true, json: () => json.promise } as Response));
    const loading = loadPluginCatalog(registry, modules, { fetch: fetcher });
    await vi.advanceTimersByTimeAsync(5_000);
    const runtime = await loading;
    expect(runtime.safeMode).toBe(true);
    expect(runtime.errors).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(registry.getPage(COSTS_PAGE_ID)).not.toBeNull();
    pending.resolve(new Response(JSON.stringify(catalog())));
    json.resolve(catalog());
    await vi.runAllTimersAsync();
    expect(registry.getPage('example.costs/page')).toBeNull();
  });

  it.each([404, 500])('contains HTTP %s without disrupting builtins', async status => {
    const { registry, modules } = setup();
    const runtime = await loadPluginCatalog(registry, modules, {
      fetch: vi.fn<typeof fetch>(async () => new Response('Unavailable', { status })),
    });
    expect(runtime.safeMode).toBe(true);
    expect(runtime.errors).toHaveLength(1);
    expect(registry.getPage(COSTS_PAGE_ID)).not.toBeNull();
  });

  it('fails closed on a network outage so the host cannot substitute the builtin for an unknown persisted selection', async () => {
    const { registry, modules } = setup();
    const runtime = await loadPluginCatalog(registry, modules, {
      fetch: vi.fn<typeof fetch>(async () => { throw new TypeError('Network unavailable'); }),
    });
    expect(runtime.safeMode).toBe(true);
    expect(runtime.errors).toEqual(['Plugin catalog unavailable; optional pages were not loaded.']);
    expect(modules.get('example.costs/page')).toBeNull();
  });
});
