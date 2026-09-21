import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';

let view: DashboardView | undefined;
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/prs?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Helm repository scope changes', () => {
  it('reloads the authored PR inbox immediately after visiting another repository on a page that does not fetch dashboards', async () => {
    const snapshot = await loadDashboard();
    snapshot.myOpenPrs = [{ number: 1, title: 'PROJA-1', repo: 'org/a', reviewDecision: '', draft: false, createdAt: new Date().toISOString() }];
    const dashboardRequests: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
      if (url.pathname === '/api/dashboard') {
        const repo = url.searchParams.get('repo');
        dashboardRequests.push(repo);
        return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: repo, jiraBaseUrl: null });
      }
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    expect(root.textContent).toContain('PROJA-1');
    expect(dashboardRequests).toEqual(['org/a']);

    window.history.pushState(null, '', '/runs?repo=org/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(root.querySelector('.helm')?.getAttribute('data-page')).toBe('runs'));
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    expect(dashboardRequests).toEqual(['org/a']);

    window.history.pushState(null, '', '/prs?repo=org/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(dashboardRequests).toEqual(['org/a', 'org/a']));
    await vi.waitFor(() => expect(root.textContent).toContain('PROJA-1'));
    expect(root.textContent).not.toContain('Loading Helm');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });

  it.each([true, false])('removes old repository data during a pending scope fetch and after success=%s', async succeeds => {
    const snapshot = await loadDashboard();
    snapshot.myOpenPrs = [{ number: 1, title: 'PROJA-1', repo: 'org/a', reviewDecision: '', draft: false, createdAt: new Date().toISOString() }];
    snapshot.underway = [{ id: 'PROJA-2', title: 'A underway', repo: 'org/a', priority: 'P1', status: 'in-progress' }];
    snapshot.underwayAvailable = true;
    snapshot.shipped = [];
    snapshot.activity = [];
    snapshot.stats = { completedToday: 0, awaitingReview: 1, avgCycleMinutes: 0 };
    let resolveB!: (response: Response) => void;
    const pendingB = new Promise<Response>(resolve => { resolveB = resolve; });
    const requested: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
      if (url.pathname === '/api/dashboard') {
        const repo = url.searchParams.get('repo');
        requested.push(repo);
        if (repo === 'org/b') return pendingB;
        return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: repo, jiraBaseUrl: null });
      }
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    expect(root.textContent).toContain('PROJA-1');
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requested).toContain('org/b'));
    expect(root.textContent).not.toContain('PROJA-1');
    expect(root.textContent).not.toContain('PROJA-2');
    expect(root.querySelector('.pr-authored .pr-list-row')).toBeNull();
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    resolveB(succeeds ? json({ snapshot: {
      ...snapshot,
      myOpenPrs: [{ number: 2, title: 'PROJB-1', repo: 'org/b', reviewDecision: '', draft: false, createdAt: new Date().toISOString() }],
      underway: [],
    }, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: 'org/b', jiraBaseUrl: null }) : new Response(null, { status: 503 }));
    await vi.waitFor(() => expect(root.textContent).toContain(succeeds ? 'PROJB-1' : 'unavailable'));
    expect(root.textContent).not.toContain('PROJA-1');
    expect(root.textContent).not.toContain('PROJA-2');
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/b');
    expect(localStorage.getItem('runner.repoScope')).toBe('org/b');
  });
});
