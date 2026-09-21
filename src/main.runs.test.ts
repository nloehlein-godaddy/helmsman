import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { syncBuiltinFrontend } from './plugins/builtin-modules';
const json = (value: unknown) => new Response(JSON.stringify(value));
const streams: { close: ReturnType<typeof vi.fn> }[] = [];
let view: DashboardView | null = null;
const run = { id: 'run-a', repo: 'org/a', ticketId: 'TASK-1', status: 'running', attempt: 1, prNumber: 42, startedAt: '2026-09-20T12:00:00Z', costUsd: null };
beforeEach(() => {
  localStorage.clear(); document.body.innerHTML = '<div id="app"></div>'; streams.length = 0;
  syncBuiltinFrontend(['helmsman.runs', 'helmsman.compat-pr', 'helmsman.run-history'].map(id => ({ id, version: '0.1.0', hash: 'a'.repeat(64), enabled: true })), false);
  vi.stubGlobal('EventSource', class { onmessage = null; close = vi.fn(); constructor() { streams.push(this); } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [run], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/agents/run-a') return json(run);
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/pr') return json({ repo: url.searchParams.get('repo'), number: Number(url.searchParams.get('number')), state: 'open', isOwnPr: true, draft: false, merged: false, headRefName: 'topic', reviewDecision: '', comments: 0, checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/a/pull/42' });
    return new Response('{}', { status: 503 });
  }));
});
afterEach(() => { view?.destroy(); view = null; syncBuiltinFrontend([], false); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function start(path: string) { window.history.replaceState(null, '', path); const root = document.querySelector<HTMLElement>('#app')!; view = new DashboardView(root); await view.start(); return root; }
it('mounts Runs through composition with public history and stops legacy streams when a PR recent row opens Runs', async () => {
  const root = await start('/prs?repo=org/a&run=run-a'); expect(streams).toHaveLength(1);
  await vi.waitFor(() => expect(root.querySelector('.recent-run')).not.toBeNull());
  root.querySelector<HTMLElement>('.recent-run')!.click();
  await vi.waitFor(() => expect(root.querySelector('.plugin-runs')).not.toBeNull());
  await vi.waitFor(() => expect(root.querySelector('.plugin-run-history')).not.toBeNull());
  expect(window.location.pathname).toBe('/runs'); expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  expect(streams).toHaveLength(1); expect(streams[0]?.close).toHaveBeenCalledOnce();
  expect(root.querySelector('.run-drawer')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input), window.location.origin).pathname === '/api/runs')).toBe(false);
  window.history.pushState(null, '', '/prs?repo=org/a&run=run-a'); window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(streams).toHaveLength(2));
});
it('shows unavailable when Runs is disabled and never restores the old page/history endpoint', async () => {
  syncBuiltinFrontend([], false); const root = await start('/runs?repo=org/a&pr=42&mode=review');
  expect(root.textContent).toContain('Page unavailable'); expect(root.querySelector('.plugin-runs, .pr-panel, .run-drawer')).toBeNull();
  expect(streams).toHaveLength(0); expect(vi.mocked(fetch).mock.calls.some(([input]) => ['/api/runs', '/api/pr'].includes(new URL(String(input), window.location.origin).pathname))).toBe(false);
});

it.each([false, true])('header scope changes clear inherited PR selection and retain explicit override=%s', async explicit => {
  const root = await start(`/runs?repo=org/a&pr=42${explicit ? '&prRepo=org/a' : ''}`);
  await vi.waitFor(() => expect(root.querySelector('.plugin-runs .pr-panel[data-pr-repo="org/a"]')).not.toBeNull());
  const header = root.querySelector<HTMLSelectElement>('.repo-select')!; header.value = 'org/b'; header.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get('repo')).toBe('org/b'));
  await vi.waitFor(() => expect(Boolean(root.querySelector('.plugin-runs .pr-panel[data-pr-repo="org/a"]'))).toBe(explicit));
  expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
});
it('routes a legacy retry completed after Runs navigation to the generic viewer without reopening SSE', async () => {
  const root = await start('/prs?repo=org/a&run=run-a');
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const previous = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/retry') ? pending : previous(input, init));
  const retry = document.createElement('button'); retry.dataset.retryRunId = 'run-a'; root.append(retry); retry.click();
  window.history.pushState(null, '', '/runs?repo=org/a'); window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(root.querySelector('.plugin-runs')).not.toBeNull());
  resolve(json({ runId: 'retry-result' }));
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get('run')).toBe('retry-result'));
  expect(new URLSearchParams(window.location.search).get('runRepo')).toBe('org/a'); expect(streams).toHaveLength(1); expect(root.querySelector('.run-drawer')).toBeNull();
});
