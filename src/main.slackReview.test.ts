import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';

const views: DashboardView[] = [];
const permalink = 'https://godaddy.slack.com/archives/C123/p1789730000000000';
const success = { ok: true, channel: 'airo-editing', mention: 'airo-editing-squad', permalink };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const path = '/config?repo=org/a&slackPrRepo=org/b&slackPr=42';
async function setup(post: (body: Record<string, unknown>) => Response | Promise<Response> = () => json(success), enabled = true) {
  window.history.replaceState(null, '', path);
  const writes: Record<string, unknown>[] = []; const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    if (init?.method === 'POST') {
      if (url.pathname !== '/api/slack/review-request') throw new Error(`Unexpected write ${url.pathname}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push(body); return post(body);
    }
    reads.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: { SLACK_ENABLED: String(enabled) }, overridden: [] });
    if (url.pathname === '/api/slack') return json({ health: { enabled, status: enabled ? 'ok' : 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!; const view = new DashboardView(root); views.push(view); await view.start();
  const button = () => root.querySelector<HTMLButtonElement>('[data-slack-review-request]')!;
  expect(button()).not.toBeNull(); return { root, view, writes, reads, button };
}
async function navigate(path: string) { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); await new Promise(resolve => setTimeout(resolve, 0)); }
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); vi.stubGlobal('EventSource', class { onmessage = null; close() {} }); });
afterEach(() => { views.splice(0).forEach(view => view.destroy()); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); history.replaceState(null, '', '/'); });

describe('retained Slack review setup', () => {
  it('requires an explicit click, keeps header scope and sends only the selected PR target', async () => {
    const { root, view, writes, reads, button } = await setup(); await view.refresh();
    expect(writes).toEqual([]); expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    button().click(); await vi.waitFor(() => expect(button().disabled).toBe(true)); await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ repo: 'org/b', prNumber: 42 }); expect(writes[0]?.requestId).toMatch(/^[a-f\d-]{36}$/);
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink));
    expect(reads).not.toContain('/api/pr'); expect(reads).not.toContain('/api/dashboard');
  });
  it('preserves successful results across refresh, leaving and reopening the setup', async () => {
    const { root, view, writes, button } = await setup(); button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result')?.textContent).toContain('Sent to'));
    await view.refresh(); await navigate('/config?repo=org/a'); expect(button()).toBeNull(); await navigate(path);
    expect(button().disabled).toBe(true); expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
    button().click(); expect(writes).toHaveLength(1);
  });
  it('retains the original uncertain request ID across navigation and explicit retry', async () => {
    let attempts = 0; const { writes, button } = await setup(() => ++attempts === 1 ? Promise.reject(new Error('response lost')) : json(success));
    button().click(); await vi.waitFor(() => expect(button().disabled).toBe(false)); expect(writes).toHaveLength(1);
    await navigate('/config?repo=org/a'); await navigate(path); expect(writes).toHaveLength(1);
    button().click(); await vi.waitFor(() => expect(writes).toHaveLength(2)); expect(writes[1]?.requestId).toBe(writes[0]?.requestId);
    expect(writes[1]).toEqual(writes[0]);
  });
  it('retains a pending request through navigation and suppresses duplicate clicks', async () => {
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
    const { writes, button } = await setup(() => pending); button().click(); button().click();
    await navigate('/config?repo=org/a'); await navigate(path); expect(button().disabled).toBe(true); expect(writes).toHaveLength(1);
    resolve(json(success)); await vi.waitFor(() => expect(button().textContent).toContain('requested')); expect(writes).toHaveLength(1);
  });
  it('disables new requests while Slack integration is disabled', async () => {
    const { writes, button } = await setup(undefined, false); expect(button().disabled).toBe(true); button().click(); expect(writes).toHaveLength(0);
  });
  it('does not restore the retired manual review and voyage action delegates', async () => {
    const { root, writes } = await setup();
    for (const className of ['pr-comment', 'pr-approve', 'pr-request-changes', 'pr-review-agent', 'pr-rerun', 'launch-btn', 'agent-stop']) {
      const button = document.createElement('button'); button.className = className; root.append(button); button.click();
    }
    const retry = document.createElement('button'); retry.dataset.retryRunId = 'old-run'; root.append(retry); retry.click();
    expect(writes).toEqual([]);
  });
});
