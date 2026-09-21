import 'fake-indexeddb/auto';
import { syncBuiltinFrontend } from './plugins/builtin-modules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { RunSummary } from './data/agents';

const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const views: DashboardView[] = [];
const streams: RunStream[] = [];

class RunStream {
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    streams.push(this);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const status = (repo: string, number: number) => ({
  number, repo, isOwnPr: true, state: 'open', draft: false, merged: false, headRefName: 'topic',
  reviewDecision: 'REVIEW_REQUIRED', comments: 0, checks: { passed: 0, failed: 0, pending: 0 },
  url: `https://github.com/${repo}/pull/${number}`,
});

async function setup(path: string, extra: (url: URL) => Response | Promise<Response> | null = () => null, runs: RunSummary[] = []) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadMockSnapshot();
  const requests: { url: URL; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (method !== 'GET') throw new Error(`Unexpected write ${method} ${url}`);
    const custom = extra(url);
    if (custom) return custom;
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname.startsWith('/api/agents/')) return new Response(null, { status: 404 });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/pr') return json(status(url.searchParams.get('repo') ?? '', Number(url.searchParams.get('number'))));
    throw new Error(`Unexpected request ${url}`);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  return { root, view, requests };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  streams.length = 0;
  syncBuiltinFrontend(['helmsman.runs', 'helmsman.compat-pr'].map(id => ({ id, version: '0.1.0', hash: 'a'.repeat(64), enabled: true })), false);
  vi.stubGlobal('EventSource', RunStream);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('URL navigation', () => {

  it('refreshes local Git data without replacing unsaved config and ignores an older repo response', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const { root, requests } = await setup('/config', (url) => {
      if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
      if (url.pathname === '/api/repo/local') return url.searchParams.get('repo') === 'org/a' ? first.promise : second.promise;
      return null;
    });
    const choose = (repo: string) => {
      const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
      select.value = repo;
      select.dispatchEvent(new Event('change'));
    };
    choose('org/a');
    await vi.waitFor(() => expect(requests.some(({ url }) => url.pathname === '/api/repo/local' && url.searchParams.get('repo') === 'org/a')).toBe(true));
    choose('org/b');
    await vi.waitFor(() => expect(requests.some(({ url }) => url.pathname === '/api/repo/local' && url.searchParams.get('repo') === 'org/b')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = root.querySelector<HTMLInputElement>('input.config-input')!;
    input.value = 'unsaved';
    const payload = (repo: string, name: string) => ({ repo, path: `/repos/${repo}`, branches: [{ name, current: true, upstream: null, commit: 'abcdef' }], worktrees: [], error: null });
    second.resolve(json(payload('org/b', 'branch-b')));
    await vi.waitFor(() => expect(root.querySelector('.local-git-panel')?.textContent).toContain('branch-b'));
    first.resolve(json(payload('org/a', 'branch-a')));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('.local-git-panel')?.textContent).not.toContain('branch-a');
    expect(root.querySelector('input.config-input')).toBe(input);
    expect(input.value).toBe('unsaved');
  });

  it('drops malformed parameters before making PR requests or opening streams', async () => {
    const { root, requests } = await setup('/runs?repo=../private&pr=-1&run=../../secret&pane=%22%5D&mode=launch');
    expect(root.querySelector('[data-plugin-page="helmsman.runs/page"]')).not.toBeNull();
    expect(window.location.pathname + window.location.search).toBe('/runs');
    expect(requests.some(({ url }) => ['/api/pr', '/api/pr/diff', '/api/agents/launch'].includes(url.pathname))).toBe(false);
    expect(requests.every(({ url, method }) => !url.searchParams.has('repo') && method === 'GET')).toBe(true);
    expect(streams).toHaveLength(0);
  });
});

it('keeps the clarification alias unavailable when its plugin catalog is absent instead of rendering compatibility', async () => {
  const { root, requests } = await setup('/clarifications?repo=org/a');
  expect(root.querySelector('.clarification-page')).toBeNull(); expect(root.querySelector('.plugin-clarifications-panel')).toBeNull();
  expect(requests.some(request => request.url.pathname.startsWith('/api/clarification'))).toBe(false);
  expect(window.location.pathname).toBe('/clarifications');
});
