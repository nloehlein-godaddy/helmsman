import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, PullRequestReadItemV1, PullRequestReadPageV1, PullRequestReadServiceV1 } from '@helmsman/plugin-sdk';
import repoprs from './panel';
import shipped from '../shipped/panel';
const repo = 'org/project';
const pr: PullRequestReadItemV1 = { repo, number: 42, title: 'TASK-7 Implement', url: 'https://provider.example/reviews/42', status: 'open', createdAt: '2026-09-20T12:00:00Z', mergedAt: null, draft: false, ticketId: 'TASK-7', reviewDecision: null, comments: null, reviews: null };
function fixture(kind: 'repo-open' | 'authored-recent') {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel', savedState: null, activity: { repo, epoch: 1, active: true, signal: activity.signal } };
  const listeners: Parameters<PullRequestReadServiceV1['watchList']>[1][] = []; const cleanup = vi.fn();
  const watchList = vi.fn<PullRequestReadServiceV1['watchList']>((query, listener) => { listeners.push(listener); listener({ status: 'available', value: { version: 1, repo: query.repo, kind, items: [pr], quality: 'complete', truncated: false, browseUrl: 'https://provider.example/more' } }); return cleanup; });
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, pullRequests: { version: 1, list: vi.fn(), watchList } }, navigate: vi.fn(), saveState: vi.fn(), onDispose: vi.fn() };
  const emit = (patch: Partial<PullRequestReadPageV1>, index = listeners.length - 1) => listeners[index]?.({ status: 'available', value: { version: 1, repo, kind, items: [pr], quality: 'complete', truncated: false, browseUrl: null, ...patch } });
  return { container, lifetime, activity, state, context, watchList, cleanup, listeners, emit };
}
afterEach(() => document.body.replaceChildren());
describe.each([['repository pull requests', repoprs, 'repo-open', 100], ['shipped', shipped, 'authored-recent', 12]] as const)('%s standalone panel', (_name, module, kind, limit) => {
  it('uses only the narrow bounded current-galleon read contract and provider-supplied URLs', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context);
    expect(f.watchList).toHaveBeenCalledWith({ version: 1, repo, kind, limit }, expect.any(Function), expect.any(AbortSignal));
    expect(f.container.textContent).toContain(pr.title); expect(f.container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe(pr.url);
    expect(f.container.querySelector('a[target="_blank"]')?.getAttribute('rel')).toBe('noopener noreferrer'); f.lifetime.abort();
  });
  it('preserves PR identity and review setup links without issuing mutations', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context);
    const detail = f.container.querySelector('a[href^="/prs"]')!; const params = new URL(detail.getAttribute('href')!, 'https://host.test').searchParams;
    expect(Object.fromEntries(params)).toEqual({ repo, prRepo: repo, pr: '42', pane: 'lookup' }); detail.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(f.context.navigate).toHaveBeenCalledWith(detail.getAttribute('href')); const setup = f.container.querySelector('a[href^="/runs"]')!;
    expect(Object.fromEntries(new URL(setup.getAttribute('href')!, 'https://host.test').searchParams)).toEqual({ repo, prRepo: repo, pr: '42', pane: 'newrun', mode: 'review' }); f.lifetime.abort();
  });
  it('suspends watches when hidden and cancels replaced epochs and disposed lifetimes', async () => {
    const f = fixture(kind); const instance = await module.mount(f.container, f.context); await instance.update({ ...f.state, visible: false });
    expect(f.cleanup).toHaveBeenCalledTimes(1); expect(f.watchList.mock.calls[0]?.[2]?.aborted).toBe(true);
    f.emit({ items: [{ ...pr, title: 'Late result' }] }); expect(f.container.textContent).not.toContain('Late result');
    await instance.update(f.state); expect(f.watchList).toHaveBeenCalledTimes(2); f.lifetime.abort(); expect(f.cleanup).toHaveBeenCalledTimes(2); await instance.refresh?.(); expect(f.watchList).toHaveBeenCalledTimes(2);
  });
  it('ignores late results and removes prior data when repository scope changes', async () => {
    const f = fixture(kind); const instance = await module.mount(f.container, f.context); f.activity.abort(); const activity = new AbortController();
    await instance.update({ ...f.state, repo: 'org/other', activity: { repo: 'org/other', epoch: 2, active: true, signal: activity.signal } });
    f.emit({ items: [{ ...pr, title: 'Late result' }] }, 0); expect(f.container.textContent).not.toContain('Late result'); expect(f.container.textContent).not.toContain(pr.title); f.lifetime.abort();
  });
  it('never presents partial or degraded empty windows as successful empty datasets', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context); f.emit({ items: [], quality: 'degraded' });
    expect(f.container.textContent).toContain('Some provider results are unavailable'); expect(f.container.textContent).not.toContain('No open'); expect(f.container.textContent).not.toContain('No recent');
    f.emit({ items: [], quality: 'partial', truncated: true }); expect(f.container.textContent).toContain('limited provider result window'); expect(f.container.textContent).not.toContain('No recent'); f.lifetime.abort();
  });
  it('distinguishes unavailable reads from a complete empty list', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context); f.listeners[0]?.({ status: 'unavailable', reason: 'service-unavailable' });
    expect(f.container.textContent).toContain('Pull requests are unavailable'); expect(f.container.textContent).not.toContain(pr.title);
    f.emit({ items: [] }); expect(f.container.textContent).toContain(kind === 'repo-open' ? 'No open pull requests' : 'No recent pull requests'); f.lifetime.abort();
  });
  it('keeps refresh available with provider navigation below the list', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context);
    expect(f.container.querySelector('header button')).toBeNull();
    const refresh = f.container.querySelector<HTMLButtonElement>('footer button')!;
    expect(refresh.textContent).toBe('Refresh'); refresh.click();
    await vi.waitFor(() => expect(f.watchList).toHaveBeenCalledTimes(2)); f.lifetime.abort();
  });
  it('preserves unknown counts, known zero counts, literal hostile text, and keyboard focus', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context); expect(f.container.textContent).not.toContain('Comments:'); expect(f.container.textContent).not.toContain('Approvals:');
    const refresh = f.container.querySelector('button')!; refresh.focus(); f.emit({ items: [{ ...pr, title: '<img src=x onerror=alert(1)>', comments: 0, reviews: { approved: 0, changesRequested: null, commented: 0, requested: 2 } }] });
    expect(f.container.querySelector('img')).toBeNull(); expect(f.container.textContent).toContain('Comments: 0'); expect(f.container.textContent).toContain('Approvals: 0'); expect(f.container.textContent).toContain('Pending reviews: 2');
    expect(document.activeElement).toBe(f.container.querySelector('button')); f.lifetime.abort();
  });
  it('never constructs or exposes unsafe provider links', async () => {
    const f = fixture(kind); await module.mount(f.container, f.context); f.emit({ browseUrl: 'javascript:alert(1)', items: [{ ...pr, url: 'https://secret@provider.test/pull/42' }] });
    expect(f.container.querySelector('a[target="_blank"]')).toBeNull(); expect(f.container.querySelector('a[href^="/prs"]')).not.toBeNull(); f.lifetime.abort();
  });
  it('keeps theme and pirate wording updates local without restarting reads', async () => {
    const f = fixture(kind); const instance = await module.mount(f.container, f.context); await instance.update({ ...f.state, pirateMode: true, themeId: 'light' });
    expect(f.container.textContent).toContain(kind === 'repo-open' ? 'Galleon pull requests' : 'Out to sea'); expect(f.watchList).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
});
it('repository PR panel asks for scope instead of reading all repositories', async () => {
  const f = fixture('repo-open'); f.context = { ...f.context, state: { ...f.state, repo: null } }; await repoprs.mount(f.container, f.context);
  expect(f.watchList).not.toHaveBeenCalled(); expect(f.container.textContent).toContain('Select a repository'); f.lifetime.abort();
});
it('Shipped includes open review, changes-requested, closed and merged PRs without treating them as worker outcomes', async () => {
  const f = fixture('authored-recent'); f.context = { ...f.context, state: { ...f.state, repo: null } }; await shipped.mount(f.container, f.context);
  f.emit({ repo: null, items: [{ ...pr, number: 1, reviewDecision: 'CHANGES_REQUESTED' }, { ...pr, number: 2, status: 'closed' }, { ...pr, number: 3, status: 'merged', mergedAt: pr.createdAt }, { ...pr, number: 4 }] });
  expect(f.container.querySelectorAll('li')).toHaveLength(4); for (const label of ['Changes requested', 'Closed', 'Merged', 'Open']) expect(f.container.textContent).toContain(label);
  expect(f.container.querySelectorAll('a[href^="/runs"]')).toHaveLength(2); expect(f.container.textContent).not.toContain('Worker:'); f.lifetime.abort();
});
