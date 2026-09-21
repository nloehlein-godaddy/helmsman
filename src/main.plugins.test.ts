import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, builtinPageSlots, COSTS_PAGE_SLOT, HELM_PAGE_SLOT, RUN_HISTORY_PAGE_SLOT, RUN_VIEWER_PAGE_SLOT } from './plugins/builtins';
import { LOCAL_POLL_MS } from './data/live';
import { appPageModules } from './plugins/builtin-modules';
import type { PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from './plugins/sdk';

const contributionId = 'example.summary/page';
const path = `/plugins/${contributionId}?repo=org/a`;
const json = (value: unknown) => new Response(JSON.stringify(value));
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const disposers: (() => void)[] = [];
let view: DashboardView | undefined;

function register(module: PluginPageModule) {
  const removeManifest = appPages.register({ manifestVersion: 1, sdkVersion: 1, id: 'example.summary', version: '1.0.0',
    pages: [{ id: 'page', title: 'External summary', slots: [COSTS_PAGE_SLOT], panes: ['details'] }],
  });
  const removeModule = appPageModules.register(contributionId, module);
  disposers.push(removeManifest, removeModule);
  return { removeManifest, removeModule };
}

function sample() {
  const contexts: PluginPageContext[] = [];
  const states: PluginPageState[] = [];
  const dispose = vi.fn();
  const refresh = vi.fn();
  const mount = vi.fn((element: HTMLElement, context: PluginPageContext) => {
    contexts.push(context);
    states.push(context.state);
    element.textContent = `External summary for ${context.state.repo}`;
    return {
      update(next: PluginPageState) { states.push(next); element.textContent = `External summary for ${next.repo}`; },
      refresh, dispose,
    };
  });
  return { contexts, states, dispose, refresh, mount };
}

async function start() {
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
  await view.start();
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', path);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraEnabled: true, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/runs') return json({ runs: [], total: 0, limit: 25, offset: 0 });
    if (url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    return json({});
  }));
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  appPages.select(COSTS_PAGE_SLOT, null);
  appPages.select(HELM_PAGE_SLOT, null);
  appPages.select(RUN_HISTORY_PAGE_SLOT, null);
  appPages.select(RUN_VIEWER_PAGE_SLOT, null);
  disposers.splice(0).reverse().forEach(dispose => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('registered plugin page integration', () => {
  it.each([HELM_PAGE_SLOT, RUN_VIEWER_PAGE_SLOT, RUN_HISTORY_PAGE_SLOT, COSTS_PAGE_SLOT]
    .flatMap(slot => ['alias', 'canonical'].map(route => ({ slot, route }))))
  ('preserves panel-managed refresh for $slot through its $route route', async ({ slot, route }) => {
    vi.useFakeTimers();
    const plugin = sample();
    const definition = builtinPageSlots.find(item => item.id === slot)!;
    disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id: 'example.polling', version: '1.0.0', panels: [],
      pages: [{ id: 'page', title: 'Polling replacement', slots: [slot], panes: [],
        ...(definition.panelContract ? { composition: { id: slot, version: 1,
          accepts: [{ id: definition.panelContract, version: 1 }] } } : {}) }] }),
      appPageModules.register('example.polling/page', plugin));
    if (route === 'alias') appPages.select(slot, 'example.polling/page');
    window.history.replaceState(null, '', `${route === 'alias' ? definition.alias : '/plugins/example.polling/page'}?repo=org/a`);
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    const mounts = plugin.mount.mock.calls.length;
    expect(mounts).toBeGreaterThan(0);
    plugin.refresh.mockClear();
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(plugin.refresh).toHaveBeenCalledTimes(slot === COSTS_PAGE_SLOT ? 1 : 0);
    plugin.refresh.mockClear();
    await view.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.refresh).toHaveBeenCalledOnce();
    expect(plugin.mount).toHaveBeenCalledTimes(mounts);
  });

  it('opens a selected auxiliary viewer through typed selection while preserving header scope and page session', async () => {
    const plugin = sample(); register(plugin);
    const viewer = sample();
    disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id: 'example.viewer', version: '1.0.0', panels: [],
      pages: [{ id: 'page', title: 'Viewer', slots: [RUN_VIEWER_PAGE_SLOT], panes: [],
        composition: { id: RUN_VIEWER_PAGE_SLOT, version: 1, accepts: [{ id: 'helmsman/run-viewer-panel', version: 1 }] } }] }),
      appPageModules.register('example.viewer/page', viewer));
    appPages.select(RUN_VIEWER_PAGE_SLOT, 'example.viewer/page');
    await start();
    plugin.contexts[0]?.selectPresentation?.({ version: 1, kind: 'run', repo: 'org/a', runId: 'run-1' });
    await vi.waitFor(() => expect(viewer.states.at(-1)).toMatchObject({ visible: true, repo: 'org/a', presentation: { kind: 'run', runId: 'run-1' } }));
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    expect(window.location.pathname).toBe('/plugins/example.summary/page');
    expect(new URL(window.location.href).searchParams.get('run')).toBe('run-1');
    expect(plugin.mount).toHaveBeenCalledOnce();
    expect(viewer.mount).toHaveBeenCalledOnce();
    expect(document.querySelector('.plugin-auxiliary-slot [data-plugin-page]')).not.toBeNull();
    plugin.contexts[0]?.selectPresentation?.(null);
    await vi.waitFor(() => expect(viewer.states.at(-1)?.visible).toBe(false));
    expect(new URL(window.location.href).searchParams.has('run')).toBe(false);
    expect(viewer.dispose).not.toHaveBeenCalled();
  });

  it('mounts an independent module and updates header scope, terminology, and visibility without remounting', async () => {
    const plugin = sample();
    register(plugin);
    await start();
    expect(plugin.mount).toHaveBeenCalledOnce();
    expect(document.querySelector('#page-content')?.textContent).toBe('External summary for org/a');
    expect(document.title).toBe('External summary · Helmsman');
    expect(document.querySelector('#page-tab-plugin')?.getAttribute('aria-selected')).toBe('true');
    const header = document.querySelector('.helm-head');
    const scope = document.querySelector<HTMLSelectElement>('.repo-select')!;
    scope.value = 'org/b';
    scope.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(plugin.states.at(-1)?.repo).toBe('org/b'));
    expect(document.querySelector('#page-content')?.textContent).toBe('External summary for org/b');
    expect(window.location.pathname).toBe(`/plugins/${contributionId}`);
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/b');
    document.querySelector<HTMLButtonElement>('[data-pirate-mode]')?.click();
    await vi.waitFor(() => expect(plugin.states.at(-1)?.pirateMode).toBe(false));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(plugin.states.at(-1)?.visible).toBe(false));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(plugin.states.at(-1)?.visible).toBe(true));
    expect(document.querySelector('.helm-head')).toBe(header);
    expect(plugin.mount).toHaveBeenCalledOnce();
    expect(plugin.dispose).not.toHaveBeenCalled();
  });

  it('forwards the host theme-change event to the mounted module', async () => {
    const plugin = sample();
    register(plugin);
    await start();
    const control = document.createElement('select');
    control.className = 'theme-select';
    control.innerHTML = '<option value="abyss">Abyss</option>';
    document.querySelector('.helm-head')?.append(control);
    control.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(plugin.states.at(-1)?.themeId).toBe('abyss'));
    expect(plugin.mount).toHaveBeenCalledOnce();
  });

  it.each(['metadata', 'module'] as const)('disposes when its %s registration is removed and can mount a replacement', async removal => {
    const plugin = sample();
    const registered = register(plugin);
    await start();
    if (removal === 'metadata') registered.removeManifest();
    else registered.removeModule();
    await vi.waitFor(() => expect(plugin.dispose).toHaveBeenCalledOnce());
    expect(plugin.contexts[0]?.signal.aborted).toBe(true);
    expect(document.querySelector('#page-content')?.textContent).toContain('Page unavailable');
    expect(window.location.pathname).toBe(`/plugins/${contributionId}`);
    if (removal === 'module') {
      const replacement = sample();
      disposers.push(appPageModules.register(contributionId, replacement));
      await vi.waitFor(() => expect(replacement.mount).toHaveBeenCalledOnce());
      expect(document.querySelector('#page-content')?.textContent).toBe('External summary for org/a');
    }
  });

  it('disposes on navigation and stops accepting navigation from a stale context', async () => {
    const plugin = sample();
    register(plugin);
    await start();
    const context = plugin.contexts[0];
    context?.navigate('https://external.example/runs');
    context?.navigate('/api/config');
    expect(window.location.pathname).toBe(`/plugins/${contributionId}`);
    context?.navigate('/runs?repo=org/b');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/runs'));
    expect(plugin.dispose).toHaveBeenCalledOnce();
    expect(context?.signal.aborted).toBe(true);
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    context?.navigate(path);
    await settle();
    expect(window.location.pathname).toBe('/runs');
  });

  it('keeps the selected alias route while replacing its provider module', async () => {
    const plugin = sample();
    register(plugin);
    appPages.select(COSTS_PAGE_SLOT, contributionId);
    window.history.replaceState(null, '', '/outcomes?repo=org/a&pane=details');
    await start();
    expect(plugin.states[0]?.pane).toBe('details');
    expect(window.location.pathname).toBe('/outcomes');
    expect(document.querySelector('#page-tab-outcomes')?.textContent).toBe('External summary');
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/outcomes'))).toBe(false);
  });

  it('disposes a mount that completes after navigation and leaves the active page intact', async () => {
    let finish!: (instance: PluginPageInstance) => void;
    const pending = new Promise<PluginPageInstance>(resolve => { finish = resolve; });
    let context: PluginPageContext | undefined;
    let element: HTMLElement | undefined;
    register({ mount(node, supplied) { context = supplied; element = node; return pending; } });
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    const starting = view.start();
    await vi.waitFor(() => expect(context).toBeDefined());
    document.querySelector<HTMLAnchorElement>('#page-tab-runs')?.click();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/runs'));
    expect(context?.signal.aborted).toBe(true);
    const started = vi.fn();
    void starting.then(started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const dispose = vi.fn();
    finish({ update() {}, dispose });
    await starting;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    if (element) element.textContent = 'Late plugin content';
    expect(document.querySelector('.helm')?.getAttribute('data-page')).toBe('runs');
    expect(document.querySelector('#page-content')?.textContent).not.toContain('Late plugin content');
  });
});
