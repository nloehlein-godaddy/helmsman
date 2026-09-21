import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, builtinPageSlots } from './plugins/builtins';
import { appPageModules } from './plugins/builtin-modules';
import type { PluginManifest, PluginPageModule } from './plugins/sdk';

const taskSlots = builtinPageSlots.filter(slot => ['/todos', '/triage', '/bugs', '/source-settings'].includes(slot.alias));
const cleanup: (() => void)[] = [];
let view: DashboardView | null = null;
let jiraEnabled = true;
let requests: string[];
const states: { repo: string | null }[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); jiraEnabled = true; requests = []; states.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin); requests.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraEnabled, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/repo/local') return json({ repo: url.searchParams.get('repo'), path: '/repo', branches: [], worktrees: [], error: null });
    return new Response(null, { status: 404 });
  }));
  for (const slot of taskSlots) {
    const id = `example.shell-${slot.alias.slice(1)}`;
    const manifest: PluginManifest = { manifestVersion: 2, id, version: '1.0.0', sdkVersion: 1, pages: [{ id: 'page', title: `Authored ${slot.alias}`, slots: [slot.id], panes: [], composition: { id: slot.id, version: 1, accepts: [{ id: slot.panelContract!, version: 1 }] }, requires: [{ id: 'helmsman/composition', version: 1 }] }], panels: [] };
    const module: PluginPageModule = { mount(container, context) {
      const heading = document.createElement('h1'); heading.textContent = `Authored ${slot.alias}`;
      const draft = document.createElement('input'); draft.setAttribute('aria-label', 'Package draft'); container.replaceChildren(heading, draft); states.push(context.state);
      return { update(state) { states.push(state); }, refresh() {}, dispose() { container.replaceChildren(); } };
    } };
    cleanup.push(appPages.register(manifest), appPageModules.register(`${id}/page`, module)); appPages.select(slot.id, `${id}/page`);
  }
});
afterEach(() => {
  view?.destroy(); view = null; for (const slot of taskSlots) appPages.restoreSelection(slot.id, null);
  for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.unstubAllGlobals();
});
async function start(path: string) {
  window.history.replaceState(null, '', path); const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root); await view.start(); return root;
}

describe('task pages through the shared shell', () => {
  it.each(['/todos', '/triage', '/bugs', '/source-settings'])('mounts selected %s once, keeps package drafts through source changes and avoids legacy APIs', async path => {
    const root = await start(`${path}?repo=org/a`); await vi.waitFor(() => expect(root.textContent).toContain(`Authored ${path}`));
    const draft = root.querySelector<HTMLInputElement>('[aria-label="Package draft"]')!; draft.value = 'Keep plugin-owned draft'; draft.focus();
    jiraEnabled = false; await view!.refresh(); jiraEnabled = true; await view!.refresh();
    expect(root.querySelector('[aria-label="Package draft"]')).toBe(draft); expect(draft.value).toBe('Keep plugin-owned draft');
    expect(window.location.pathname).toBe(path); expect(window.location.search).toContain('repo=org%2Fa');
    expect(states.at(-1)?.repo).toBe('org/a');
    expect(requests.some(path => ['/api/todos', '/api/triage', '/api/bugs', '/api/task-sources'].includes(path))).toBe(false);
  });
  it('leaves a disabled selection unavailable without restoring task presentation or changing scope', async () => {
    const root = await start('/todos?repo=org/a'); await vi.waitFor(() => expect(root.textContent).toContain('Authored /todos'));
    appPages.unregister('example.shell-todos'); await vi.waitFor(() => expect(root.querySelector('[aria-label="Package draft"]')).toBeNull());
    expect(window.location.pathname).toBe('/todos'); expect(root.textContent).toContain('unavailable'); expect(requests).not.toContain('/api/todos');
  });
  it('keeps core configuration reachable and links source administration without mounting its retired controller', async () => {
    const root = await start('/config?repo=org/a');
    expect(root.querySelector('a[href="/source-settings?repo=org%2Fa"]')).not.toBeNull();
    expect(root.querySelector('[data-task-source-settings]')).toBeNull(); expect(requests).not.toContain('/api/task-sources'); expect(requests).toContain('/api/config');
  });
});
