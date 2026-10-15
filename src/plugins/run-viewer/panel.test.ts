import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRequestV1, PluginPanelContext, PluginPanelInstance, PluginPanelState, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, RunCommandServiceV1, RunInspectLogPageV1, RunInspectServiceV1, RunReadServiceV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import panel from './panel';

const instances: PluginPanelInstance[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); document.body.replaceChildren(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const available = <T>(value: T) => ({ status: 'available' as const, value });
const target = { repo: 'org/a', runId: 'one', expectedAttempt: 1 };
const when = '2026-09-20T00:00:00Z';
const summary = (id = 'one', attempt = 1): RunReadSummaryV1 => ({ version: 1, id, repo: 'org/a', displayKey: id.toUpperCase(), status: 'running', attempt, startedAt: when, endedAt: null, prNumber: null, costUsd: null, review: null, sourceSettlement: null });
const event = (sequence: number) => ({ sequence, at: when, kind: 'log', text: `event ${sequence}`, truncated: false });
const page = (overrides: Partial<RunInspectLogPageV1> = {}): RunInspectLogPageV1 => ({ version: 1, target, provenance: 'run-wide', observedAt: when, workerStatus: 'running', events: [event(51)], throughSequence: 51, hasEarlier: true, hasLater: false, nextCursor: 'older-51', followCursor: 'follow-51', ...overrides });
const requestId = '00000000-0000-4000-8000-000000000001';
const receipt = (status: RunCommandReceiptV1['status'] = 'accepted'): RunCommandReceiptV1 => ({ version: 1, repo: 'org/a', requestId, action: 'stop', status, runId: 'one', attempt: 1, message: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

async function mount(options: { state?: Partial<PluginPanelState>; inspect?: Partial<RunInspectServiceV1>; list?: RunReadServiceV1['list']; composed?: boolean; saved?: RunCommandPendingV1[]; saveState?: PluginPanelContext['saveState']; selector?: boolean; whiteboard?: PluginPanelContext['services']['whiteboard']; status?: RunReadSummaryV1['status'] } = {}) {
  const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo: 'org/a', themeId: 'default', pirateMode: false, visible: true, pane: null, instanceId: 'viewer', savedState: null,
    activity: { epoch: 1, repo: 'org/a', active: true, signal: activity.signal }, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'one' }, ...options.state };
  let pending = options.saved ?? [];
  const inspect: RunInspectServiceV1 = { version: 1, resolve: vi.fn(async input => available({ version: 1 as const, target: { ...target, runId: input.runId }, observedAt: when })),
    history: vi.fn(), log: vi.fn(async input => available(page({ target: input.target }))), exportLog: vi.fn(), ...options.inspect };
  const runs = { version: 1 as const, list: vi.fn<RunReadServiceV1['list']>(options.list ?? (async query => available({ version: 1, repo: query.repo, items: [], nextCursor: null }))), log: vi.fn(), load: vi.fn(async (input: { runId: string }) => available({ version: 1 as const, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), ...(options.status ? { status: options.status } : {}) } })), watchList: vi.fn(), watchLoad: vi.fn(), watchLog: vi.fn() };
  const commands = { version: 1 as const,
    submit: vi.fn(async (input: RunCommandInputV1) => { const result = { ...receipt(), action: input.action }; pending = [{ command: { ...input, requestId }, receipt: result }]; return available(result); }),
    retry: vi.fn<NonNullable<RunCommandServiceV1['retry']>>(async query => {
      const entry = pending.find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
      if (!entry) return { status: 'unavailable', reason: 'not-found' };
      const result = { ...receipt(), ...query, action: entry.command.action }; pending = pending.map(value => value === entry ? { ...entry, receipt: result } : value); return available(result);
    }),
    pending: vi.fn(async () => pending), receipt: vi.fn(async () => available(pending[0]?.receipt ?? null)),
    acknowledge: vi.fn(async () => { pending = []; }) };
  const downloads = { version: 1 as const, save: vi.fn(async (_request: DownloadRequestV1, _signal?: AbortSignal) => ({ status: 'delivered-to-browser' as const, bytesWritten: 1 })) };
  const selectPresentation = options.selector === false ? undefined : vi.fn();
  const saveState = options.saveState ?? vi.fn(async () => {});
  const container = document.createElement('div');
  if (options.composed) { const composition = document.createElement('div'); composition.dataset.compositionPage = 'viewer'; composition.append(container); document.body.append(composition); }
  else document.body.append(container);
  const context: PluginPanelContext = { state, signal: lifetime.signal, activity: state.activity, services: { version: 1, runInspect: inspect, runs, runCommands: commands, downloads, whiteboard: options.whiteboard },
    saveState, onDispose: vi.fn(), navigate: vi.fn(), selectPresentation };
  const instance = await panel.mount(container, context); instances.push(instance);
  return { container, instance, context, inspect, runs, commands, downloads, state, activity, lifetime, selectPresentation, saveState, pending: () => pending, setPending: (value: RunCommandPendingV1[]) => { pending = value; } };
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
async function ready(root: HTMLElement) { await vi.waitFor(() => expect(button(root, 'Stop run')?.disabled).toBe(false)); }

it.each(['APPROVE', 'REQUEST_CHANGES'] as const)('opens a prepared %s review draft from the recommendation without publishing', async outcome => {
  const f = await mount({ state: { headerRepo: 'org/header' }, status: 'succeeded' });
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), status: 'succeeded', prNumber: 42, review: { outcome, verdict: 'Reviewed recommendation' } } }));
  await f.instance.refresh?.();
  const action = f.container.querySelector<HTMLButtonElement>(`[data-prepare-review="${outcome}"]`)!;
  expect(action).not.toBeNull(); expect(action.querySelector('[data-icon]')).not.toBeNull(); action.click();
  const href = vi.mocked(f.context.navigate).mock.calls.at(-1)?.[0]; expect(href).toBeTruthy();
  const url = new URL(href!, window.location.origin); expect(url.pathname).toBe('/prs'); expect(url.searchParams.get('repo')).toBe('org/header'); expect(url.search).not.toContain('Reviewed');
  const routed = JSON.parse(url.searchParams.get('panelState')!)['helmsman.compat-pr/panel']; expect(routed.value.target).toEqual({ repo: 'org/a', number: 42 });
  expect(f.commands.submit).not.toHaveBeenCalled(); expect(f.selectPresentation).not.toHaveBeenCalled();
});

describe('authored run viewer lifecycle and commands', () => {
  it('offers recent scoped runs without selecting or running commands until a choice is made', async () => {
    const f = await mount({ state: { presentation: null, headerRepo: 'org/header' }, composed: true,
      list: async query => available({ version: 1, repo: query.repo, items: [{ ...summary(), title: 'Recent work' }, { ...summary('other'), repo: 'org/b' }], nextCursor: null }) });
    await vi.waitFor(() => expect(f.container.querySelectorAll('[data-select-run]')).toHaveLength(1));
    expect(f.runs.list).toHaveBeenCalledWith({ version: 1, repo: 'org/a', kind: 'all', limit: 10, cursor: null }, expect.any(AbortSignal));
    expect(f.container.querySelector('h2')).toBeNull(); expect(button(f.container, 'Refresh')).toBeUndefined();
    expect(f.container.textContent).toContain('Recent work'); expect(f.container.textContent).not.toContain('org/b');
    expect(f.selectPresentation).not.toHaveBeenCalled(); expect(f.inspect.resolve).not.toHaveBeenCalled(); expect(f.commands.submit).not.toHaveBeenCalled();
    f.container.querySelector<HTMLButtonElement>('[data-select-run="one"]')!.click();
    expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'one' });
    expect(f.state.headerRepo).toBe('org/header'); expect(f.context.navigate).not.toHaveBeenCalled();
    await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'one' } }); await ready(f.container);
    expect(f.container.querySelector('.run-picker')).toBeNull(); expect(f.container.querySelector('pre')?.textContent).toContain('event 51');
  });
  it('shows empty and failed recent run reads with refresh recovery', async () => {
    const f = await mount({ state: { presentation: null } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('No runs in this scope yet.'));
    f.runs.list.mockResolvedValueOnce({ status: 'unavailable', reason: 'connection-failed' });
    await f.instance.refresh?.(); expect(f.container.querySelector('.run-picker [role=alert]')?.textContent).toContain('Refresh to try again.');
    await f.instance.refresh?.(); expect(f.container.textContent).toContain('No runs in this scope yet.');
    expect(f.commands.submit).not.toHaveBeenCalled();
  });
  it('cancels recent chooser reads on scope changes and disposal and ignores late rows', async () => {
    const late = deferred<Awaited<ReturnType<RunReadServiceV1['list']>>>();
    const f = await mount({ state: { presentation: null }, list: () => late.promise });
    await vi.waitFor(() => expect(f.runs.list).toHaveBeenCalledOnce());
    expect(f.container.textContent).toContain('Loading recent runs…'); const signal = f.runs.list.mock.calls[0]?.[1];
    f.runs.list.mockImplementationOnce(async query => available({ version: 1, repo: query.repo, items: [], nextCursor: null }));
    const activity = new AbortController(); await f.instance.update({ ...f.state, repo: 'org/b', presentation: null, activity: { epoch: 2, repo: 'org/b', active: true, signal: activity.signal } });
    late.resolve(available({ version: 1, repo: 'org/a', items: [summary()], nextCursor: null }));
    await vi.waitFor(() => expect(f.container.textContent).toContain('No runs in this scope yet.')); expect(signal?.aborted).toBe(true);
    expect(f.container.querySelector('[data-select-run]')).toBeNull(); expect(f.selectPresentation).not.toHaveBeenCalled();
    const after = deferred<Awaited<ReturnType<RunReadServiceV1['list']>>>(); f.runs.list.mockImplementationOnce(() => after.promise);
    void f.instance.refresh?.(); await vi.waitFor(() => expect(f.runs.list).toHaveBeenCalledTimes(3)); const disposalSignal = f.runs.list.mock.calls[2]?.[1];
    f.instance.dispose(); after.resolve(available({ version: 1, repo: 'org/b', items: [], nextCursor: null })); await Promise.resolve();
    expect(disposalSignal?.aborted).toBe(true); expect(f.container.childNodes).toHaveLength(0);
  });
  it('restores a valid saved active run when the route has no selection', async () => {
    const f = await mount({ state: { presentation: null, savedState: { version: 1, value: { tabs: [{ repo: 'org/a', runId: 'one', scrollTop: 0, follow: true }], activeKey: JSON.stringify(['org/a', 'one']), results: [] } } } });
    await ready(f.container); expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'one' });
    expect(f.runs.list).not.toHaveBeenCalled(); expect(f.container.querySelector('pre')?.textContent).toContain('event 51');
    f.container.querySelector<HTMLButtonElement>('[aria-label="Close run one"]')!.click();
    await vi.waitFor(() => expect(f.container.querySelector('[role=tab]')).toBeNull());
    await f.instance.update({ ...f.state, presentation: null }); await f.instance.refresh?.();
    expect(f.selectPresentation).toHaveBeenLastCalledWith(null); expect(f.container.querySelector('[role=tab]')).toBeNull();
  });
  it.each([false, true])('closes the active run with a synchronously updating host (remaining tab: %s)', async remaining => {
    const f = await mount(); await ready(f.container);
    if (remaining) {
      await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'two' } });
      await vi.waitFor(() => expect(f.container.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label')).toContain('two'));
      await ready(f.container);
    }
    let hostState = { ...f.state, presentation: { version: 1 as const, kind: 'run' as const, repo: 'org/a', runId: remaining ? 'two' : 'one' } } as PluginPanelState;
    f.selectPresentation!.mockImplementation(presentation => {
      hostState = { ...hostState, presentation };
      void f.instance.update(hostState);
    });
    f.container.querySelector<HTMLButtonElement>(`[aria-label="Close run ${remaining ? 'two' : 'one'}"]`)!.click();
    await vi.waitFor(() => expect(f.container.querySelectorAll('[role=tab]')).toHaveLength(remaining ? 1 : 0));
    const expected = remaining ? { version: 1, kind: 'run', repo: 'org/a', runId: 'one' } : null;
    expect(hostState.presentation).toEqual(expected);
    expect(f.selectPresentation).toHaveBeenCalledExactlyOnceWith(expected);
    await f.instance.refresh?.();
    expect(f.container.querySelectorAll('[role=tab]')).toHaveLength(remaining ? 1 : 0);
    expect(hostState.presentation).toEqual(expected);
    await vi.waitFor(() => expect(f.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ tabs: remaining ? [expect.objectContaining({ runId: 'one' })] : [], activeKey: remaining ? JSON.stringify(['org/a', 'one']) : null }) })));
  });
  it('keeps the active tab when clearing the host selection fails', async () => {
    const f = await mount(); await ready(f.container);
    f.selectPresentation!.mockImplementation(() => { throw new Error('Host selection failed.'); });
    f.container.querySelector<HTMLButtonElement>('[aria-label="Close run one"]')!.click();
    expect(f.container.querySelectorAll('[role=tab]')).toHaveLength(1);
    expect(f.container.querySelector('[role=tab]')?.getAttribute('aria-selected')).toBe('true');
    expect(f.container.textContent).toContain('Host selection failed.');
    await f.instance.refresh?.();
    expect(f.container.querySelectorAll('[role=tab]')).toHaveLength(1);
    expect(f.container.querySelector('pre')?.textContent).toContain('event 51');
  });
  it.each(['outside-scope', 'pull-request'] as const)('does not restore a saved active run for %s', async scenario => {
    const f = await mount({ state: { presentation: scenario === 'pull-request' ? { version: 1, kind: 'pull-request', repo: 'org/a', number: 42 } : null,
      savedState: { version: 1, value: { tabs: [{ repo: scenario === 'outside-scope' ? 'org/b' : 'org/a', runId: 'one', scrollTop: 0, follow: true }], activeKey: JSON.stringify([scenario === 'outside-scope' ? 'org/b' : 'org/a', 'one']), results: [] } } } });
    await vi.waitFor(() => expect(f.saveState).toHaveBeenCalled()); expect(f.selectPresentation).not.toHaveBeenCalled(); expect(f.inspect.resolve).not.toHaveBeenCalled(); expect(f.container.querySelector('pre')).toBeNull();
  });
  it.each(['pull-request', 'outside-scope', 'unavailable-run'] as const)('offers recent runs after %s selection without replacing it automatically', async scenario => {
    const f = await mount({ state: { presentation: scenario === 'pull-request' ? { version: 1, kind: 'pull-request', repo: 'org/a', number: 42 }
      : { version: 1, kind: 'run', repo: scenario === 'outside-scope' ? 'org/b' : 'org/a', runId: 'unavailable' } },
      inspect: { resolve: vi.fn<RunInspectServiceV1['resolve']>(async () => ({ status: 'unavailable', reason: 'forbidden' })) },
      list: async query => available({ version: 1, repo: query.repo, items: [summary()], nextCursor: null }) });
    await vi.waitFor(() => expect(f.container.querySelector('[data-select-run="one"]')).not.toBeNull());
    expect(f.selectPresentation).not.toHaveBeenCalled(); expect(f.container.querySelector('pre')).toBeNull();
    if (scenario !== 'pull-request') expect(f.container.querySelector('[role=alert]')).not.toBeNull();
  });
  it('resolves canonical scope and preserves text as inert bounded log content', async () => {
    const f = await mount({ inspect: { log: vi.fn(async () => available(page({ events: [{ ...event(1), text: '<img src=x onerror=alert(1)>' }] }))) } });
    await ready(f.container); expect(f.container.querySelector('pre')?.textContent).toContain('<img src=x'); expect(f.container.querySelector('img')).toBeNull();
    expect(f.container.textContent).toContain('Run-wide log preview'); expect(f.container.textContent).toContain('Spend unknown');
  });
  it('distinguishes same-key run tabs and selects their canonical identity', async () => {
    const f = await mount(); await ready(f.container);
    f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), displayKey: 'TASK-1' } }));
    await f.instance.refresh?.();
    await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'two' } });
    await vi.waitFor(() => expect(f.container.querySelectorAll('[role="tab"]')).toHaveLength(2));
    await vi.waitFor(() => expect([...f.container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['TASK-1org/a · onerunning', 'TASK-1org/a · tworunning']));
    const tabs = [...f.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['TASK-1 · org/a · one · Attempt 1 · running', 'TASK-1 · org/a · two · Attempt 1 · running']);
    tabs[0]!.click();
    expect(f.selectPresentation).toHaveBeenLastCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'one' });
    expect(f.state.repo).toBe('org/a');
  });
  it('never replaces the live-follow cursor with an older-page cursor', async () => {
    const log = vi.fn<RunInspectServiceV1['log']>(async input => available(input.cursor === 'older-51' ? page({ events: [event(1)], nextCursor: null, followCursor: null, hasEarlier: false })
      : input.direction === 'forward' ? page({ events: [event(52)], nextCursor: 'follow-52', followCursor: null }) : page()));
    const f = await mount({ inspect: { log } }); await ready(f.container);
    button(f.container, 'Earlier logs').click(); await vi.waitFor(() => expect(button(f.container, 'Earlier logs')?.disabled).toBe(true));
    await vi.waitFor(() => expect(button(f.container, 'Stop run')?.disabled).toBe(false)); button(f.container, 'Follow latest').click();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.objectContaining({ direction: 'forward', cursor: 'follow-51' }), expect.any(AbortSignal)));
    expect(f.container.querySelector('pre')?.textContent).toContain('event 1');
  });
  it('aborts hidden activity and ignores reads that resolve after a scope change', async () => {
    const late = deferred<Awaited<ReturnType<RunInspectServiceV1['log']>>>(); const log = vi.fn<RunInspectServiceV1['log']>(() => late.promise);
    const f = await mount({ inspect: { log } }); await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    const signal = log.mock.calls[0]?.[1]; f.activity.abort(); const next = new AbortController();
    await f.instance.update({ ...f.state, repo: 'org/b', presentation: null, activity: { epoch: 2, repo: 'org/b', active: true, signal: next.signal } });
    late.resolve(available(page())); await Promise.resolve(); await Promise.resolve();
    expect(signal?.aborted).toBe(true); expect(f.container.textContent).not.toContain('event 51'); expect(f.container.textContent).not.toContain('org/a');
  });
  it('retains tabs, log DOM and focus across non-scope updates', async () => {
    const f = await mount(); await ready(f.container); const log = f.container.querySelector('pre')!; log.focus(); const count = vi.mocked(f.inspect.log).mock.calls.length;
    await f.instance.update({ ...f.state, themeId: 'dark', pirateMode: true });
    expect(f.container.querySelector('pre')).toBe(log); expect(document.activeElement).toBe(log); expect(vi.mocked(f.inspect.log).mock.calls).toHaveLength(count);
  });
  it('preserves selected log text and paused reading position through updates and refreshes', async () => {
    const f = await mount(); await ready(f.container); button(f.container, 'Pause follow').click();
    const log = f.container.querySelector('pre')!; log.scrollTop = 125; log.focus();
    const range = document.createRange(); range.selectNodeContents(log); const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range); const selectedText = selection.toString();
    await f.instance.update({ ...f.state, themeId: 'dark' }); await f.instance.refresh?.();
    expect(selectedText).toContain('event 51'); expect(selection.toString()).toBe(selectedText);
    expect(log.scrollTop).toBe(125); expect(document.activeElement).toBe(log);
    expect(button(f.container, 'Follow latest')).toBeDefined(); selection.removeAllRanges();
  });
  it('keeps earlier pagination available during background reads and queues a click until that read settles', async () => {
    const f = await mount(); await ready(f.container); const earlier = button(f.container, 'Earlier logs'); earlier.focus();
    const pending = deferred<Awaited<ReturnType<typeof f.runs.load>>>(); f.runs.load.mockReturnValueOnce(pending.promise);
    await f.instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 2 } });
    await vi.waitFor(() => expect(f.runs.load).toHaveBeenCalledTimes(2));
    expect(button(f.container, 'Earlier logs')).toBe(earlier); expect(earlier.disabled).toBe(false); expect(document.activeElement).toBe(earlier);
    earlier.click(); expect(earlier.disabled).toBe(true); expect(f.inspect.log).toHaveBeenCalledTimes(1);
    pending.resolve(available({ version: 1, repo: 'org/a', runId: 'one', run: summary() }));
    await vi.waitFor(() => expect(f.inspect.log).toHaveBeenLastCalledWith(expect.objectContaining({ direction: 'backward', cursor: 'older-51' }), expect.any(AbortSignal)));
    await ready(f.container); expect(earlier.disabled).toBe(false); expect(button(f.container, 'Earlier logs')).toBe(earlier);
  });
  it('keeps journal requests visible when their run tab closes', async () => {
    const saved: RunCommandPendingV1 = { command: { version: 1, requestId, repo: 'org/a', action: 'stop', target: { runId: 'one', expectedAttempt: 1 } }, receipt: null };
    const f = await mount({ saved: [saved] }); await vi.waitFor(() => expect(f.container.textContent).toContain('Outcome unknown'));
    f.container.querySelector<HTMLButtonElement>('[aria-label="Close run one"]')!.click();
    await vi.waitFor(() => expect(f.container.querySelector('[role="tab"]')).toBeNull());
    expect(f.container.textContent).toContain(requestId); expect(f.commands.acknowledge).not.toHaveBeenCalled(); expect(f.pending()).toEqual([saved]);
  });
  it('saves terminal results before acknowledgment and retains them after the journal entry disappears', async () => {
    const order: string[] = []; const saveState = vi.fn(async () => { order.push('save'); });
    const f = await mount({ saveState }); await ready(f.container); button(f.container, 'Stop run').click();
    await vi.waitFor(() => expect(button(f.container, 'Save result and dismiss request')?.disabled).toBe(false));
    f.commands.acknowledge.mockImplementation(async () => { order.push('ack'); f.setPending([]); }); order.length = 0;
    button(f.container, 'Save result and dismiss request').click();
    await vi.waitFor(() => expect(f.commands.acknowledge).toHaveBeenCalledOnce()); expect(order).toEqual(['save', 'ack']);
    expect(saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ results: [receipt()] }) }));
    expect(f.container.textContent).toContain('Saved command results (1)');
  });
  it('does not acknowledge a receipt when saving its result fails', async () => {
    const saveState = vi.fn(async () => { throw new Error('offline'); }); const f = await mount({ saveState }); await ready(f.container);
    button(f.container, 'Stop run').click(); await vi.waitFor(() => expect(button(f.container, 'Save result and dismiss request')?.disabled).toBe(false));
    button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('requests are not acknowledged'));
    expect(f.commands.acknowledge).not.toHaveBeenCalled(); expect(f.pending()).toHaveLength(1);
  });
  it('keeps the original attempt immutable when response loss is followed by a changed run attempt', async () => {
    const f = await mount(); await ready(f.container);
    f.commands.submit.mockImplementationOnce(async input => { f.setPending([{ command: { ...input, requestId }, receipt: null }]); throw new Error('lost response'); });
    button(f.container, 'Stop run').click(); await vi.waitFor(() => expect(button(f.container, 'Retry delivery')?.disabled).toBe(false));
    vi.mocked(f.inspect.resolve).mockImplementation(async () => available({ version: 1, target: { ...target, expectedAttempt: 2 }, observedAt: when }));
    f.runs.load.mockImplementation(async () => available({ version: 1, repo: 'org/a', runId: 'one', run: summary('one', 2) }));
    await f.instance.refresh?.(); expect(f.container.textContent).toContain('Original attempt 1'); expect(button(f.container, 'Stop run').disabled).toBe(true);
    button(f.container, 'Retry delivery').click(); await vi.waitFor(() => expect(f.commands.retry).toHaveBeenCalledWith({ repo: 'org/a', requestId }, expect.any(AbortSignal)));
    expect(f.commands.submit).toHaveBeenCalledOnce(); expect(f.pending()[0]?.command).toEqual({ version: 1, repo: 'org/a', requestId, action: 'stop', target: { runId: 'one', expectedAttempt: 1 } });
  });
  it('checks receipts without resubmitting and does not retry recovery-required requests', async () => {
    const f = await mount({ saved: [{ command: { version: 1, requestId, repo: 'org/a', action: 'stop', target: { runId: 'one', expectedAttempt: 1 } }, receipt: receipt('recovery-required') }] });
    await vi.waitFor(() => expect(button(f.container, 'Check request')).toBeTruthy()); button(f.container, 'Check request').click();
    await vi.waitFor(() => expect(f.commands.receipt).toHaveBeenCalledOnce()); expect(f.commands.submit).not.toHaveBeenCalled(); expect(button(f.container, 'Retry delivery')).toBeUndefined();
  });
  it('starts the download sink in the click call and delays export until destination readiness', async () => {
    const f = await mount(); await ready(f.container); let request: DownloadRequestV1 | undefined;
    const completion = deferred<{ status: 'delivered-to-browser'; bytesWritten: number }>();
    f.downloads.save.mockImplementation((input) => { request = input; return completion.promise; });
    vi.mocked(f.inspect.exportLog).mockImplementation(async () => available({ version: 1, target, observedAt: when, provenance: 'run-wide', throughSequence: 51, filename: 'helmsman-one.log', contentType: 'text/plain; charset=utf-8', stream: new ReadableStream() }));
    button(f.container, 'Download full log').click(); expect(f.downloads.save).toHaveBeenCalledOnce(); expect(f.inspect.exportLog).not.toHaveBeenCalled();
    await request!.open(new AbortController().signal); expect(f.inspect.exportLog).toHaveBeenCalledWith({ version: 1, target }, expect.any(AbortSignal));
    completion.resolve({ status: 'delivered-to-browser', bytesWritten: 1 }); await vi.waitFor(() => expect(f.container.textContent).toContain('Disk save is not confirmed.'));
  });
  it('cancels an active download on scope suspension', async () => {
    const f = await mount(); await ready(f.container); const late = deferred<{ status: 'delivered-to-browser'; bytesWritten: number }>();
    f.downloads.save.mockImplementation(() => late.promise); button(f.container, 'Download full log').click(); const signal = f.downloads.save.mock.calls[0]?.[1];
    f.activity.abort(); expect(signal?.aborted).toBe(true); late.resolve({ status: 'delivered-to-browser', bytesWritten: 9 }); await Promise.resolve();
    expect(f.container.textContent).not.toContain('Log delivered');
  });
  it('canonicalizes legacy selection through the public callback without changing header scope', async () => {
    const f = await mount({ state: { presentation: { version: 1, kind: 'legacy-run', runId: 'one' } } }); await ready(f.container);
    expect(f.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'one' }); expect(f.state.repo).toBe('org/a');
  });
  it('does not fall back to private navigation when presentation selection is unavailable', async () => {
    const f = await mount({ selector: false, state: { presentation: { version: 1, kind: 'legacy-run', runId: 'one' } } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Canonical run selection is unavailable.')); expect(f.context.navigate).not.toHaveBeenCalled();
  });
  it('retries a failed locator resolution when the operator refreshes', async () => {
    const resolve = vi.fn<RunInspectServiceV1['resolve']>().mockResolvedValueOnce({ status: 'unavailable', reason: 'connection-failed' })
      .mockResolvedValue(available({ version: 1, target, observedAt: when }));
    const f = await mount({ inspect: { resolve } }); await vi.waitFor(() => expect(f.container.textContent).toContain('Selected run is unavailable'));
    button(f.container, 'Refresh').click(); await ready(f.container); expect(f.container.querySelector('pre')?.textContent).toContain('event 51');
  });
  it('waits for an accepted run to become inspectable and replaces the previous viewer automatically', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn<RunInspectServiceV1['resolve']>().mockResolvedValueOnce({ status: 'unavailable', reason: 'not-found' })
      .mockImplementation(async input => available({ version: 1, target: { ...target, runId: input.runId }, observedAt: when }));
    const f = await mount({ state: { presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'new-run' },
      savedState: { version: 1, value: { tabs: [{ repo: 'org/a', runId: 'old-run', follow: true, scrollTop: 0 }], activeKey: JSON.stringify(['org/a', 'old-run']), results: [] } } }, inspect: { resolve } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.container.querySelector('.run-log')).toBeNull(); expect(f.container.textContent).toContain('Resolving selected run…');
    expect(f.runs.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.container.querySelector('.run-log')?.textContent).toContain('event 51');
    expect(f.container.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('new-run');
    expect(f.runs.load).toHaveBeenCalledWith({ version: 1, repo: 'org/a', runId: 'new-run' }, expect.any(AbortSignal));
    expect(f.state.repo).toBe('org/a'); expect(f.commands.submit).not.toHaveBeenCalled();
  });
  it('stops pending run resolution retries when the viewer scope changes', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn<RunInspectServiceV1['resolve']>(async () => ({ status: 'unavailable', reason: 'not-found' }));
    const f = await mount({ inspect: { resolve } }); await vi.advanceTimersByTimeAsync(0);
    const signal = resolve.mock.calls[0]?.[1];
    await f.instance.update({ ...f.state, repo: 'org/b', activity: { ...f.state.activity, repo: 'org/b', epoch: 2, signal: new AbortController().signal } });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(signal?.aborted).toBe(true); expect(resolve).toHaveBeenCalledTimes(1); expect(f.runs.load).not.toHaveBeenCalled();
    expect(f.container.querySelector('.run-log')).toBeNull();
  });
  it('bounds pending run resolution and preserves the unavailable result after retry exhaustion', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn<RunInspectServiceV1['resolve']>(async () => ({ status: 'unavailable', reason: 'not-found' }));
    const f = await mount({ inspect: { resolve } }); await vi.advanceTimersByTimeAsync(35_000);
    expect(resolve).toHaveBeenCalledTimes(13); expect(f.container.textContent).toContain('Selected run is unavailable');
    expect(f.container.querySelector('.run-log')).toBeNull(); expect(f.runs.load).not.toHaveBeenCalled();
  });
  it('rejects a canonical repository mismatch before reading run metadata or logs', async () => {
    const f = await mount({ inspect: { resolve: vi.fn(async () => available({ version: 1 as const, target: { ...target, repo: 'org/b' }, observedAt: when })) } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Selected run is unavailable'));
    expect(f.runs.load).not.toHaveBeenCalled(); expect(f.inspect.log).not.toHaveBeenCalled();
  });
  it('resumes an initial locator resolution cancelled while hidden', async () => {
    const first = deferred<Awaited<ReturnType<RunInspectServiceV1['resolve']>>>();
    const resolve = vi.fn<RunInspectServiceV1['resolve']>().mockImplementationOnce(() => first.promise).mockResolvedValue(available({ version: 1, target, observedAt: when }));
    const f = await mount({ inspect: { resolve } }); await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    f.activity.abort(); await f.instance.update({ ...f.state, visible: false, activity: { ...f.state.activity, active: false } });
    await f.instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 2, signal: new AbortController().signal } });
    await ready(f.container); first.resolve({ status: 'unavailable', reason: 'connection-failed' }); await Promise.resolve();
    expect(f.container.querySelector('pre')?.textContent).toContain('event 51'); expect(f.container.textContent).not.toContain('Selected run is unavailable');
  });
});

it.each(['missing', 'newer', 'unsupported'] as const)('does not create another viewer command when original request is %s', async scenario => {
  const saved: RunCommandPendingV1 = { command: { version: 1, requestId, repo: 'org/a', action: 'stop', target: { runId: 'one', expectedAttempt: 1 } }, receipt: null };
  const f = await mount({ saved: [saved] }); await vi.waitFor(() => expect(button(f.container, 'Retry delivery')?.disabled).toBe(false));
  if (scenario === 'unsupported') {
    const retry = f.commands.retry; delete f.context.services.runCommands!.retry; await f.instance.refresh?.();
    expect(button(f.container, 'Retry delivery').disabled).toBe(true); button(f.container, 'Retry delivery').click(); expect(retry).not.toHaveBeenCalled();
    button(f.container, 'Check request').click(); await vi.waitFor(() => expect(f.commands.receipt).toHaveBeenCalledOnce());
  } else {
    const preserved: RunCommandPendingV1[] = scenario === 'newer' ? [{ ...saved, command: { ...saved.command, requestId: '00000000-0000-4000-8000-000000000002' } }] : [];
    f.setPending(preserved); button(f.container, 'Retry delivery').click();
    await vi.waitFor(() => expect(f.commands.retry).toHaveBeenCalledWith({ repo: 'org/a', requestId }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.container.querySelector(`[data-request-id="${requestId}"]`)).toBeNull()); expect(f.pending()).toEqual(preserved);
  }
  expect(f.commands.submit).not.toHaveBeenCalled(); expect(f.commands.acknowledge).not.toHaveBeenCalled();
});

it.each([['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes'], ['COMMENT', 'Comment only']] as const)('shows saved %s recommendations only on succeeded run tabs', async (outcome, label) => {
  const f = await mount(); await ready(f.container);
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), status: 'succeeded', review: { outcome, verdict: 'Saved verdict' } } }));
  f.container.querySelector<HTMLElement>('[role=tab]')?.focus();
  await f.instance.refresh?.();
  expect(document.activeElement).toBe(f.container.querySelector('[role=tab]'));
  const status = f.container.querySelector<HTMLElement>('.run-tab-status');
  expect(status?.textContent).toBe(label); expect(status?.dataset.reviewOutcome).toBe(outcome); expect(status?.title).toBe(`Review recommendation: ${label}`);
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), status: 'failed', review: { outcome, verdict: 'Saved verdict' } } }));
  await f.instance.refresh?.(); expect(f.container.querySelector('.run-tab-status')?.textContent).toBe('failed'); expect(f.container.querySelector<HTMLElement>('.run-tab-status')?.dataset.reviewOutcome).toBeUndefined();
});
it('updates a completed inactive tab without replacing the selected run or reading inactive logs', async () => {
  const f = await mount(); await ready(f.container);
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: input.runId === 'one' ? { ...summary('one'), status: 'succeeded', review: { outcome: 'COMMENT', verdict: 'Saved verdict' } } : summary(input.runId) }));
  vi.mocked(f.inspect.log).mockClear();
  await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'two' } });
  await vi.waitFor(() => expect(f.container.querySelector('.run-tab-status')?.textContent).toBe('Comment only'));
  expect(f.container.querySelector('[aria-selected=true]')?.textContent).toContain('TWO');
  expect(vi.mocked(f.inspect.log).mock.calls.every(([input]) => input.target.runId === 'two')).toBe(true);
});

it('ignores a late inactive summary after the viewer becomes hidden', async () => {
  const f = await mount(); await ready(f.container);
  const late = deferred<Awaited<ReturnType<typeof f.runs.load>>>();
  f.runs.load.mockImplementation(input => input.runId === 'one' ? late.promise : Promise.resolve(available({ version: 1, repo: 'org/a', runId: input.runId, run: summary(input.runId) })));
  await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'two' } });
  await vi.waitFor(() => expect(f.container.querySelector('[aria-selected=true]')?.textContent).toContain('TWO'));
  await f.instance.update({ ...f.state, visible: false, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'two' } });
  late.resolve(available({ version: 1, repo: 'org/a', runId: 'one', run: { ...summary(), status: 'succeeded', review: { outcome: 'APPROVE', verdict: 'Late result' } } }));
  await Promise.resolve(); await Promise.resolve();
  expect(f.container.textContent).not.toContain('Approve');
});

it.each([
  ['completed', 'succeeded', 'Feedback completed'], ['completed', 'running', 'running'],
  ['completed', 'failed', 'Feedback remaining'], ['completed', 'stopped', 'Feedback remaining'],
  ['awaiting_decision', 'running', 'Awaiting decision'], ['awaiting_decision', 'failed', 'Feedback remaining'],
  ['changes_remaining', 'succeeded', 'Feedback remaining'],
] as const)('shows %s feedback on %s without hiding worker state', async (state, status, label) => {
  const f = await mount(); await ready(f.container);
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId,
    run: { ...summary(input.runId), status, feedbackOutcome: { state, headSha: 'a'.repeat(40), summary: '<img src=x onerror=alert(1)>' } } }));
  await f.instance.refresh?.();
  expect(f.container.querySelector('.run-tab-status')?.textContent).toBe(label);
  expect(f.container.textContent).toContain(`Worker: ${status}`);
  expect(f.container.querySelector('img')).toBeNull();
  expect(f.container.querySelector('.run-feedback-outcome')?.textContent ?? null).toBe(label === 'running' ? null : label);
});

it.each([false, true])('hydrates a reopened review label and opens its canonical run without changing header scope (pirate=%s)', async pirateMode => {
  const f = await mount({ state: { headerRepo: 'org/header', pirateMode } }); await ready(f.container);
  f.container.querySelector<HTMLAnchorElement>('.run-tab-open')!.focus();
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), displayKey: 'review', prNumber: 42 } }));
  await f.instance.refresh?.();
  expect(document.activeElement).toBe(f.container.querySelector('.run-tab-open'));
  const label = `${pirateMode ? 'Inspection' : 'Review'} #42`;
  expect(f.container.querySelector('[role=tab]')?.getAttribute('aria-label')).toContain(label);
  const link = f.container.querySelector<HTMLAnchorElement>('.run-tab-open')!;
  const url = new URL(link.href);
  expect(url.pathname).toBe('/run-viewer');
  expect(Object.fromEntries(url.searchParams)).toEqual({ repo: 'org/header', runRepo: 'org/a', run: 'one' });
  expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
  expect(link.getAttribute('aria-label')).toContain(label);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true }); link.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false); expect(f.context.navigate).not.toHaveBeenCalled();
  link.focus(); await f.instance.refresh?.();
  expect(document.activeElement).toBe(f.container.querySelector('.run-tab-open'));
});

it.each([false, true])('hydrates a reopened feedback tab with its PR and canonical galleon (pirate=%s)', async pirateMode => {
  const f = await mount({ state: { headerRepo: 'org/header', pirateMode } }); await ready(f.container);
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId,
    run: { ...summary(input.runId), displayKey: 'rerun', prNumber: 42 } }));
  await f.instance.refresh?.();
  const tab = f.container.querySelector<HTMLButtonElement>('[role=tab]')!;
  expect(tab.firstChild?.textContent).toBe('Branch update #42');
  expect(tab.querySelector('.run-tab-identity')?.textContent).toBe('org/a · one');
  expect(tab.getAttribute('aria-label')).toBe('Branch update #42 · org/a · one · Attempt 1 · running');
  expect(tab.title).toBe('Branch update #42 · org/a · one');
  const link = f.container.querySelector<HTMLAnchorElement>('.run-tab-open')!;
  expect(Object.fromEntries(new URL(link.href).searchParams)).toEqual({ repo: 'org/header', runRepo: 'org/a', run: 'one' });
  expect(link.getAttribute('aria-label')).toContain('Branch update #42');
});

it('keeps branch update identity when retrying the original attempt and opening its resulting run', async () => {
  const f = await mount(); await ready(f.container);
  vi.mocked(f.inspect.resolve).mockImplementation(async input => available({ version: 1, target: { ...target, runId: input.runId, expectedAttempt: input.runId === 'one' ? 2 : 1 }, observedAt: when }));
  f.runs.load.mockImplementation(async input => available({ version: 1, repo: 'org/a', runId: input.runId,
    run: { ...summary(input.runId, input.runId === 'one' ? 2 : 1), displayKey: 'rerun', prNumber: 42, status: input.runId === 'one' ? 'failed' : 'running' } }));
  f.commands.submit.mockImplementation(async input => {
    const result: RunCommandReceiptV1 = { ...receipt(), action: 'retry', runId: 'retry-one' };
    f.setPending([{ command: { ...input, requestId }, receipt: result }]); return available(result);
  });
  await f.instance.refresh?.();
  expect(f.container.querySelector('[role=tab]')?.getAttribute('aria-label')).toBe('Branch update #42 · org/a · one · Attempt 2 · failed');
  button(f.container, 'Retry run').click();
  await vi.waitFor(() => expect(f.commands.submit).toHaveBeenCalledWith({ version: 1, repo: 'org/a', action: 'retry', target: { runId: 'one', expectedAttempt: 2 } }, expect.any(AbortSignal)));
  await vi.waitFor(() => expect(button(f.container, 'Retry run')?.disabled).toBe(true));
  await f.instance.update({ ...f.state, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'retry-one' } });
  await vi.waitFor(() => expect(f.container.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label')).toBe('Branch update #42 · org/a · retry-one · Attempt 1 · running'));
});

describe('post-mortem entry point', () => {
  it.each([['failed', true], ['stopped', true], ['running', false], ['succeeded', false]] as const)('for a %s run shows Ask about this failure: %s', async (status, shown) => {
    const f = await mount({ status });
    await vi.waitFor(() => expect(f.container.textContent).toContain(`Worker: ${status}`));
    expect(Boolean(button(f.container, 'Ask about this failure'))).toBe(shown);
    if (shown) expect(button(f.container, 'Ask about this failure')?.disabled).toBe(true);
  });
});


it('explains and opens the current run attempt through Whiteboard without navigation', async () => {
  const pinned = { kind: 'run' as const, ...target };
  const snapshot = { version: 1 as const, target: pinned, status: 'absent' as const, sessionId: null, baseSha: null, headSha: null, message: null };
  const whiteboard = { version: 1 as const, read: vi.fn(async () => available(snapshot)), explain: vi.fn(async () => available({ ...snapshot, status: 'ready' as const, sessionId: 'session' })), open: vi.fn(async () => available({ ...snapshot, status: 'ready' as const, sessionId: 'session' })) };
  const f = await mount({ whiteboard }); await ready(f.container);
  await vi.waitFor(() => expect(button(f.container, 'Explain in Whiteboard')?.disabled).toBe(false));
  button(f.container, 'Explain in Whiteboard').click();
  await vi.waitFor(() => expect(button(f.container, 'Open in Whiteboard')?.disabled).toBe(false));
  expect(whiteboard.explain).toHaveBeenCalledWith(pinned, expect.any(AbortSignal));
  button(f.container, 'Open in Whiteboard').focus(); button(f.container, 'Open in Whiteboard').click();
  await vi.waitFor(() => expect(whiteboard.open).toHaveBeenCalledWith(pinned, expect.any(AbortSignal)));
  expect(f.context.navigate).not.toHaveBeenCalled();
});

it('aborts Whiteboard creation on a scope change and ignores its late result', async () => {
  const pinned = { kind: 'run' as const, ...target };
  const snapshot = { version: 1 as const, target: pinned, status: 'absent' as const, sessionId: null, baseSha: null, headSha: null, message: null };
  const pending = deferred<{ status: 'available'; value: typeof snapshot }>();
  const whiteboard = { version: 1 as const, read: vi.fn(async () => available(snapshot)), explain: vi.fn((_target: unknown, _signal?: AbortSignal) => pending.promise), open: vi.fn() };
  const f = await mount({ whiteboard }); await ready(f.container);
  await vi.waitFor(() => expect(button(f.container, 'Explain in Whiteboard')?.disabled).toBe(false));
  button(f.container, 'Explain in Whiteboard').click();
  f.activity.abort(); pending.resolve(available(snapshot));
  await Promise.resolve();
  expect(whiteboard.explain.mock.calls[0]?.[1]?.aborted).toBe(true);
  expect(button(f.container, 'Explain in Whiteboard').disabled).toBe(true);
});
