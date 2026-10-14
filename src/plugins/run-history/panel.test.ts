import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelInstance, PluginPanelState, RunInspectHistoryPageV1, RunInspectServiceV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import panel from './panel';

const instances: PluginPanelInstance[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); document.body.replaceChildren(); });
const available = <T>(value: T) => ({ status: 'available' as const, value });
const when = '2026-09-20T00:00:00Z';
const run = (id: string, repo = 'org/a'): RunReadSummaryV1 => ({ version: 1, repo, id, displayKey: id, status: 'failed', attempt: 1, startedAt: when, endedAt: when, prNumber: null, costUsd: null, review: null, sourceSettlement: { state: 'pending' } });
const page = (overrides: Partial<RunInspectHistoryPageV1> = {}): RunInspectHistoryPageV1 => ({ version: 1, repo: 'org/a', items: [run('first')], nextCursor: 'next', total: 101, totalQuality: 'exact', observedAt: when, coverage: 'insertion-bounded-current-state', ...overrides });
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
async function mount(history: RunInspectServiceV1['history'] = vi.fn(async () => available(page())), overrides: Partial<PluginPanelState> = {}) {
  const activity = new AbortController(); const lifetime = new AbortController();
  const state: PluginPanelState = { repo: 'org/a', visible: true, themeId: 'default', pirateMode: false, pane: null, instanceId: 'history', savedState: null,
    activity: { epoch: 1, repo: 'org/a', active: true, signal: activity.signal }, ...overrides };
  const inspect: RunInspectServiceV1 = { version: 1, history, resolve: vi.fn(), log: vi.fn(), exportLog: vi.fn() };
  const selectPresentation = vi.fn(); const saveState = vi.fn(async () => {});
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, runInspect: inspect }, selectPresentation,
    onDispose: vi.fn(), navigate: vi.fn(), saveState };
  const container = document.createElement('div'); document.body.append(container); const instance = await panel.mount(container, context); instances.push(instance);
  return { container, instance, state, activity, lifetime, selectPresentation, saveState, context };
}
describe('authored bounded run history', () => {
  it('names same-key runs by galleon, canonical run and attempt without changing action scope', async () => {
    const items = [run('one', 'org/a'), run('two', 'org/b'), run('three', 'org/a')].map(value => ({ ...value, displayKey: 'TASK-1' }));
    const f = await mount(vi.fn(async () => available(page({ repo: null, items, nextCursor: null }))), { repo: null, activity: { epoch: 1, repo: null, active: true, signal: new AbortController().signal } });
    await vi.waitFor(() => expect(f.container.querySelectorAll('[data-run-id]')).toHaveLength(3));
    const buttons = [...f.container.querySelectorAll<HTMLButtonElement>('[data-run-id] button')];
    expect(buttons.map(value => value.getAttribute('aria-label'))).toEqual(items.map(value => `TASK-1 · ${value.repo} · ${value.id} · Attempt 1`));
    buttons[1]!.click(); expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/b', runId: 'two' });
    expect(f.state.repo).toBeNull();
  });
  it('reports observation-time total separately from the loaded page and selects canonical scope', async () => {
    const history = vi.fn<RunInspectServiceV1['history']>(async () => available(page())); const f = await mount(history);
    await vi.waitFor(() => expect(f.container.textContent).toContain('101 matching runs observed'));
    expect(f.container.textContent).toContain('1 runs shown'); expect(f.container.textContent).toContain('Statuses may change between pages');
    expect(f.container.textContent).toContain('Worker: failed'); expect(f.container.textContent).toContain('Source settlement: pending');
    expect(history).toHaveBeenCalledWith({ version: 1, repo: 'org/a', kind: 'all', cursor: null, limit: 50 }, expect.any(AbortSignal));
    button(f.container, 'first').click(); expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'first' });
  });
  it('supports backward and forward cursor navigation without retaining every page of runs', async () => {
    const history = vi.fn<RunInspectServiceV1['history']>(async input => available(input.cursor ? page({ items: [run('second')], nextCursor: null, total: 99 }) : page()));
    const f = await mount(history); await vi.waitFor(() => expect(button(f.container, 'Next page')?.disabled).toBe(false));
    button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2'));
    expect(f.container.textContent).not.toContain('first'); expect(f.container.textContent).toContain('99 matching runs');
    button(f.container, 'Previous page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 1'));
    button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2'));
    expect(history.mock.calls.map(call => call[0].cursor)).toEqual([null, 'next', null, 'next']);
  });
  it('renders an unknown total honestly', async () => {
    const f = await mount(vi.fn(async () => available(page({ total: null, totalQuality: 'unknown', nextCursor: null }))));
    await vi.waitFor(() => expect(f.container.textContent).toContain('Total unknown'));
    expect(f.container.textContent).not.toContain('1 matching runs');
  });
  it('ignores late data after effective scope changes and aborts old requests', async () => {
    let finish!: (result: ReturnType<typeof available<RunInspectHistoryPageV1>>) => void;
    const pending = new Promise<ReturnType<typeof available<RunInspectHistoryPageV1>>>(done => { finish = done; });
    const history = vi.fn<RunInspectServiceV1['history']>().mockImplementationOnce(() => pending).mockImplementation(async input => available(page({ repo: input.repo, items: [run('foreign-current', 'org/b')], nextCursor: null })));
    const f = await mount(history); expect(history).toHaveBeenCalledOnce(); const signal = history.mock.calls[0]?.[1];
    f.activity.abort(); const next = new AbortController(); await f.instance.update({ ...f.state, repo: 'org/b', activity: { epoch: 2, repo: 'org/b', active: true, signal: next.signal } });
    finish(available(page())); await vi.waitFor(() => expect(f.container.textContent).toContain('foreign-current'));
    expect(f.container.textContent).not.toContain('first'); expect(signal?.aborted).toBe(true);
  });
  it('uses an explicit panel scope instead of the unrelated header scope', async () => {
    const signal = new AbortController().signal;
    const history = vi.fn<RunInspectServiceV1['history']>(async input => available(page({ repo: input.repo, items: [run('override', 'org/b')] })));
    const f = await mount(history, { repo: 'org/a', activity: { epoch: 1, repo: 'org/b', active: true, signal } });
    await vi.waitFor(() => expect(button(f.container, 'override')).toBeTruthy()); button(f.container, 'override').click();
    expect(history.mock.calls[0]?.[0].repo).toBe('org/b'); expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/b', runId: 'override' }); expect(f.state.repo).toBe('org/a');
  });
  it('keeps a failed next-page read on the prior page and recovers with the same cursor', async () => {
    const history = vi.fn<RunInspectServiceV1['history']>().mockResolvedValueOnce(available(page())).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(available(page({ items: [run('second')], nextCursor: null })));
    const f = await mount(history); await vi.waitFor(() => expect(button(f.container, 'Next page')?.disabled).toBe(false)); button(f.container, 'Next page').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('offline')); expect(f.container.textContent).toContain('Page 1'); expect(f.container.textContent).toContain('first');
    button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2')); expect(history.mock.calls[2]?.[0].cursor).toBe('next');
  });
  it('preserves unsupported saved filters without writing replacement state', async () => {
    const f = await mount(undefined, { savedState: { version: 9, value: {} } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('unsupported version'));
    expect(f.container.querySelector('select')?.disabled).toBe(true); expect(f.saveState).not.toHaveBeenCalled();
  });
});

it.each([false, true])('renders truthful feedback history in either terminology mode (%s)', async pirateMode => {
  const feedbackOutcome = { state: 'completed' as const, headSha: 'a'.repeat(40), summary: '<img src=x onerror=alert(1)>' };
  const items: RunReadSummaryV1[] = [
    { ...run('one'), status: 'succeeded', feedbackOutcome },
    { ...run('two'), feedbackOutcome },
    { ...run('three'), status: 'running', sourceSettlement: null, feedbackOutcome: { ...feedbackOutcome, state: 'awaiting_decision' } },
  ];
  const f = await mount(vi.fn(async () => available(page({ items }))), { pirateMode });
  await vi.waitFor(() => expect(f.container.querySelectorAll('.run-feedback-outcome')).toHaveLength(3));
  expect([...f.container.querySelectorAll('.run-feedback-outcome')].map(el => el.textContent)).toEqual(['Feedback completed', 'Feedback remaining', 'Awaiting decision']);
  expect(f.container.textContent).toContain('Worker: failed'); expect(f.container.querySelector('img')).toBeNull();
});

it.each([false, true])('identifies reviewed targets with retained subject and galleon in terminology mode %s', async pirateMode => {
  const title = 'Fix login <img src=x onerror=alert(1)>';
  const item = { ...run('opaque-id', 'org/b'), displayKey: 'REVIEW', title, prNumber: 42 };
  const f = await mount(vi.fn(async () => available(page({ repo: 'org/b', items: [item] }))), { pirateMode, headerRepo: 'org/a', activity: { epoch: 1, repo: 'org/b', active: true, signal: new AbortController().signal } });
  await vi.waitFor(() => expect(f.container.querySelector('.run-subject')?.textContent).toBe(title));
  const open = f.container.querySelector<HTMLButtonElement>('.run-open')!;
  expect(open.getAttribute('aria-label')).toContain('org/b · opaque-id · Attempt 1');
  open.click(); expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/b', runId: 'opaque-id' });
  const link = f.container.querySelector('a');
  expect(link?.textContent).toBe(`${pirateMode ? 'Bounty' : 'PR'} #42`); expect(link?.title).toBe('org/b#42'); expect(link?.getAttribute('aria-label')).toContain('org/b');
  expect(link?.getAttribute('href')).toBe('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  link?.click(); expect(f.context.navigate).toHaveBeenCalledWith('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  expect(f.container.querySelector('img')).toBeNull(); expect(f.state.repo).toBe('org/a');
});

it('preserves header All when the panel has an explicit scope and leaves modified link clicks to the browser', async () => {
  const item = { ...run('review-id', 'org/b'), displayKey: 'review', title: 'review #42', prNumber: 42 };
  const f = await mount(vi.fn(async () => available(page({ repo: 'org/b', items: [item] }))), { repo: 'org/b', headerRepo: null, activity: { epoch: 1, repo: 'org/b', active: true, signal: new AbortController().signal } });
  await vi.waitFor(() => expect(f.container.querySelector('a')).toBeTruthy());
  const link = f.container.querySelector('a'); expect(link?.getAttribute('href')).toBe('/prs?prRepo=org%2Fb&pr=42');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  link?.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); expect(f.context.navigate).not.toHaveBeenCalled();
  expect(f.container.querySelector('.run-subject')).toBeNull();
});

it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('omits links for reviews without a valid retained PR number (%s)', async prNumber => {
  const f = await mount(vi.fn(async () => available(page({ items: [{ ...run('old-review'), displayKey: 'review', prNumber }] }))));
  await vi.waitFor(() => expect(button(f.container, 'Review')).toBeTruthy());
  expect(f.container.querySelector('a')).toBeNull();
});

it('leads with the retained subject while keeping immutable identities and full evidence in native Details', async () => {
  const item = { ...run('canonical-id'), displayKey: 'review', title: 'Fix login behavior', status: 'succeeded' as const, review: { outcome: 'REQUEST_CHANGES' as const, verdict: 'Fix <img src=x onerror=alert(1)>' } };
  const f = await mount(vi.fn(async () => available(page({ items: [item] }))));
  await vi.waitFor(() => expect(f.container.querySelector('.run-open')?.textContent).toBe(item.title));
  const details = f.container.querySelector<HTMLDetailsElement>('.run-details')!; expect(details.open).toBe(false);
  expect(details.textContent).toContain('canonical-id · Attempt 1'); expect(details.textContent).toContain('Started 2026-09-20T00:00:00Z');
  expect(details.textContent).toContain('Review recommendation: REQUEST_CHANGES'); expect(details.textContent).toContain(item.review.verdict);
  expect(f.container.querySelector('.run-open')?.getAttribute('aria-label')).toContain(item.title);
  expect(f.container.querySelector('.run-worker')?.textContent).toContain('Worker completed'); expect(f.container.querySelector('.run-recommendation')?.textContent).toContain('Recommendation: Changes requested');
  expect(f.container.querySelector('.run-started')?.textContent).toContain('Sep 20, 2026'); expect(f.container.querySelector('.run-started time')?.getAttribute('datetime')).toBe(when);
  expect(f.container.querySelector('img')).toBeNull(); f.container.querySelector<HTMLButtonElement>('.run-open')?.click();
  expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: item.repo, runId: item.id });
});

it('retains open Details and canonical selection focus across same-scope refreshes', async () => {
  const f = await mount(); await vi.waitFor(() => expect(f.container.querySelector('.run-details')).not.toBeNull());
  const details = f.container.querySelector<HTMLDetailsElement>('.run-details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
  f.container.querySelector<HTMLButtonElement>('.run-open')!.focus(); await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>('.run-details')?.open).toBe(true);
  expect(document.activeElement?.classList.contains('run-open')).toBe(true);
});

it('retains the correct observed page and cursors when a fresh observation fails, then resets on recovery', async () => {
  const history = vi.fn<RunInspectServiceV1['history']>().mockResolvedValueOnce(available(page())).mockResolvedValueOnce(available(page({ items: [run('second')], nextCursor: null }))).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(available(page()));
  const f = await mount(history); await vi.waitFor(() => expect(button(f.container, 'Next page')?.disabled).toBe(false)); button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2'));
  await f.instance.refresh?.(); expect(f.container.textContent).toContain('Showing the last observed page.'); expect(f.container.textContent).toContain('Page 2'); expect(f.container.textContent).toContain('second');
  await f.instance.refresh?.(); expect(f.container.textContent).toContain('Page 1'); expect(f.container.textContent).not.toContain('Showing the last observed page.');
  expect(history.mock.calls.map(call => call[0].cursor)).toEqual([null, 'next', null, null]);
});

it('delegates composed Refresh and heading to its host while keeping a labeled status filter', async () => {
  const f = await mount(); await vi.waitFor(() => expect(f.container.querySelector('.run-row')).not.toBeNull());
  expect(f.container.querySelector('h2')?.textContent).toContain('Run history'); expect(f.container.querySelector('[data-focus="refresh"]')).not.toBeNull();
  const wrapper = document.createElement('div'); wrapper.dataset.compositionPage = ''; document.body.append(wrapper); wrapper.append(f.container);
  await f.instance.update(f.state); expect(f.container.querySelector('h2')?.textContent).toContain('Run history'); expect(f.container.querySelector('[data-focus="refresh"]')).toBeNull();
  wrapper.className = 'plugin-run-history'; await f.instance.update(f.state); expect(f.container.querySelector('h2')).toBeNull();
  expect(f.container.querySelector('.run-filters label')?.textContent).toContain('Status'); expect(f.container.querySelector('option[value="terminal"]')?.textContent).toBe('Finished');
});

it('keeps operator intervention visible when a worker completes', async () => {
  const item = { ...run('finished'), status: 'succeeded' as const, sourceSettlement: { state: 'operator-required' as const } };
  const f = await mount(vi.fn(async () => available(page({ items: [item] }))));
  await vi.waitFor(() => expect(f.container.querySelector('.run-settlement')?.textContent).toContain('Needs action'));
  expect(f.container.querySelector('.run-settlement')?.closest('.run-details')).toBeNull();
  expect(f.container.querySelector('.run-details')?.textContent).toContain('Source settlement: operator-required');
});

it('starts history open and retains collapsed state and summary focus through refresh', async () => {
  const f = await mount(); await vi.waitFor(() => expect(f.container.querySelector('.run-row')).not.toBeNull());
  const disclosure = f.container.querySelector<HTMLDetailsElement>('.run-history-panel')!; expect(disclosure.open).toBe(true);
  expect(disclosure.querySelector(':scope > summary')?.textContent).toContain('Run history'); expect(disclosure.querySelector(':scope > summary > .run-history-caret')?.getAttribute('aria-hidden')).toBe('true');
  disclosure.open = false; const summary = disclosure.querySelector<HTMLElement>(':scope > summary')!; summary.focus(); await f.instance.refresh?.();
  const refreshed = f.container.querySelector<HTMLDetailsElement>('.run-history-panel')!; expect(refreshed.open).toBe(false); expect(document.activeElement).toBe(refreshed.querySelector(':scope > summary'));
  refreshed.open = true; await f.instance.refresh?.(); expect(f.container.querySelector<HTMLDetailsElement>('.run-history-panel')?.open).toBe(true);
});
it('retains panel collapse across scope and status changes without changing existing filter requests', async () => {
  const history = vi.fn<RunInspectServiceV1['history']>(async query => available(page({ repo: query.repo, items: [run('scoped', query.repo ?? 'org/a')] })));
  const f = await mount(history); await vi.waitFor(() => expect(f.container.querySelector('.run-row')).not.toBeNull());
  f.container.querySelector<HTMLDetailsElement>('.run-history-panel')!.open = false;
  f.instance.update({ ...f.state, repo: 'org/b', activity: { epoch: 2, repo: 'org/b', active: true, signal: new AbortController().signal } });
  await vi.waitFor(() => expect(history.mock.calls.at(-1)?.[0].repo).toBe('org/b')); expect(f.container.querySelector<HTMLDetailsElement>('.run-history-panel')?.open).toBe(false);
  const filter = f.container.querySelector<HTMLSelectElement>('[data-focus="filter"]')!; filter.value = 'terminal'; filter.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(history.mock.calls.at(-1)?.[0].kind).toBe('terminal')); expect(f.container.querySelector<HTMLDetailsElement>('.run-history-panel')?.open).toBe(false);
});
it('preserves row evidence disclosure through outer collapse and refresh', async () => {
  const f = await mount(); await vi.waitFor(() => expect(f.container.querySelector('.run-row')).not.toBeNull());
  const row = f.container.querySelector<HTMLDetailsElement>('.run-details')!; row.open = true; row.dispatchEvent(new Event('toggle'));
  f.container.querySelector<HTMLDetailsElement>('.run-history-panel')!.open = false; await f.instance.refresh?.();
  expect(f.container.querySelector<HTMLDetailsElement>('.run-details')?.open).toBe(true); expect(f.container.querySelector<HTMLDetailsElement>('.run-history-panel')?.open).toBe(false);
});
