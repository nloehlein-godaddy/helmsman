import { afterEach, expect, it, vi } from 'vitest';
import panel from './panel';
import { PrCompatibilitySession, bindPrCompatibilitySession, prTarget } from '../../pr-compatibility-session';
import { renderPrPanel } from '../../render';
import type { PluginPanelState } from '../sdk';
import type { PrStatusView } from '../../data/pr';

const status: PrStatusView = { repo: 'org/b', number: 42, headSha: 'original', state: 'open', draft: false, merged: false, headRefName: 'topic', reviewDecision: '', comments: 0, checks: { passed: 0, failed: 0, pending: 0 }, url: 'https://github.com/org/b/pull/42' };
const json = (value: unknown) => new Response(JSON.stringify(value));
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function fixture(overrides: Partial<PluginPanelState> = {}) {
  const root = document.createElement('div'); const container = document.createElement('div'); root.append(container); document.body.append(root);
  const session = new PrCompatibilitySession({ repos: () => ['org/a', 'org/b'], headerRepo: () => 'org/a' }); bindPrCompatibilitySession(root, session);
  const lifetime = new AbortController(); lifetimes.push(lifetime); const activity = new AbortController();
  const state: PluginPanelState = { repo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'pr', activity: { epoch: 1, signal: activity.signal, active: true, repo: 'org/a' }, savedState: { version: 1, value: { target: { repo: 'org/b', number: 42 } } }, ...overrides };
  const saveState = vi.fn(async () => {}); const navigate = vi.fn();
  const instance = await panel.mount(container, { state, activity: state.activity, signal: lifetime.signal, services: { version: 1 }, onDispose: vi.fn(), navigate, saveState });
  return { root, container, session, lifetime, activity, state, instance, saveState, navigate };
}
it('repaints shared status and head updates without losing form edits or header scope', async () => {
  let current = status;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => String(url).startsWith('/api/pr/diff') ? json({ files: [] }) : init?.method === 'POST' ? json({ ok: true }) : json(current)));
  const f = await fixture(); await vi.waitFor(() => expect(f.container.querySelector('.pr-review-body')).not.toBeNull());
  const input = f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')!; input.value = 'New unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 5);
  const legacy = document.createElement('div'); f.root.append(legacy); legacy.innerHTML = renderPrPanel(status, true); f.session.restore(legacy);
  const owner = {}; f.session.setActive(owner, true); current = { ...status, viewerReview: 'APPROVED', headSha: 'new-head' };
  await f.session.review(owner, prTarget(legacy.querySelector('.pr-approve')!)!, 'APPROVE');
  expect(f.container.querySelector('.pr-viewer-review')?.textContent).toContain('Approved');
  expect(f.container.querySelector<HTMLElement>('.pr-panel')?.dataset.prHeadSha).toBe('new-head');
  expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('New unsent draft');
  expect(document.activeElement).toBe(f.container.querySelector('.pr-review-body')); expect(f.session.headerRepo()).toBe('org/a');
  await f.instance.dispose(); expect(f.session.active(owner)).toBe(true);
});
it('rejects stale reads after retarget/hide and persists explicit selection without navigating the header', async () => {
  let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url, init) => { if (String(url).startsWith('/api/pr/diff')) return Promise.resolve(json({ files: [] })); signals.push(init.signal); return pending; }));
  const f = await fixture();
  await f.instance.update({ ...f.state, visible: false }); expect(signals[0]?.aborted).toBe(true); resolve(json(status)); await Promise.resolve();
  vi.mocked(fetch).mockImplementation(async url => String(url).startsWith('/api/pr/diff') ? json({ files: [] }) : json({ ...status, repo: 'org/c', number: 9 }));
  const nextActivity = new AbortController();
  await f.instance.update({ ...f.state, activity: { ...f.state.activity, signal: nextActivity.signal, epoch: 2 }, presentation: { version: 1, kind: 'pull-request', repo: 'org/c', number: 9 } });
  expect(f.container.querySelector<HTMLElement>('.pr-panel')?.dataset.prRepo).toBe('org/c');
  expect(f.session.status(status)).toBeNull(); expect(f.navigate).not.toHaveBeenCalled();
  const input = f.container.querySelector<HTMLInputElement>('[data-pr-compat-lookup]')!; input.value = 'org/c#9'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(f.saveState).toHaveBeenCalledWith({ version: 1, value: { target: { repo: 'org/c', number: 9 } } });
});
it('keeps a launched run scoped to the explicitly selected galleon while retaining the header default', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => init?.method === 'POST' ? json({ runId: 'review-result' }) : String(url).startsWith('/api/pr/diff') ? json({ files: [] }) : json(status)));
  const f = await fixture(); await vi.waitFor(() => expect(f.container.querySelector('.pr-review-agent')).not.toBeNull());
  f.container.querySelector<HTMLButtonElement>('.pr-review-agent')!.click();
  await vi.waitFor(() => expect(f.navigate).toHaveBeenCalled());
  const route = new URL(f.navigate.mock.calls[0]![0] as string, 'https://helmsman.test');
  expect(route.searchParams.get('repo')).toBe('org/a'); expect(route.searchParams.get('runRepo')).toBe('org/b'); expect(route.searchParams.get('run')).toBe('review-result');
});
it.each(['review', 'rerun'] as const)('preselects and focuses route %s without launching and retains draft on route updates', async mode => {
  vi.stubGlobal('fetch', vi.fn(async url => String(url).startsWith('/api/pr/diff') ? json({ files: [] }) : json({ ...status, isOwnPr: true })));
  const f = await fixture(); await vi.waitFor(() => expect(f.container.querySelector('.pr-review-body')).not.toBeNull());
  const textarea = f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')!; textarea.value = 'Preserve routed draft'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await f.instance.update({ ...f.state, routeState: { version: 1, value: { target: { repo: 'org/b', number: 42 }, mode } } });
  expect(document.activeElement).toBe(f.container.querySelector(mode === 'review' ? '.pr-review-agent' : '.pr-rerun-feedback'));
  expect(f.container.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe('Preserve routed draft');
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it.each(['../private', 'org/..', '-owner/repo', 'org/repo?bad', 'org/repo/extra', 'org/' + 'x'.repeat(101)])('rejects malformed opaque PR targets before provider reads: %s', async repo => {
  vi.stubGlobal('fetch', vi.fn(async () => json(status)));
  const f = await fixture({ savedState: null, routeState: { version: 1, value: { target: { repo, number: 1 }, mode: 'review' } } });
  await f.instance.refresh?.();
  expect(fetch).not.toHaveBeenCalled(); expect(f.container.querySelector('.pr-panel')).toBeNull();
  await f.instance.update({ ...f.state, routeState: null, presentation: { version: 1, kind: 'pull-request', repo, number: 1 } });
  expect(fetch).not.toHaveBeenCalled();
});
