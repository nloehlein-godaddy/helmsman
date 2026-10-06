import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, builtinPageSlots } from './plugins/builtins';
import { appPageModules } from './plugins/builtin-modules';
import type { PluginPageContext, PluginPageState } from './plugins/sdk';

const disposers: (() => void)[] = []; const states: PluginPageState[] = []; let view: DashboardView | null = null;
const slot = 'helmsman/local-git-page'; const requests: string[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value));
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); states.length = 0; requests.length = 0;
  vi.stubGlobal('EventSource', class { constructor() { throw new Error('Legacy streams must be retired'); } });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const path = new URL(String(input), window.location.origin).pathname; requests.push(path);
    if (path === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null });
    if (path === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (path === '/api/config') return json({ config: {}, overridden: [] });
    return new Response('{}', { status: 503 });
  }));
});
afterEach(() => { view?.destroy(); view = null; appPages.select(slot, null); disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function register() {
  const id = 'example.authored-local-git';
  const contract = builtinPageSlots.find(item => item.id === slot)?.panelContract;
  disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id, version: '1.0.0', panels: [], pages: [{ id: 'page', title: 'Local Git', slots: [slot], panes: [],
    composition: { id: slot, version: 1, accepts: [{ id: contract!, version: 1 }] } }] }));
  disposers.push(appPageModules.register(`${id}/page`, { mount(container: HTMLElement, context: PluginPageContext) {
    states.push(context.state); container.textContent = 'Public replacement'; return { update(state: PluginPageState) { states.push(state); }, dispose() {} };
  } }));
  appPages.select(slot, `${id}/page`);
}
async function start(path: string) { history.replaceState(null, '', path); const root = document.querySelector<HTMLElement>('#app')!; view = new DashboardView(root); await view.start(); await vi.waitFor(() => expect(states.length).toBeGreaterThan(0)); return root; }
it.each(['/local-git?repo=org/a', '/config?repo=org/a&pane=local-git'])('opens %s through the selected plugin and preserves scope', async path => {
  register(); const root = await start(path);
  expect(states.at(-1)?.repo).toBe('org/a');
  expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  expect(requests).not.toContain('/api/repo/local');
  const header = root.querySelector<HTMLSelectElement>('.repo-select')!;
  header.value = 'org/b'; header.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(states.at(-1)?.repo).toBe('org/b'));
});
it('keeps a disabled Local Git selection unavailable without restoring shell controls', async () => {
  register(); const root = await start('/local-git?repo=org/a');
  disposers.splice(0).reverse().forEach(dispose => dispose());
  await vi.waitFor(() => expect(root.textContent).toContain('Page unavailable'));
  expect(root.querySelector('.local-git-panel')).toBeNull();
  expect(requests).not.toContain('/api/repo/local');
});
it('Config section navigation links to Local Git without reading the legacy endpoint', async () => {
  history.replaceState(null, '', '/config?repo=org/a');
  const root = document.querySelector<HTMLElement>('#app')!; view = new DashboardView(root); await view.start();
  await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('.section-nav a[href="/local-git?repo=org%2Fa"]')?.textContent).toBe('Local Git'));
  expect(root.querySelector('#page-content a[href="/local-git?repo=org%2Fa"]')).toBeNull();
  expect(requests).not.toContain('/api/repo/local');
});
