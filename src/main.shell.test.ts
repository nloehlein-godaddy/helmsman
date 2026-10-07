import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { syncBuiltinFrontend } from './plugins/builtin-modules';
import communicationPackage from './plugins/communication/plugin-package.json';
import { loadDashboard } from './data/mock';
import { LOCAL_POLL_MS } from './data/live';
import type { RunSummary } from './data/agents';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | null = null;

async function setup(path = '/helm?repo=org/a', degraded: string[] = []) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadDashboard();
  const runs: RunSummary[] = [{ id: 'run-a', ticketId: 'TASK-1', repo: 'org/a', status: 'running', attempt: 1, prNumber: null, startedAt: new Date().toISOString(), costUsd: null }];
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded, repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
    if (url.pathname === '/api/communication/notifications') return json({ version: 1, quality: 'complete', unread: 0, githubHealth: null, health: { enabled: false, status: 'disabled', channelName: 'airo-editing', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/repo/local') return json({ repo: url.searchParams.get('repo'), path: '/repo', branches: [], worktrees: [], error: null });
    if (url.pathname === '/api/triage') return json({ groups: { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] }, degraded: false, selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/bugs') return json({ cards: [], degraded: false, generatedAt: '', latestWindow: '', previousWindow: '' });
    return new Response(null, { status: 404 });
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  await vi.advanceTimersByTimeAsync(0);
  const count = (endpoint: string) => requests.filter(item => item === endpoint).length;
  const switchTo = async (page: string) => {
    root.querySelector<HTMLAnchorElement>(`[data-view="${page}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { root, runs, count, switchTo };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  syncBuiltinFrontend([{ id: 'helmsman.communication', version: communicationPackage.manifest.version, hash: 'a'.repeat(64), enabled: true }], false);
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-17T21:00:00Z');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  syncBuiltinFrontend([], false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe('persistent app shell', () => {
  it('keeps Config sibling links and keyboard focus through navigation and refresh', async () => {
    const { root } = await setup('/config?repo=org/a');
    const section = root.querySelector<HTMLElement>('.section-nav')!;
    const links = [...section.querySelectorAll<HTMLAnchorElement>('a')];
    const source = links.find(link => new URL(link.href).pathname === '/source-settings')!;
    const github = links.find(link => new URL(link.href).pathname === '/github-settings')!;
    source.focus();
    source.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.pathname).toBe('/source-settings');
    expect(root.querySelector('.section-nav')).toBe(section);
    expect([...section.querySelectorAll('a')]).toEqual(links);
    expect(section.querySelector('[aria-current="page"]')).toBe(source);
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-config');
    expect(document.activeElement).toBe(source);
    github.focus();
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(document.activeElement).toBe(github);
    expect([...section.querySelectorAll('a')]).toEqual(links);
    github.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.pathname).toBe('/github-settings');
    expect(window.location.search).toBe('?repo=org%2Fa');
    expect(section.querySelector('[aria-current="page"]')).toBe(github);
    expect(document.activeElement).toBe(github);
    links[0]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.pathname).toBe('/config');
    expect(section.querySelector('[aria-current="page"]')).toBe(links[0]);
    expect([...section.querySelectorAll('a')]).toEqual(links);
  });

  it('restores section selection on history navigation and updates sibling scope', async () => {
    const { root, switchTo } = await setup('/local-git?repo=org/a');
    const section = root.querySelector<HTMLElement>('.section-nav')!;
    expect(section.hidden).toBe(false);
    expect(section.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/local-git?repo=org%2Fa');
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    for (const link of section.querySelectorAll<HTMLAnchorElement>('a')) expect(new URL(link.href).searchParams.get('repo')).toBe('org/b');
    await switchTo('bugs');
    expect(section.hidden).toBe(true);
    window.history.replaceState(null, '', '/run-viewer?repo=org/a&run=run-a&runRepo=org/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.section-nav')).toBe(section);
    expect(section.hidden).toBe(false);
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-runs');
    expect(section.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/run-viewer?repo=org%2Fa');
    expect([...section.querySelectorAll<HTMLAnchorElement>('a')].map(link => new URL(link.href).pathname)).toEqual(['/runs', '/run-history', '/run-viewer']);
    for (const link of section.querySelectorAll<HTMLAnchorElement>('a')) expect([...new URL(link.href).searchParams]).toEqual([['repo', 'org/a']]);
  });

  it('reveals the active section link on resize without moving keyboard focus', async () => {
    const { root } = await setup('/local-git?repo=org/a');
    const section = root.querySelector<HTMLElement>('.section-nav')!;
    const current = section.querySelector<HTMLElement>('[aria-current="page"]')!;
    const focused = section.querySelector<HTMLAnchorElement>('a')!;
    Object.defineProperty(section, 'clientWidth', { value: 320 });
    Object.defineProperties(current, { offsetLeft: { value: 800 }, offsetWidth: { value: 100 } });
    focused.focus();
    window.dispatchEvent(new Event('resize'));
    expect(section.scrollLeft).toBe(580);
    expect(document.activeElement).toBe(focused);
  });

  it('changes navigation orientation on resize while retaining focus and revealing the active destination', async () => {
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    const { root } = await setup('/config?repo=org/a');
    const tabs = root.querySelector<HTMLElement>('.page-tabs')!;
    const active = root.querySelector<HTMLElement>('.page-tab.is-active')!;
    const focused = root.querySelector<HTMLAnchorElement>('.page-tab')!;
    Object.defineProperties(tabs, { clientHeight: { value: 240 }, clientWidth: { value: 320 } });
    Object.defineProperties(active, { offsetTop: { value: 640 }, offsetHeight: { value: 40 }, offsetLeft: { value: 980 }, offsetWidth: { value: 88 } });
    focused.focus();
    window.dispatchEvent(new Event('resize'));
    expect(tabs.getAttribute('aria-orientation')).toBe('vertical');
    expect(tabs.scrollTop).toBe(440);
    expect(tabs.scrollLeft).toBe(0);
    expect(document.activeElement).toBe(focused);
    width.mockReturnValue(390);
    window.dispatchEvent(new Event('resize'));
    expect(tabs.getAttribute('aria-orientation')).toBe('horizontal');
    expect(tabs.scrollTop).toBe(0);
    expect(tabs.scrollLeft).toBe(748);
    expect(document.activeElement).toBe(focused);
    expect(root.querySelector('.page-tabs')).toBe(tabs);
  });

  it('keeps the same header, tabs, counts, footer, and notification controls across the primary views', async () => {
    const { root, switchTo } = await setup();
    const selectors = ['.helm-head', '.nameplate', '.repo-select', '.helm-readout', '.page-tabs', '.app-footer', '[data-slack-toggle]', '.slack-popover', '#page-content'];
    await vi.waitFor(() => selectors.forEach(selector => expect(root.querySelector(selector), selector).not.toBeNull()));
    const elements = selectors.map(selector => root.querySelector(selector));
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
    const footer = root.querySelector('.app-footer')?.textContent;
    for (const page of ['prs', 'runs', 'triage', 'bugs', 'config', 'cmux', 'campaigns', 'dashboard']) {
      await switchTo(page);
      selectors.forEach((selector, i) => expect(root.querySelector(selector), `${page}: ${selector}`).toBe(elements[i]));
      expect(root.querySelector('.helm')?.getAttribute('data-page')).toBe(['dashboard', 'triage', 'bugs', 'runs', 'prs', 'cmux', 'campaigns'].includes(page) ? 'plugin' : page);
      expect(root.querySelector('#page-content')?.getAttribute('aria-labelledby')).toBe(`page-tab-${page}`);
      expect(root.querySelectorAll('.page-tab[aria-selected="true"]')).toHaveLength(1);
      expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('1');
      expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
      expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
      expect(root.querySelector('.app-footer')?.textContent).toBe(footer);
      expect(root.querySelector('#page-content .app-footer')).toBeNull();
      expect(root.querySelector('#page-content .helm-head')).toBeNull();
      expect(root.querySelectorAll('.operator-note')).toHaveLength(page === 'config' ? 1 : 0);
    }
  });

  it('shows unknown queue/review on direct Config without fetching external data for counts', async () => {
    const { root, count } = await setup('/config?repo=org/a');
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('1');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-footer-running]')?.textContent).toBe('1 underway');
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/open')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    expect(count('/api/triage')).toBe(0);
    expect(count('/api/bugs')).toBe(0);
  });

  it.each(['jira', 'github'])('keeps queue and review unknown without legacy reads when %s is unavailable', async service => {
    const { root } = await setup('/prs?repo=org/a', [service]);
    const queue = root.querySelector('[data-fleet-count="queued"]')?.textContent;
    const review = root.querySelector('[data-fleet-count="review"]')?.textContent;
    if (service === 'jira') {
      expect(queue).toBe('—');
      expect(review).toBe('—');
    } else {
      expect(queue).toBe('—');
      expect(review).toBe('—');
    }
  });

  it('updates shared underway counts on Config without replacing its draft or shared controls', async () => {
    const { root, runs, switchTo, count } = await setup();
    await switchTo('config');
    const input = root.querySelector<HTMLInputElement>('input.config-input')!;
    input.value = 'Unsaved draft';
    const header = root.querySelector('.helm-head');
    const footer = root.querySelector('.app-footer');
    const queue = root.querySelector('[data-fleet-count="queued"]')?.textContent;
    runs[0]!.status = 'succeeded';
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(root.querySelector('input.config-input')).toBe(input);
    expect(input.value).toBe('Unsaved draft');
    expect(root.querySelector('.helm-head')).toBe(header);
    expect(root.querySelector('.app-footer')).toBe(footer);
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('0');
    expect(root.querySelector('[data-footer-running]')?.textContent).toBe('0 underway');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe(queue);
    expect(count('/api/dashboard')).toBe(0);
  });

  it('registers one repository change handler after repeated navigation and clears counts for an unloaded scope', async () => {
    const { root, switchTo, count } = await setup();
    await switchTo('runs');
    await switchTo('config');
    await switchTo('runs');
    await switchTo('config');
    const before = count('/api/config');
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.repo-select')).toBe(repo);
    expect(count('/api/config')).toBe(before + 1);
    expect(count('/api/dashboard')).toBe(0);
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('0');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
  });

  it('removes delegated controls when the app is recreated in the same root', async () => {
    const { root, count } = await setup('/config?repo=org/a');
    view!.destroy();
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = count('/api/config');
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/config')).toBe(before + 1);
    root.querySelector<HTMLButtonElement>('[data-slack-toggle]')!.click();
    expect(root.querySelector<HTMLElement>('.slack-popover')?.hidden).toBe(false);
  });

  it('preserves notification popup identity and scroll during navigation and keyboard tab focus during refresh', async () => {
    const { root } = await setup();
    const bell = root.querySelector<HTMLButtonElement>('[data-slack-toggle]')!;
    bell.click();
    const popover = root.querySelector<HTMLElement>('.slack-popover')!;
    popover.scrollTop = 40;
    window.history.pushState(null, '', '/runs?repo=org/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('[data-slack-toggle]')).toBe(bell);
    expect(root.querySelector('.slack-popover')).toBe(popover);
    expect(popover.hidden).toBe(false);
    expect(popover.scrollTop).toBe(40);
    expect(document.activeElement).toBe(bell);
    const runs = root.querySelector<HTMLAnchorElement>('[data-view="runs"]')!;
    runs.focus();
    runs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const focused = document.activeElement;
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(document.activeElement).toBe(focused);
    expect(root.querySelectorAll('.page-tab[tabindex="0"]')).toHaveLength(1);
  });
});
