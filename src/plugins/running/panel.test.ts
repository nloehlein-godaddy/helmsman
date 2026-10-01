import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, RunCommandPendingV1, RunCommandReceiptV1, RunCommandServiceV1, RunReadServiceV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import running from './panel';
import recent from '../recent/panel';

const repo = 'owner/project';
const run: RunReadSummaryV1 = { version: 1, id: 'run-one', repo, displayKey: 'TASK-2', status: 'running', attempt: 3, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, prNumber: null, costUsd: null, review: null, sourceSettlement: null };
const receipt: RunCommandReceiptV1 = { version: 1, repo, requestId: '11111111-1111-4111-8111-111111111111', action: 'stop', status: 'pending', runId: run.id, attempt: run.attempt, message: null };
function fixture(action: 'stop' | 'retry', pirateMode = false) {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const item = { ...run, status: action === 'stop' ? 'running' as const : 'failed' as const };
  const listeners: Parameters<RunReadServiceV1['watchList']>[1][] = [];
  const cleanup = vi.fn();
  const watchList = vi.fn<RunReadServiceV1['watchList']>((query, listener) => {
    listeners.push(listener); listener({ status: 'available', value: { version: 1, repo: query.repo, items: [item], nextCursor: null } }); return cleanup;
  });
  const pending = vi.fn<RunCommandServiceV1['pending']>(async () => []);
  const submit = vi.fn<RunCommandServiceV1['submit']>(async () => ({ status: 'available', value: { ...receipt, action, status: 'accepted' } }));
  const retry = vi.fn<NonNullable<RunCommandServiceV1['retry']>>(async query => {
    const entry = (await pending()).find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
    return entry ? { status: 'available', value: { ...receipt, ...query, action, status: 'accepted' } } : { status: 'unavailable', reason: 'not-found' };
  });
  const reconcile = vi.fn<RunCommandServiceV1['receipt']>(async () => ({ status: 'available', value: { ...receipt, action, status: 'accepted' } }));
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1,
    runs: { version: 1, list: vi.fn(), load: vi.fn(), log: vi.fn(), watchList, watchLoad: vi.fn(), watchLog: vi.fn() },
    runCommands: { version: 1, pending, submit, retry, receipt: reconcile, acknowledge: vi.fn(async () => {}) } }, saveState: vi.fn(), navigate: vi.fn(), onDispose: vi.fn() };
  const emit = (items: RunReadSummaryV1[], index = listeners.length - 1) => listeners[index]?.({ status: 'available', value: { version: 1, repo: state.repo, items, nextCursor: null } });
  const button = (name: string) => [...container.querySelectorAll('button')].find(value => value.textContent === name)!;
  const saved: RunCommandPendingV1 = { command: { version: 1, repo, requestId: receipt.requestId, action, target: { runId: run.id, expectedAttempt: run.attempt } }, receipt: null };
  return { container, lifetime, activity, state, item, context, cleanup, watchList, pending, submit, retry, reconcile, emit, button, saved };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe.each([['running', running, 'stop', 'Stop', 100], ['recent', recent, 'retry', 'Retry', 10]] as const)('%s standalone panel', (_name, module, action, label, limit) => {
  it('uses the public accessible loading wheel while awaiting a run read', async () => {
    const f = fixture(action); f.watchList.mockImplementation(() => f.cleanup);
    await module.mount(f.container, f.context);
    const loading = f.container.querySelector('.helmsman-loading-wheel-v1');
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.textContent).toContain('Loading runs…');
    expect(loading?.querySelector('style')?.textContent).toContain('prefers-reduced-motion');
    f.lifetime.abort();
  });
  it('watches one bounded current-galleon page and stops work when hidden or disposed', async () => {
    const f = fixture(action); const instance = await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.button(label).disabled).toBe(false));
    expect(f.watchList).toHaveBeenCalledWith({ version: 1, repo, kind: action === 'stop' ? 'running' : 'terminal', limit, cursor: null }, expect.any(Function), expect.any(AbortSignal));
    await instance.update({ ...f.state, visible: false }); expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.watchList.mock.calls[0]?.[2]?.aborted).toBe(true);
    f.emit([{ ...f.item, displayKey: 'STALE' }]); expect(f.container.textContent).not.toContain('STALE');
    await instance.update(f.state); expect(f.watchList).toHaveBeenCalledTimes(2);
    f.lifetime.abort(); expect(f.cleanup).toHaveBeenCalledTimes(2); await instance.refresh?.(); expect(f.watchList).toHaveBeenCalledTimes(2);
  });
  it('retains keyboard focus across watch updates', async () => {
    const f = fixture(action); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.button(label).disabled).toBe(false)); f.button(label).focus();
    f.emit([{ ...f.item, costUsd: 3 }]); expect(document.activeElement).toBe(f.button(label)); f.lifetime.abort();
  });
  it('uses exact attempt identity, prevents duplicate submission, and separates accepted requests from worker outcomes', async () => {
    const f = fixture(action); let finish!: (value: Awaited<ReturnType<RunCommandServiceV1['submit']>>) => void;
    f.submit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.button(label).disabled).toBe(false));
    f.button(label).click(); f.button(label).click(); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledWith({ version: 1, repo, action, target: { runId: run.id, expectedAttempt: 3 } }, expect.any(AbortSignal));
    finish({ status: 'available', value: { ...receipt, action, status: 'accepted', runId: action === 'retry' ? 'new-run' : run.id } });
    await vi.waitFor(() => expect(f.container.textContent).toContain(action === 'stop' ? 'Stop requested' : 'Retry accepted'));
    expect(f.container.textContent).toContain(`Worker: ${f.item.status}`); expect(f.button(label).disabled).toBe(true);
    if (action === 'retry') expect(f.container.querySelector('a[href*="run=new-run"]')?.getAttribute('href')).toContain('repo=owner%2Fproject');
    f.lifetime.abort();
  });
  it('restores durable evidence on mount and reconciles by receipt without submitting another command', async () => {
    const f = fixture(action); f.pending.mockResolvedValue([f.saved]); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.button('Check request')).toBeDefined()); expect(f.button(label).disabled).toBe(true);
    f.button('Check request').click(); await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1));
    expect(f.reconcile).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal)); expect(f.submit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.button('Check request')).toBeUndefined()); f.lifetime.abort();
  });
  it('recovers a durable request ID after an uncertain transport response', async () => {
    const f = fixture(action); f.submit.mockImplementation(async () => { f.pending.mockResolvedValue([f.saved]); return { status: 'unavailable', reason: 'connection-failed' }; });
    await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.button(label).disabled).toBe(false));
    f.button(label).click(); await vi.waitFor(() => expect(f.button('Check request')?.disabled).toBe(false));
    f.button('Check request').click(); await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal)));
    expect(f.submit).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
  it('does not leave interrupted requests busy forever after activity resumes', async () => {
    const f = fixture(action); f.submit.mockImplementation(() => new Promise(() => {}));
    const instance = await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.button(label).disabled).toBe(false)); f.button(label).click();
    f.pending.mockResolvedValue([f.saved]); f.activity.abort(); const activity = new AbortController();
    await instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 2, signal: activity.signal } });
    await vi.waitFor(() => expect(f.button('Check request')?.disabled).toBe(false)); f.button('Check request').click();
    await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1)); expect(f.submit).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
  it('restores accepted receipts after reload and retains them until explicit acknowledgment', async () => {
    const f = fixture(action); f.pending.mockResolvedValue([{ ...f.saved, receipt: { ...receipt, action, status: 'accepted' } }]);
    await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Dismiss request')).toBeDefined());
    expect(f.button(label).disabled).toBe(true); f.emit([]); expect(f.container.textContent).toContain('Saved requests');
    f.button('Dismiss request').click();
    await vi.waitFor(() => expect(f.context.services.runCommands?.acknowledge).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }));
    await vi.waitFor(() => expect(f.container.textContent).not.toContain('Saved requests')); expect(f.submit).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('keeps rejected evidence until dismissed and preserves it if acknowledgment fails', async () => {
    const f = fixture(action); f.pending.mockResolvedValue([{ ...f.saved, receipt: { ...receipt, action, status: 'rejected', message: 'Attempt changed' } }]);
    vi.mocked(f.context.services.runCommands!.acknowledge).mockRejectedValue(new Error('Storage unavailable'));
    await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Attempt changed'));
    expect(f.button(label).disabled).toBe(true); f.button('Dismiss request').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Could not dismiss')); expect(f.button(label).disabled).toBe(true); f.lifetime.abort();
  });
  it('explicitly retries delivery of an unresolved saved intent and never offers it for recovery-required receipts', async () => {
    const f = fixture(action); f.pending.mockResolvedValue([f.saved]); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.button('Retry delivery')?.disabled).toBe(false)); f.button('Retry delivery').click();
    await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal))); expect(f.submit).not.toHaveBeenCalled();
    f.lifetime.abort();
    const protectedRequest = fixture(action); protectedRequest.pending.mockResolvedValue([{ ...protectedRequest.saved, receipt: { ...receipt, action, status: 'recovery-required' } }]);
    await module.mount(protectedRequest.container, protectedRequest.context); await vi.waitFor(() => expect(protectedRequest.button('Check request')).toBeDefined());
    expect(protectedRequest.button('Retry delivery')).toBeUndefined(); protectedRequest.lifetime.abort();
  });
  it.each(['missing', 'newer', 'unsupported'] as const)('does not create another list command when original request is %s', async scenario => {
    const f = fixture(action); f.pending.mockResolvedValue([f.saved]);
    if (scenario === 'unsupported') delete f.context.services.runCommands!.retry;
    await module.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Check request')?.disabled).toBe(false));
    if (scenario === 'unsupported') {
      expect(f.button('Retry delivery').disabled).toBe(true); f.button('Retry delivery').click(); expect(f.retry).not.toHaveBeenCalled();
      f.button('Check request').click(); await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledOnce());
    } else {
      const preserved: RunCommandPendingV1[] = scenario === 'newer' ? [{ ...f.saved, command: { ...f.saved.command, requestId: '22222222-2222-4222-8222-222222222222' } }] : [];
      f.pending.mockResolvedValue(preserved); f.button('Retry delivery').click();
      await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal)));
      await vi.waitFor(() => expect(f.button('Retry delivery')?.disabled).toBe(false)); expect(await f.pending()).toEqual(preserved);
    }
    expect(f.submit).not.toHaveBeenCalled(); expect(f.context.services.runCommands!.acknowledge).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('blocks commands if saved evidence cannot be loaded', async () => {
    const f = fixture(action); f.pending.mockRejectedValue(new Error('Storage blocked')); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Saved command evidence is unavailable'));
    expect(f.button(label).disabled).toBe(true); f.button(label).click(); expect(f.submit).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('rejects stale galleon reads and command evidence after scope changes', async () => {
    const f = fixture(action); let finish!: (value: readonly RunCommandPendingV1[]) => void;
    f.pending.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const instance = await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.pending).toHaveBeenCalledTimes(1));
    const activity = new AbortController(); const other = 'owner/other';
    await instance.update({ ...f.state, repo: other, activity: { repo: other, epoch: 2, active: true, signal: activity.signal } });
    finish([f.saved]); f.emit([{ ...f.item, displayKey: 'STALE' }], 0); await Promise.resolve(); await Promise.resolve();
    expect(f.container.textContent).not.toContain('STALE'); expect(f.button('Check request')).toBeUndefined(); expect(f.container.querySelector('[data-run-id]')).toBeNull(); f.lifetime.abort();
  });
  it('shows unresolved requests after their rows leave the visible window', async () => {
    const f = fixture(action); f.pending.mockResolvedValue([f.saved]); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.button('Check request')).toBeDefined()); f.emit([]);
    expect(f.container.textContent).toContain('Saved requests'); expect(f.container.textContent).toContain(run.id); f.lifetime.abort();
  });
  it('uses literal text, scoped links, pirate terminology and unknown spend', async () => {
    const f = fixture(action); f.context = { ...f.context, state: { ...f.state, repo: null, pirateMode: true } }; await module.mount(f.container, f.context);
    f.emit([{ ...f.item, displayKey: '<img src=x onerror=alert(1)>', prNumber: 7 }]);
    expect(f.container.querySelector('img')).toBeNull(); expect(f.container.textContent).toContain('Bounty #7'); expect(f.container.textContent).toContain('Spend unknown');
    expect(f.container.textContent).toContain(action === 'stop' ? 'Deckhand tasks' : 'Recent voyages');
    const link = f.container.querySelector('a')!; expect(link.getAttribute('href')).toContain('repo=owner%2Fproject'); link.click(); expect(f.context.navigate).toHaveBeenCalledWith(link.getAttribute('href')); f.lifetime.abort();
  });
});

describe('recent worker outcome', () => {
  it('keeps successful request-changes reviews and pending source settlement separate; only failed workers can retry', async () => {
    const f = fixture('retry'); await recent.mount(f.container, f.context);
    f.emit([{ ...f.item, status: 'succeeded', review: { outcome: 'REQUEST_CHANGES', verdict: 'Fix tests' }, sourceSettlement: { state: 'pending' } }]);
    expect(f.container.textContent).toContain('Worker: succeeded'); expect(f.container.textContent).toContain('Review recommendation: Request changes');
    expect(f.container.textContent).toContain('Source settlement: pending'); expect(f.button('Retry')).toBeUndefined(); f.lifetime.abort();
  });
});

it.each([false, true])('renders feedback states separately from worker status in running/recent panels (pirate=%s)', async pirateMode => {
  const active = fixture('stop', pirateMode);
  const activePanel = await running.mount(active.container, active.context);
  const feedbackOutcome = { state: 'awaiting_decision' as const, headSha: 'a'.repeat(40), summary: '<img src=x onerror=alert(1)>' };
  active.emit([{ ...run, feedbackOutcome }]);
  expect(active.container.querySelector('.run-feedback-outcome')?.textContent).toBe('Awaiting decision');
  expect(active.container.textContent).toContain(`Worker: ${pirateMode ? 'Underway' : 'running'}`);
  expect(active.container.querySelector('img')).toBeNull(); activePanel.dispose();
  const past = fixture('retry', pirateMode);
  const recentPanel = await recent.mount(past.container, past.context);
  past.emit([{ ...run, status: 'succeeded', feedbackOutcome: { ...feedbackOutcome, state: 'completed' } },
    { ...run, id: 'failed', status: 'failed', feedbackOutcome: { ...feedbackOutcome, state: 'completed' } }]);
  expect([...past.container.querySelectorAll('.run-feedback-outcome')].map(el => el.textContent)).toEqual(['Feedback completed', 'Feedback remaining']);
  expect(past.container.textContent).toContain('Worker: failed'); recentPanel.dispose();
});
