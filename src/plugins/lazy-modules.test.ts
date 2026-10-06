import { describe, expect, it, vi } from 'vitest';
import { lazyPageModule, lazyPanelModule } from './lazy-modules';
import type { PluginPageContext, PluginPageModule } from './sdk';
import type { PluginPanelContext } from './composition';
import { createHostPageServices } from './host-services';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function context(signal = new AbortController().signal): PluginPageContext {
  return { state: { repo: null, themeId: 'default', pirateMode: false, visible: true, pane: null },
    signal, navigate: vi.fn(), onDispose: vi.fn() };
}

describe('lazy page modules', () => {
  it('loads only on mount, shares concurrent imports and retains each mount context and receiver', async () => {
    const imported = deferred<{ default: PluginPageModule }>();
    const load = vi.fn(() => imported.promise);
    const lazy = lazyPageModule(load);
    expect(load).not.toHaveBeenCalled();
    expect(lazy.attention).toBeUndefined();
    const first = context(); const second = context();
    const container = document.createElement('div');
    const pending = [lazy.mount(container, first), lazy.mount(container, second)];
    const instance = { update: vi.fn(), dispose: vi.fn() };
    const implementation = { mount: vi.fn(function (this: PluginPageModule) {
      expect(this).toBe(implementation); return instance;
    }) };
    imported.resolve({ default: implementation });
    expect(await Promise.all(pending)).toEqual([instance, instance]);
    expect(load).toHaveBeenCalledOnce();
    expect(implementation.mount).toHaveBeenNthCalledWith(1, container, first);
    expect(implementation.mount).toHaveBeenNthCalledWith(2, container, second);
    await lazy.mount(container, context());
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not import an aborted mount or mount an import resolved after disposal', async () => {
    const imported = deferred<{ default: PluginPageModule }>();
    const load = vi.fn(() => imported.promise);
    const lazy = lazyPageModule(load);
    const controller = new AbortController(); controller.abort();
    await expect(lazy.mount(document.createElement('div'), context(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = lazy.mount(document.createElement('div'), context(active.signal));
    active.abort();
    const mount = vi.fn(() => ({ update() {}, dispose() {} }));
    imported.resolve({ default: { mount } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mount).not.toHaveBeenCalled();
    await lazy.mount(document.createElement('div'), context());
    expect(load).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
  });

  it('retries a failed import on a later mount', async () => {
    const mount = vi.fn(() => ({ update() {}, dispose() {} }));
    const load = vi.fn<() => Promise<{ default: PluginPageModule }>>()
      .mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ default: { mount } });
    const lazy = lazyPageModule(load);
    await expect(lazy.mount(document.createElement('div'), context())).rejects.toThrow('Offline');
    await lazy.mount(document.createElement('div'), context());
    expect(load).toHaveBeenCalledTimes(2);
    expect(mount).toHaveBeenCalledOnce();
  });

  it('allows background attention without loading the page implementation', async () => {
    const load = vi.fn(async () => ({ default: { mount: vi.fn(() => ({ update() {}, dispose() {} })) } }));
    const attention = vi.fn(() => ({ version: 1 as const, keys: ['question'] }));
    const lazy = lazyPageModule(load, attention);
    const signal = new AbortController().signal;
    await expect(lazy.attention?.({ contributionId: 'example.questions/page', repo: null, signal,
      services: createHostPageServices(signal) })).toEqual({ version: 1, keys: ['question'] });
    expect(load).not.toHaveBeenCalled();
  });
});

it('shares panel imports while preventing an abandoned panel mount from executing', async () => {
  const mount = vi.fn((_container: HTMLElement, _context: PluginPanelContext) => ({ update() {}, dispose() {} }));
  const imported = deferred<{ default: { mount: typeof mount } }>();
  const load = vi.fn(() => imported.promise);
  const lazy = lazyPanelModule(load);
  const controller = new AbortController();
  const pageContext = context(controller.signal);
  const activity = { epoch: 0, signal: controller.signal, active: true, repo: null };
  const panelContext: PluginPanelContext = { ...pageContext, state: { ...pageContext.state, headerRepo: null,
    instanceId: 'panel-1', savedState: null, activity }, activity, services: { version: 1 }, saveState: vi.fn() };
  expect(load).not.toHaveBeenCalled();
  const abandoned = lazy.mount(document.createElement('div'), panelContext);
  controller.abort();
  const activeContext = { ...panelContext, signal: new AbortController().signal };
  const active = lazy.mount(document.createElement('div'), activeContext);
  imported.resolve({ default: { mount } });
  await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
  await active;
  expect(load).toHaveBeenCalledOnce();
  expect(mount).toHaveBeenCalledOnce();
  expect(mount.mock.calls[0]?.[1]).toBe(activeContext);
});
