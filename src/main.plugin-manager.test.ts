import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';

const manager = vi.hoisted(() => ({ dispose: vi.fn(), updateScope: vi.fn(), mount: vi.fn() }));
vi.mock('./plugin-manager', () => ({ mountPluginManager: manager.mount }));
let view: DashboardView | null = null;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  manager.dispose.mockClear(); manager.updateScope.mockClear();
  manager.mount.mockReset().mockImplementation((container: HTMLElement) => {
    container.innerHTML = '<h1>Plugins</h1><input aria-label="Search plugins">';
    return { dispose: manager.dispose, updateScope: manager.updateScope };
  });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/api/config') return new Response('{}', { status: 503 });
    const value = path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : {};
    return new Response(JSON.stringify(value));
  }));
});
afterEach(() => { view?.destroy(); view = null; vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('opens Plugins when configuration is unavailable and preserves its state through header scope changes', async () => {
  history.replaceState(null, '', '/config?repo=org/a&pane=plugins');
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root); await view.start();
  expect(manager.mount).toHaveBeenCalledOnce();
  expect(document.title).toContain('Plugins');
  expect(root.querySelector('.section-nav [aria-current="page"]')?.textContent).toBe('Plugins');
  const search = root.querySelector<HTMLInputElement>('[aria-label="Search plugins"]')!;
  search.value = 'jira';
  const scope = root.querySelector<HTMLSelectElement>('.repo-select')!;
  scope.value = 'org/b'; scope.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(manager.updateScope).toHaveBeenLastCalledWith('org/b'));
  expect(manager.mount).toHaveBeenCalledOnce();
  expect(search.isConnected).toBe(true);
  expect(search.value).toBe('jira');
  root.querySelector<HTMLAnchorElement>('[data-section-link="overview"]')!.click();
  await vi.waitFor(() => expect(manager.dispose).toHaveBeenCalledOnce());
  expect(root.querySelector('[data-plugin-manager-host]')).toBeNull();
  expect(window.location.search).toBe('?repo=org%2Fb');
});

it('disposes the core manager when the application is destroyed', async () => {
  history.replaceState(null, '', '/config?repo=&pane=plugins');
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start();
  view.destroy(); view = null;
  expect(manager.dispose).toHaveBeenCalledOnce();
});
