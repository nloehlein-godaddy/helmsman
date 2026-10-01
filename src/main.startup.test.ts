import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { saveRepoScope } from './logic/prefs';

let view: DashboardView | undefined;
let repos = ['org/a', 'org/b'];
let requests: string[] = [];
beforeEach(() => {
  localStorage.clear(); document.body.innerHTML = '<div id="app"></div>'; repos = ['org/a', 'org/b']; requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname; requests.push(path);
    const value = path === '/api/context' ? { repos, jiraBaseUrl: null }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/config' ? { config: {}, overridden: [] } : null;
    return value ? new Response(JSON.stringify(value)) : new Response(null, { status: 404 });
  }));
});
afterEach(() => { view?.destroy(); view = undefined; localStorage.clear(); vi.unstubAllGlobals(); });
function start(path = '/config') {
  window.history.replaceState(null, '', path);
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root); return { root, started: view.start() };
}
async function choose(root: HTMLElement, repo = 'org/b') {
  await vi.waitFor(() => expect(root.querySelector('[name="startupRepo"]')).not.toBeNull());
  const select = root.querySelector<HTMLSelectElement>('[name="startupRepo"]')!; select.value = repo;
  select.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
describe('startup header scope', () => {
  it('waits for an explicit selection before loading scoped pages or application data', async () => {
    const { root, started } = start();
    await vi.waitFor(() => expect(root.querySelector('.startup-scope')).not.toBeNull());
    expect(requests).toEqual(['/api/context']); expect(root.querySelector('.repo-select')).toBeNull();
    expect(root.querySelector<HTMLSelectElement>('[name="startupRepo"]')?.value).toBe('');
    await choose(root); await started;
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    expect(window.location.search).toBe('?repo=org%2Fb'); expect(localStorage.getItem('runner.repoScope')).toBe('org/b');
  });
  it('restores the previous scope when the URL has none', async () => {
    saveRepoScope('org/a'); const { root, started } = start(); await started;
    expect(root.querySelector('.startup-scope')).toBeNull(); expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });
  it('honors the URL scope ahead of the previous scope', async () => {
    saveRepoScope('org/a'); const { root, started } = start('/config?repo=org/b'); await started;
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
  });
  it('applies the restored scope before parsing a PR deep link', async () => {
    saveRepoScope('org/a'); const { started } = start('/prs?pr=42'); await started;
    expect(new URL(window.location.href).searchParams.get('pr')).toBe('42');
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/a');
  });
  it('requires a fresh choice if the previous scope is no longer configured', async () => {
    saveRepoScope('org/removed'); const { root, started } = start(); await choose(root, 'org/a'); await started;
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });
  it('remembers an explicit All choice', async () => {
    saveRepoScope(null); const { root, started } = start(); await started;
    expect(root.querySelector('.startup-scope')).toBeNull(); expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('');
    expect(localStorage.getItem('runner.repoScope')).toBe('*');
  });
  it('can retry an unavailable list and remains gated until a scope is selected', async () => {
    repos = []; const { root, started } = start();
    await vi.waitFor(() => expect(root.querySelector('.startup-scope')).not.toBeNull());
    expect(root.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    repos = ['org/a']; root.querySelector<HTMLButtonElement>('[type="button"]')?.click();
    await vi.waitFor(() => expect(root.querySelectorAll('option')).toHaveLength(2));
    await choose(root, 'org/a'); await started;
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });
  it('releases a pending choice when the app is destroyed', async () => {
    const { root, started } = start(); await vi.waitFor(() => expect(root.querySelector('.startup-scope')).not.toBeNull());
    view?.destroy(); await started; expect(requests).toEqual(['/api/context']); expect(root.querySelector('.startup-scope')).toBeNull();
  });
});
