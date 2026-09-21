import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRequestV1, PluginPanelContext, PluginPanelInstance, PluginPanelState, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, RunInspectLogPageV1, RunInspectServiceV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import panel from './panel';

const instances: PluginPanelInstance[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const available = <T>(value: T) => ({ status: 'available' as const, value });
const target = { repo: 'org/a', runId: 'one', expectedAttempt: 1 };
const when = '2026-09-20T00:00:00Z';
const summary = (id = 'one', attempt = 1): RunReadSummaryV1 => ({ version: 1, id, repo: 'org/a', displayKey: id.toUpperCase(), status: 'running', attempt, startedAt: when, endedAt: null, prNumber: null, costUsd: null, review: null, sourceSettlement: null });
const event = (sequence: number) => ({ sequence, at: when, kind: 'log', text: `event ${sequence}`, truncated: false });
const page = (overrides: Partial<RunInspectLogPageV1> = {}): RunInspectLogPageV1 => ({ version: 1, target, provenance: 'run-wide', observedAt: when, workerStatus: 'running', events: [event(51)], throughSequence: 51, hasEarlier: true, hasLater: false, nextCursor: 'older-51', followCursor: 'follow-51', ...overrides });
const requestId = '00000000-0000-4000-8000-000000000001';
const receipt = (status: RunCommandReceiptV1['status'] = 'accepted'): RunCommandReceiptV1 => ({ version: 1, repo: 'org/a', requestId, action: 'stop', status, runId: 'one', attempt: 1, message: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

async function mount(options: { state?: Partial<PluginPanelState>; inspect?: Partial<RunInspectServiceV1>; saved?: RunCommandPendingV1[]; saveState?: PluginPanelContext['saveState']; selector?: boolean } = {}) {
  const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo: 'org/a', themeId: 'default', pirateMode: false, visible: true, pane: null, instanceId: 'viewer', savedState: null,
    activity: { epoch: 1, repo: 'org/a', active: true, signal: activity.signal }, presentation: { version: 1, kind: 'run', repo: 'org/a', runId: 'one' }, ...options.state };
  let pending = options.saved ?? [];
  const inspect: RunInspectServiceV1 = { version: 1, resolve: vi.fn(async input => available({ version: 1 as const, target: { ...target, runId: input.runId }, observedAt: when })),
    history: vi.fn(), log: vi.fn(async input => available(page({ target: input.target }))), exportLog: vi.fn(), ...options.inspect };
  const runs = { version: 1 as const, list: vi.fn(), log: vi.fn(), load: vi.fn(async (input: { runId: string }) => available({ version: 1 as const, repo: 'org/a', runId: input.runId, run: summary(input.runId) })), watchList: vi.fn(), watchLoad: vi.fn(), watchLog: vi.fn() };
  const commands = { version: 1 as const,
    submit: vi.fn(async (input: RunCommandInputV1) => { const result = { ...receipt(), action: input.action }; pending = [{ command: { ...input, requestId }, receipt: result }]; return available(result); }),
    pending: vi.fn(async () => pending), receipt: vi.fn(async () => available(pending[0]?.receipt ?? null)),
    acknowledge: vi.fn(async () => { pending = []; }) };
  const downloads = { version: 1 as const, save: vi.fn(async (_request: DownloadRequestV1, _signal?: AbortSignal) => ({ status: 'delivered-to-browser' as const, bytesWritten: 1 })) };
  const selectPresentation = options.selector === false ? undefined : vi.fn();
  const saveState = options.saveState ?? vi.fn(async () => {});
  const container = document.createElement('div'); document.body.append(container);
  const context: PluginPanelContext = { state, signal: lifetime.signal, activity: state.activity, services: { version: 1, runInspect: inspect, runs, runCommands: commands, downloads },
    saveState, onDispose: vi.fn(), navigate: vi.fn(), selectPresentation };
  const instance = await panel.mount(container, context); instances.push(instance);
  return { container, instance, context, inspect, runs, commands, downloads, state, activity, lifetime, selectPresentation, saveState, pending: () => pending, setPending: (value: RunCommandPendingV1[]) => { pending = value; } };
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
async function ready(root: HTMLElement) { await vi.waitFor(() => expect(button(root, 'Stop run')?.disabled).toBe(false)); }

describe('authored run viewer lifecycle and commands', () => {
  it('resolves canonical scope and preserves text as inert bounded log content', async () => {
    const f = await mount({ inspect: { log: vi.fn(async () => available(page({ events: [{ ...event(1), text: '<img src=x onerror=alert(1)>' }] }))) } });
    await ready(f.container); expect(f.container.querySelector('pre')?.textContent).toContain('<img src=x'); expect(f.container.querySelector('img')).toBeNull();
    expect(f.container.textContent).toContain('Run-wide log preview'); expect(f.container.textContent).toContain('Spend unknown');
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
    button(f.container, 'Retry delivery').click(); await vi.waitFor(() => expect(f.commands.submit).toHaveBeenCalledTimes(2));
    expect(f.commands.submit.mock.calls[1]?.[0]).toEqual({ version: 1, repo: 'org/a', action: 'stop', target: { runId: 'one', expectedAttempt: 1 } });
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
