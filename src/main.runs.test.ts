import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, builtinPageSlots, RUNS_PAGE_SLOT } from './plugins/builtins';
import { appPageModules } from './plugins/builtin-modules';
import type { PluginPageContext, PluginPageState } from './plugins/sdk';

const disposers: (() => void)[] = []; const states: PluginPageState[] = []; let view: DashboardView | null = null;
const slot = 'helmsman/pr-compatibility-page'; const requests: string[] = [];
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
afterEach(() => { view?.destroy(); view = null; appPages.select(slot, null); appPages.select(RUNS_PAGE_SLOT, null); disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function register(target: string) {
  const id = target === slot ? 'example.authored-pr' : 'example.authored-runs';
  const contract = builtinPageSlots.find(item => item.id === target)?.panelContract;
  disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id, version: '1.0.0', panels: [], pages: [{ id: 'page', title: 'Authored page', slots: [target], panes: ['lookup', 'tasks'],
    composition: { id: target, version: 1, accepts: [{ id: contract!, version: 1 }] } }] }));
  disposers.push(appPageModules.register(`${id}/page`, { mount(container: HTMLElement, context: PluginPageContext) {
    states.push(context.state); container.textContent = 'Public replacement'; return { update(state: PluginPageState) { states.push(state); }, dispose() {} };
  } }));
  appPages.select(target, `${id}/page`);
}
async function start(path: string) { history.replaceState(null, '', path); const root = document.querySelector<HTMLElement>('#app')!; view = new DashboardView(root); await view.start(); await vi.waitFor(() => expect(states.length).toBeGreaterThan(0)); return root; }
it.each(['/prs', '/pr', '/runs'])('hands %s public PR and run locators to authored pages without reviving private data or streams', async path => {
  register(path === '/runs' ? RUNS_PAGE_SLOT : slot);
  const root = await start(`${path}?repo=org/a&prRepo=org/b&pr=42&mode=review&run=run-a&runRepo=org/b`);
  expect(states.at(-1)).toMatchObject({ repo: 'org/a', pullRequest: { version: 1, repo: 'org/b', number: 42, mode: 'review' },
    presentation: { version: 1, kind: 'run', repo: 'org/b', runId: 'run-a' } });
  expect(root.querySelector('.run-drawer')).toBeNull(); expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  expect(requests.some(path => ['/api/dashboard', '/api/pr', '/api/pr/diff', '/api/pr/review-requests', '/api/runs'].includes(path))).toBe(false);
});
it.each([false, true])('header scope changes retain only explicit public PR target state, override=%s', async explicit => {
  register(slot); const root = await start(`/prs?repo=org/a&pr=42${explicit ? '&prRepo=org/a' : ''}`);
  expect(states.at(-1)?.pullRequest?.repo).toBe('org/a');
  const header = root.querySelector<HTMLSelectElement>('.repo-select')!; header.value = 'org/b'; header.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(states.at(-1)?.repo).toBe('org/b'));
  expect(states.at(-1)?.pullRequest).toBeNull();
  const saved = states.at(-1)?.panelRouteState?.['helmsman.compat-pr/panel'];
  expect(Boolean(saved)).toBe(explicit);
});
it('shows unavailable when PR replacement is disabled without restoring legacy UI', async () => {
  register(slot); const root = await start('/prs?repo=org/a&pr=42'); disposers.splice(0).reverse().forEach(dispose => dispose());
  await vi.waitFor(() => expect(root.textContent).toContain('Page unavailable'));
  expect(root.querySelector('.pr-panel, .run-drawer')).toBeNull(); expect(requests).not.toContain('/api/pr');
});
