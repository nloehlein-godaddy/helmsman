import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import { LOCAL_POLL_MS, POLL_MS } from './data/live';
import type { RunSummary } from './data/agents';
import * as apiClient from './data/api-client';
import { PluginPageHost } from './plugins/page-host';

const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let view: DashboardView | null = null;

async function setup(path = '/prs?repo=org/a', runs: RunSummary[] = [], contextAvailable = true, jiraEnabled = true) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadMockSnapshot();
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname === '/api/context') return contextAvailable ? json({ repos: ['org/a'], jiraBaseUrl: null, jiraEnabled }) : new Response(null, { status: 404 });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null, jiraEnabled });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  return { root, requests, fetcher, count: (path: string) => requests.filter(item => item === path).length };
}

function visible(value: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(!value);
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('view-aware polling', () => {
  it('uses cached reads during polling and bypasses them for explicit refresh', async () => {
    const invalidate = vi.spyOn(apiClient, 'invalidateApiCache');
    const refresh = vi.spyOn(PluginPageHost.prototype, 'refresh');
    await setup('/outcomes?repo=org/a'); await vi.advanceTimersByTimeAsync(0);
    invalidate.mockClear(); refresh.mockClear();
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(invalidate).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalled();
    expect(refresh.mock.calls.every(([force]) => force === false)).toBe(true);
    refresh.mockClear(); await view!.refresh();
    expect(invalidate).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledWith(true);
  });

  it('refreshes local status every 30 seconds without legacy PR or dashboard reads', async () => {
    const { count } = await setup();
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS - LOCAL_POLL_MS);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    expect(count('/api/agents')).toBe(10);
    expect(count('/api/config')).toBe(1);
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
  });

  it('updates shared run counts on Helm without refetching legacy GitHub data', async () => {
    const runs: RunSummary[] = [{ id: 'run-1', ticketId: 'TEST-1', repo: 'org/a', status: 'running',
      attempt: 1, prNumber: null, startedAt: new Date().toISOString(), costUsd: null }];
    const { root, count } = await setup('/helm?repo=org/a', runs);
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('1');
    runs[0]!.status = 'succeeded';
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(root.querySelector('.helm-readout .seg7')?.textContent).toBe('0');
    expect(count('/api/dashboard')).toBe(0);
  });

  it('stops hidden polling and refreshes only overdue data upon return', async () => {
    const { count } = await setup();
    visible(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/agents')).toBe(1);
    visible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/agents')).toBe(2);
    visible(false);
    visible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/agents')).toBe(2);
  });

  it.each(['/config', '/runs', '/cmux'])('does not refresh external data while on %s', async (path) => {
    const { count } = await setup(`${path}?repo=org/a`);
    expect(count('/api/context')).toBe(2);
    expect(count('/api/dashboard')).toBe(0);
    const initialConfig = count('/api/config');
    const initialGit = count('/api/repo/local');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/open')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    expect(count('/api/config')).toBe(initialConfig);
    expect(count('/api/repo/local')).toBe(initialGit);
    expect(count('/api/agents')).toBeGreaterThan(1);
    expect(count('/api/context')).toBeGreaterThan(2);
  });

  it('keeps core pages usable without a legacy dashboard fallback if context is unavailable', async () => {
    const { root, count } = await setup('/runs?repo=org/a', [], false);
    expect(count('/api/context')).toBe(2);
    expect(count('/api/dashboard')).toBe(0);
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(0);
  });

  it('shares in-flight refreshes and disposes the recurring timer', async () => {
    const { count, fetcher } = await setup();
    const original = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation(async input => String(input).startsWith('/api/dashboard') ? pending : original(input));
    const first = view!.refresh();
    const second = view!.refresh();
    expect(second).toBe(first);
    resolve(new Response(null, { status: 503 }));
    await first;
    view!.destroy();
    const before = count('/api/agents');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/agents')).toBe(before);
  });

  it('runs one explicit refresh after an in-progress automatic refresh', async () => {
    const { fetcher } = await setup(); const original = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; });
    let waiting = true;
    fetcher.mockImplementation(async input => {
      if (String(input).startsWith('/api/agents') && waiting) { waiting = false; return response; }
      return original(input);
    });
    const invalidate = vi.spyOn(apiClient, 'invalidateApiCache'); invalidate.mockClear();
    vi.setSystemTime(Date.now() + LOCAL_POLL_MS);
    const background = view!.refresh(false); const first = view!.refresh(); const second = view!.refresh();
    resolve(json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }));
    await Promise.all([background, first, second]); expect(invalidate).toHaveBeenCalledOnce();
  });
});
