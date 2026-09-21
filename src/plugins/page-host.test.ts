import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginPageHost } from './page-host';
import type { PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from './sdk';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const state = (overrides: Partial<PluginPageState> = {}): PluginPageState => ({
  repo: 'org/first', themeId: 'default', pirateMode: true, visible: true, pane: null, ...overrides,
});
const lifecycle = (): PluginPageInstance => ({ update: vi.fn(), refresh: vi.fn(), dispose: vi.fn() });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const hosts: PluginPageHost[] = [];

function setup() {
  const root = document.createElement('div');
  const sibling = document.createElement('p');
  sibling.textContent = 'Shell navigation';
  const container = document.createElement('main');
  root.append(sibling, container);
  document.body.append(root);
  const navigate = vi.fn();
  const host = new PluginPageHost(container, {
    navigate, loadingMessage: () => 'Loading scope', errorMessage: () => 'Page failed',
  });
  hosts.push(host);
  return { host, root, sibling, container, navigate };
}

afterEach(() => {
  hosts.splice(0).forEach(host => host.dispose());
  document.body.replaceChildren();
});

describe('plugin page host', () => {
  it('provides required task reads and revokes old scope calls immediately on scope change, suspension and disposal', async () => {
    const stalled = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => stalled.promise).mockImplementation(async path => {
      return new Response(JSON.stringify(String(path) === '/api/context' ? { repos: ['org/first', 'org/second'] } : { instances: [] }));
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const { host } = setup(); let context!: PluginPageContext;
      const module = { mount(_element: HTMLElement, supplied: PluginPageContext) { context = supplied; return lifecycle(); } };
      host.show('example.tasks/page', module, state()); await settle();
      const tasks = context.services?.tasks; expect(tasks).toBeDefined();
      const pending = tasks!.discover(); const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const priorSignal = fetcher.mock.calls[0]?.[1]?.signal;
      host.show('example.tasks/page', module, state({ repo: 'org/second' }));
      expect(priorSignal?.aborted).toBe(true); expect(context.signal.aborted).toBe(false); await aborted;
      expect(await tasks!.discover()).toMatchObject({ status: 'available', value: { repo: 'org/second', galleons: [{ repo: 'org/second' }] } });
      expect(fetcher.mock.calls.some(([path]) => String(path).includes('repo=org%2Ffirst'))).toBe(false);
      const calls = fetcher.mock.calls.length;
      host.show('example.tasks/page', module, state({ repo: 'org/second', visible: false }));
      await expect(tasks!.discover()).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(calls);
      host.dispose(); await expect(tasks!.discover()).rejects.toMatchObject({ name: 'AbortError' });
      stalled.resolve(new Response('{"repos":["org/first"]}'));
    } finally { vi.unstubAllGlobals(); }
  });

  it('delivers route-only changes and retains mounting for equivalent route values', async () => {
    const { host } = setup();
    const instance = lifecycle();
    const module = { mount: vi.fn(() => instance) };
    const initial = state({ panelInstance: 'first', panelRouteState: {
      'example.panel/panel': { version: 1, value: { locator: 'A' } },
    } });
    host.show('example.page/page', module, initial); await settle();
    host.show('example.page/page', module, structuredClone(initial)); await settle();
    expect(instance.update).not.toHaveBeenCalled();
    const next = state({ panelInstance: 'first', panelRouteState: {
      'example.panel/panel': { version: 1, value: { locator: 'B' } },
    } });
    host.show('example.page/page', module, next); await settle();
    expect(instance.update).toHaveBeenCalledExactlyOnceWith(next);
    expect(module.mount).toHaveBeenCalledOnce();
  });

  it('keeps a stable module mounted for equivalent state and updates immutable snapshots', async () => {
    const { host } = setup();
    const instance = lifecycle();
    let context: PluginPageContext | undefined;
    const module = { mount: vi.fn((_element: HTMLElement, supplied: PluginPageContext) => {
      context = supplied;
      return instance;
    }) };
    const initial = state();
    host.show('example.costs/page', module, initial);
    await settle();
    host.show('example.costs/page', module, { ...initial });
    await settle();
    expect(module.mount).toHaveBeenCalledOnce();
    expect(instance.update).not.toHaveBeenCalled();
    expect(context?.state).not.toBe(initial);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.state)).toBe(true);
    const next = state({ themeId: 'dark', pane: 'history', pirateMode: false });
    host.show('example.costs/page', module, next);
    await settle();
    expect(instance.update).toHaveBeenCalledExactlyOnceWith(next);
    const supplied = vi.mocked(instance.update).mock.calls[0]?.[0];
    expect(supplied).not.toBe(next);
    expect(Object.isFrozen(supplied)).toBe(true);
    expect(context?.state).toEqual(initial);
    expect(instance.dispose).not.toHaveBeenCalled();
  });

  it.each(['replacement', 'dispose'] as const)('disposes late mounts after %s and isolates their elements', async action => {
    const { host, container, sibling } = setup();
    const pending = deferred<PluginPageInstance>();
    let staleElement: HTMLElement | undefined;
    let context: PluginPageContext | undefined;
    host.show('example.costs/page', { mount(element, supplied) {
      staleElement = element;
      context = supplied;
      return pending.promise;
    } }, state());
    if (action === 'replacement') {
      host.show('example.costs/page', { mount(element) {
        element.textContent = 'Replacement';
        return lifecycle();
      } }, state());
    } else host.dispose();
    expect(context?.signal.aborted).toBe(true);
    const late = lifecycle();
    pending.resolve(late);
    await settle();
    expect(late.dispose).toHaveBeenCalledOnce();
    if (staleElement) staleElement.textContent = 'Stale module';
    expect(container.textContent).toBe(action === 'replacement' ? 'Replacement' : '');
    expect(sibling.textContent).toBe('Shell navigation');
    host.dispose();
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it('revokes navigation and immediately releases cleanup registered after disposal', async () => {
    const { host, navigate } = setup();
    let context: PluginPageContext | undefined;
    host.show('example.costs/page', { mount(_element, supplied) { context = supplied; return lifecycle(); } }, state());
    await settle();
    context?.navigate('/helm');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/helm');
    host.dispose();
    context?.navigate('/outcomes');
    expect(navigate).toHaveBeenCalledOnce();
    const cleanup = vi.fn();
    context?.onDispose(cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('ignores a superseded mount rejection and runs its cleanup only once', async () => {
    const { host, container } = setup();
    const pending = deferred<PluginPageInstance>();
    const cleanup = vi.fn();
    host.show('example.costs/page', { mount(_element, context) {
      context.onDispose(cleanup);
      return pending.promise;
    } }, state());
    host.show('example.other/page', { mount(element) { element.textContent = 'Current'; return lifecycle(); } }, state());
    pending.reject(new Error('late failure'));
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('Current');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([null, undefined, {}, { update() {} }, { update() {}, dispose() {}, refresh: true }])('contains invalid returned lifecycle %j', async invalid => {
    const { host, container } = setup();
    const cleanup = vi.fn();
    host.show('example.costs/page', { mount(_element, context) {
      context.onDispose(cleanup);
      return invalid as unknown as PluginPageInstance;
    } }, state());
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Page failed');
  });

  it.each(['mount', 'update', 'refresh'] as const)('contains a thrown %s failure and cleans up its lifetime', async operation => {
    const { host, container, sibling } = setup();
    const cleanup = vi.fn();
    const instance = lifecycle();
    let context: PluginPageContext | undefined;
    const fail = () => { throw new Error('plugin failure'); };
    if (operation === 'update') instance.update = fail;
    if (operation === 'refresh') instance.refresh = fail;
    const module: PluginPageModule = { mount(_element, supplied) {
      context = supplied;
      supplied.onDispose(cleanup);
      if (operation === 'mount') fail();
      return instance;
    } };
    host.show('example.costs/page', module, state());
    await settle();
    if (operation === 'update') host.show('example.costs/page', module, state({ pane: 'history' }));
    if (operation === 'refresh') await host.refresh();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Page failed');
    expect(context?.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sibling.textContent).toBe('Shell navigation');
    if (operation !== 'mount') expect(instance.dispose).toHaveBeenCalledOnce();
    host.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(['mount', 'update', 'refresh'] as const)('contains a rejected %s failure and remains usable', async operation => {
    const { host, container } = setup();
    const pending = deferred<PluginPageInstance>();
    const instance = lifecycle();
    let context: PluginPageContext | undefined;
    const cleanup = vi.fn();
    if (operation === 'update') instance.update = () => pending.promise.then(() => {});
    if (operation === 'refresh') instance.refresh = () => pending.promise.then(() => {});
    const module: PluginPageModule = { mount(_element, supplied) {
      context = supplied;
      supplied.onDispose(cleanup);
      return operation === 'mount' ? pending.promise : instance;
    } };
    host.show('example.costs/page', module, state());
    await settle();
    if (operation === 'update') host.show('example.costs/page', module, state({ pane: 'history' }));
    const refresh = operation === 'refresh' ? host.refresh() : Promise.resolve();
    await settle();
    pending.reject(new Error('rejected plugin lifecycle'));
    await refresh;
    await settle();
    expect(context?.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Page failed');
    host.show('example.other/page', { mount(element) { element.textContent = 'Recovered'; return lifecycle(); } }, state());
    await settle();
    expect(container.textContent).toBe('Recovered');
  });

  it('runs every cleanup even if another cleanup or instance disposal throws', async () => {
    const { host } = setup();
    const first = vi.fn();
    const broken = vi.fn(() => { throw new Error('cleanup failed'); });
    const last = vi.fn();
    const instance = lifecycle();
    instance.dispose = vi.fn(() => { throw new Error('dispose failed'); });
    host.show('example.costs/page', { mount(_element, context) {
      context.onDispose(first);
      context.onDispose(broken);
      context.onDispose(last);
      return instance;
    } }, state());
    await settle();
    expect(() => host.dispose()).not.toThrow();
    host.dispose();
    for (const cleanup of [first, broken, last, instance.dispose]) expect(cleanup).toHaveBeenCalledOnce();
  });

  it('coalesces refreshes during mount and while a refresh remains pending', async () => {
    const { host } = setup();
    const mounting = deferred<PluginPageInstance>();
    const refreshing = deferred<void>();
    const instance = lifecycle();
    instance.refresh = vi.fn(() => refreshing.promise);
    host.show('example.costs/page', { mount: () => mounting.promise }, state());
    const first = host.refresh();
    const second = host.refresh();
    expect(instance.refresh).not.toHaveBeenCalled();
    mounting.resolve(instance);
    await settle();
    const third = host.refresh();
    const thirdSettled = vi.fn();
    void third.then(thirdSettled);
    await settle();
    expect(thirdSettled).not.toHaveBeenCalled();
    expect(instance.refresh).toHaveBeenCalledOnce();
    refreshing.resolve();
    await Promise.all([first, second, third]);
    await host.refresh();
    expect(instance.refresh).toHaveBeenCalledTimes(2);
  });

  it('contains rejected disposal without affecting the replacement', async () => {
    const { host, container } = setup();
    const pending = deferred<void>();
    const instance = lifecycle();
    instance.dispose = () => pending.promise;
    host.show('example.costs/page', { mount: () => instance }, state());
    await settle();
    host.show('example.other/page', { mount(element) { element.textContent = 'Current'; return lifecycle(); } }, state());
    pending.reject(new Error('failed disposal'));
    await settle();
    expect(container.textContent).toBe('Current');
  });

  it.each(['mount', 'update', 'refresh'] as const)('releases refresh callers when disposed during a pending %s', async operation => {
    const { host } = setup();
    const pending = deferred<PluginPageInstance>();
    const instance = lifecycle();
    if (operation === 'update') instance.update = () => pending.promise.then(() => {});
    if (operation === 'refresh') instance.refresh = () => pending.promise.then(() => {});
    const module = { mount: () => operation === 'mount' ? pending.promise : instance };
    host.show('example.costs/page', module, state());
    await settle();
    if (operation === 'update') host.show('example.costs/page', module, state({ repo: 'org/second' }));
    const completed = vi.fn();
    void host.refresh().then(completed);
    await settle();
    expect(completed).not.toHaveBeenCalled();
    host.dispose();
    await settle();
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(['mount', 'update', 'refresh'] as const)('releases refresh callers when replaced during a pending %s', async operation => {
    const { host, container } = setup();
    const pending = deferred<PluginPageInstance>();
    const instance = lifecycle();
    if (operation === 'update') instance.update = () => pending.promise.then(() => {});
    if (operation === 'refresh') instance.refresh = () => pending.promise.then(() => {});
    const module = { mount: () => operation === 'mount' ? pending.promise : instance };
    host.show('example.costs/page', module, state());
    await settle();
    if (operation === 'update') host.show('example.costs/page', module, state({ repo: 'org/second' }));
    const completed = vi.fn();
    void host.refresh().then(completed);
    await settle();
    expect(completed).not.toHaveBeenCalled();
    host.show('example.other/page', { mount(element) { element.textContent = 'Current'; return lifecycle(); } }, state());
    await settle();
    expect(completed).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('Current');
    pending.resolve(instance);
    await settle();
    expect(instance.dispose).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('Current');
  });

  it('contains asynchronous cleanup rejections and continues releasing resources', async () => {
    const { host } = setup();
    const pending = deferred<void>();
    const cleanup = vi.fn(() => pending.promise);
    const siblingCleanup = vi.fn();
    const instance = lifecycle();
    host.show('example.costs/page', { mount(_element, context) {
      context.onDispose(siblingCleanup);
      context.onDispose(cleanup);
      return instance;
    } }, state());
    await settle();
    host.dispose();
    pending.reject(new Error('asynchronous cleanup failure'));
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(siblingCleanup).toHaveBeenCalledOnce();
    expect(instance.dispose).toHaveBeenCalledOnce();
  });

  it('suppresses refresh while hidden, including visibility changes during mount', async () => {
    const { host } = setup();
    const mounting = deferred<PluginPageInstance>();
    const instance = lifecycle();
    const module = { mount: () => mounting.promise };
    host.show('example.costs/page', module, state());
    const pending = host.refresh();
    host.show('example.costs/page', module, state({ visible: false }));
    mounting.resolve(instance);
    await pending;
    await host.refresh();
    expect(instance.refresh).not.toHaveBeenCalled();
    expect(instance.update).toHaveBeenCalledWith(state({ visible: false }));
    host.show('example.costs/page', module, state());
    await host.refresh();
    expect(instance.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the old subtree hidden while an asynchronous scope update is pending', async () => {
    const { host, container } = setup();
    const updating = deferred<void>();
    const module: PluginPageModule = { mount(element, context) {
      element.textContent = context.state.repo;
      return { async update(next) { await updating.promise; element.textContent = next.repo; }, dispose() {} };
    } };
    host.show('example.costs/page', module, state());
    await settle();
    host.show('example.costs/page', module, state({ repo: 'org/second' }));
    expect(container.textContent).toBe('Loading scope');
    expect(container.getAttribute('aria-busy')).toBe('true');
    updating.resolve();
    await settle();
    expect(container.textContent).toBe('org/second');
    expect(container.hasAttribute('aria-busy')).toBe(false);
  });

  it('updates scope promptly while an older refresh remains pending', async () => {
    const { host, container } = setup();
    const refreshing = deferred<void>();
    const module: PluginPageModule = { mount(element, context) {
      let current = context.state;
      element.textContent = current.repo;
      return {
        update(next) { current = next; element.textContent = next.repo; },
        async refresh() {
          const snapshot = current;
          await refreshing.promise;
          if (current === snapshot) element.textContent = snapshot.repo;
        },
        dispose() {},
      };
    } };
    host.show('example.costs/page', module, state());
    await settle();
    const pending = host.refresh();
    await settle();
    host.show('example.costs/page', module, state({ repo: 'org/second' }));
    await settle();
    expect(container.textContent).toBe('org/second');
    refreshing.resolve();
    await pending;
    await settle();
    expect(container.textContent).toBe('org/second');
  });

  it('serializes pending updates and keeps intermediate scopes detached', async () => {
    const { host, container } = setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const update = vi.fn();
    const module: PluginPageModule = { mount(element, context) {
      element.textContent = context.state.repo;
      return { async update(next) {
        update(next);
        await (next.repo === 'org/second' ? first.promise : second.promise);
        element.textContent = next.repo;
      }, dispose() {} };
    } };
    host.show('example.costs/page', module, state());
    await settle();
    host.show('example.costs/page', module, state({ repo: 'org/second' }));
    host.show('example.costs/page', module, state({ repo: 'org/third' }));
    expect(update).toHaveBeenCalledOnce();
    first.resolve();
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Loading scope');
    second.resolve();
    await settle();
    expect(container.textContent).toBe('org/third');
  });

  it('applies a scope revision arriving between an update and its promise cleanup', async () => {
    const { host, container } = setup();
    const update = vi.fn();
    const module: PluginPageModule = { mount(element, context) {
      element.textContent = context.state.repo;
      return { update(next) { update(next); element.textContent = next.repo; }, dispose() {} };
    } };
    host.show('example.costs/page', module, state());
    await settle();
    host.show('example.costs/page', module, state({ repo: 'org/second' }));
    queueMicrotask(() => host.show('example.costs/page', module, state({ repo: 'org/third' })));
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('org/third');
    expect(container.hasAttribute('aria-busy')).toBe(false);
  });
});
