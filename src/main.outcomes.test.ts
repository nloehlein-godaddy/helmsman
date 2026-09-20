import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { appPages, COSTS_PAGE_ID, COSTS_PAGE_SLOT } from './plugins/builtins';

let view: DashboardView | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const summary = (repo: string | null, runId = 'run_1') => ({ window: { from: '2026-01-01', to: '2026-01-30' }, repo, runs: 1, execution: { succeeded: 1, failed: 0, stopped: 0, running: 0 }, assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 1 }, outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 1 }, knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costCoverage: null, averageCostUsd: null, runsWithDuration: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, linkedPrs: 0, unknownPrs: 0, stalePrs: 0, unavailablePrs: 0, publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0, costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null, correctionRounds: null, failures: [], daily: [], recentRuns: [{ runId, repo: repo ?? 'org/a', status: 'succeeded', prNumber: null, startedAt: '', durationMs: null, costUsd: null, observedCostUsd: null, assessment: null }] });

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); window.history.replaceState(null, '', '/outcomes?repo=org/a'); vi.stubGlobal('EventSource', class { onmessage = null; close() {} }); });
afterEach(() => { view?.destroy(); appPages.select(COSTS_PAGE_SLOT, null); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('Costs & Outcomes', () => {
  const mockApi = () => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/outcomes') return json(summary(url.searchParams.get('repo')));
    return json({});
  }));

  it('loads the registered canonical Costs route and preserves it on header scope changes', async () => {
    mockApi();
    window.history.replaceState(null, '', `/plugins/${COSTS_PAGE_ID}?repo=org/a`);
    view = new DashboardView(document.querySelector('#app')!);
    await view.start();
    expect(document.body.textContent).toContain('run_1');
    expect(window.location.pathname).toBe(`/plugins/${COSTS_PAGE_ID}`);
    expect(document.querySelector('#page-tab-outcomes')?.getAttribute('aria-selected')).toBe('true');
    const select = document.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/b'));
    expect(window.location.pathname).toBe(`/plugins/${COSTS_PAGE_ID}`);
  });

  it('shows an unavailable page for a missing contribution without loading Costs', async () => {
    mockApi();
    appPages.select(COSTS_PAGE_SLOT, 'missing.costs/page');
    view = new DashboardView(document.querySelector('#app')!);
    await view.start();
    expect(document.body.textContent).toContain('Page unavailable');
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/outcomes'))).toBe(false);
    expect(window.location.pathname).toBe('/outcomes');
    const page = document.querySelector('#page-content');
    const label = document.getElementById(page?.getAttribute('aria-labelledby') ?? '');
    expect(label?.getAttribute('aria-selected')).toBe('true');
    appPages.select(COSTS_PAGE_SLOT, null);
    await vi.waitFor(() => expect(document.body.textContent).toContain('run_1'));
    expect(window.location.pathname).toBe('/outcomes');
  });

  it('aborts a pending Costs request when its slot becomes unavailable and ignores a late response', async () => {
    let signal: AbortSignal | null | undefined;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a'], jiraBaseUrl: null, jiraEnabled: true });
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: {} });
      if (url.pathname === '/api/outcomes') { signal = init?.signal; return pending; }
      return json({});
    }));
    view = new DashboardView(document.querySelector('#app')!);
    const starting = view.start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    appPages.select(COSTS_PAGE_SLOT, 'missing.costs/page');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Page unavailable'));
    expect(signal?.aborted).toBe(true);
    resolve(json(summary('org/a', 'late_run')));
    await starting;
    expect(document.body.textContent).not.toContain('late_run');
    expect(document.body.textContent).toContain('Page unavailable');
  });

  it('keeps header scope and ignores an older scope response', async () => {
    let resolveA!: (response: Response) => void;
    const pendingA = new Promise<Response>(resolve => { resolveA = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true });
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/outcomes') return url.searchParams.get('repo') === 'org/a' ? pendingA : json(summary('org/b', 'run_b'));
      return json({});
    }));
    view = new DashboardView(document.querySelector('#app')!);
    void view.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    const select = document.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('run_b'));
    resolveA(json(summary('org/a', 'run_a')));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.body.textContent).not.toContain('run_a');
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
  });

});
