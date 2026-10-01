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



const status = (repo: string, number: number) => ({
  number, repo, isOwnPr: true, state: 'open', draft: false, merged: false, headRefName: 'topic',
  reviewDecision: 'REVIEW_REQUIRED', comments: 0, checks: { passed: 0, failed: 0, pending: 0 },
  url: `https://github.com/${repo}/pull/${number}`,
});

async function setup(path: string, extra: (url: URL) => Response | Promise<Response> | null = () => null, runs: RunSummary[] = [],
  chooseScope?: (root: HTMLElement, requests: { url: URL; method: string }[]) => Promise<void>) {
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
  const started = view.start();
  if (chooseScope) await chooseScope(root, requests);
  await started;
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
  it.each([
    ['new tab', '/prs', '_blank', false, {}],
    ['named tab', '/prs', 'review', false, {}],
    ['download', '/api/agents/run-1/log/download', '', true, {}],
    ['external destination', 'https://github.com/org/a/pull/42', '', false, {}],
    ['modified click', '/prs', '', false, { metaKey: true }],
    ['middle click', '/prs', '', false, { button: 1 }],
  ])('leaves %s navigation to the browser', async (_label, href, target, download, init) => {
    const { root } = await setup('/config?repo=org/a');
    const address = window.location.href;
    const link = document.createElement('a'); link.className = 'app-link'; link.href = href; link.target = target;
    if (download) link.download = '';
    root.append(link);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.href).toBe(address);
  });


  it('preserves Config drafts while header scope updates the Local Git link', async () => {
    const { root, requests } = await setup('/config?repo=org/a', url => url.pathname === '/api/config'
      ? json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] }) : null);
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('input.config-input')).not.toBeNull());
    root.querySelector<HTMLInputElement>('input.config-input')!.value = 'unsaved';
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b'; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('a[href="/local-git?repo=org%2Fb"]')).not.toBeNull());
    expect(root.querySelector<HTMLInputElement>('input.config-input')?.value).toBe('unsaved');
    expect(requests.some(({ url }) => url.pathname === '/api/repo/local')).toBe(false);
  });

  it('drops malformed parameters before making PR requests or opening streams', async () => {
    const { root, requests } = await setup('/runs?repo=../private&pr=-1&run=../../secret&pane=%22%5D&mode=launch', () => null, [], async (root, requests) => {
      await vi.waitFor(() => expect(root.querySelector('.startup-scope')).not.toBeNull());
      expect(requests.map(({ url }) => url.pathname)).toEqual(['/api/context']);
      expect(streams).toHaveLength(0);
      const select = root.querySelector<HTMLSelectElement>('[name="startupRepo"]')!;
      select.value = 'org/a'; select.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(root.querySelector('[data-plugin-page="helmsman.runs/page"]')).not.toBeNull();
    expect(window.location.pathname + window.location.search).toBe('/runs?repo=org%2Fa');
    expect(requests.some(({ url }) => ['/api/pr', '/api/pr/diff', '/api/agents/launch'].includes(url.pathname))).toBe(false);
    expect(requests.every(({ url, method }) => (!url.searchParams.has('repo') || url.searchParams.get('repo') === 'org/a') && method === 'GET')).toBe(true);
    expect(streams).toHaveLength(0);
  });
});

it('keeps the clarification alias unavailable when its plugin catalog is absent instead of rendering compatibility', async () => {
  const { root, requests } = await setup('/clarifications?repo=org/a');
  expect(root.querySelector('.clarification-page')).toBeNull(); expect(root.querySelector('.plugin-clarifications-panel')).toBeNull();
  expect(requests.some(request => request.url.pathname.startsWith('/api/clarification'))).toBe(false);
  expect(window.location.pathname).toBe('/clarifications');
});
