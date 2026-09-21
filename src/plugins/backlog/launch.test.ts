import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, TaskReadServiceV1, TaskReadSourceV1, TaskReadTaskV1, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, RunCommandServiceV1 } from '@helmsman/plugin-sdk';
import backlog from './panel';

const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/project';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'source-one', instanceRevision: 2, repo, label: 'Tasks', availability: 'available', readViews: ['underway'] };
const task: TaskReadTaskV1 = { version: 1, ref: { sourceId, externalId: '10001' }, repo, revision: 'r1', displayKey: 'TASK-2', title: 'Assigned ready task', state: 'ready', priority: null, url: null, requirements: { description: '', acceptanceCriteria: [], links: [] } };
const input: RunCommandInputV1 = { version: 1, action: 'launch', repo, launch: { mode: 'source', workRef: task.ref, sourceInstanceId: source.instanceId, sourceInstanceRevision: source.instanceRevision } };
const receipt: RunCommandReceiptV1 = { version: 1, repo, requestId: sourceId, action: 'launch', status: 'accepted', runId: 'run-one', attempt: 1, message: null };
const saved: RunCommandPendingV1 = { command: { ...input, requestId: receipt.requestId }, receipt: null };
function fixture() {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }));
  const read = vi.fn<NonNullable<TaskReadServiceV1['underway']>>(async () => ({ status: 'available', value: { selection: source, items: [task], nextCursor: null } }));
  const list = vi.fn<TaskReadServiceV1['list']>();
  let entries: readonly RunCommandPendingV1[] = [];
  const pending = vi.fn<RunCommandServiceV1['pending']>(async () => entries);
  const submit = vi.fn<RunCommandServiceV1['submit']>(async submitted => { entries = [{ command: { ...submitted, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; });
  const retry = vi.fn<NonNullable<RunCommandServiceV1['retry']>>(async query => {
    const entry = entries.find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
    return entry ? { status: 'available', value: { ...receipt, requestId: query.requestId } } : { status: 'unavailable', reason: 'not-found' };
  });
  const reconcile = vi.fn<RunCommandServiceV1['receipt']>(async () => { entries = entries.map(entry => ({ ...entry, receipt })); return { status: 'available', value: receipt }; });
  const acknowledge = vi.fn<RunCommandServiceV1['acknowledge']>(async query => { entries = entries.filter(entry => entry.command.requestId !== query.requestId); });
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, tasks: { version: 1, discover, list: read, underway: list, load: vi.fn() }, runCommands: { version: 1, submit, retry, pending, receipt: reconcile, acknowledge } }, saveState: vi.fn(), navigate: vi.fn(), onDispose: vi.fn() };
  const buttons = (name: string) => [...container.querySelectorAll('button')].filter(button => button.textContent === name);
  const button = (name: string) => buttons(name)[0];
  return { container, lifetime, activity, state, context, discover, read, list, pending, submit, retry, reconcile, acknowledge, button, buttons, set entries(value: readonly RunCommandPendingV1[]) { entries = value; } };
}
afterEach(() => document.body.replaceChildren());

describe('standalone Backlog launch controls', () => {
  it('launches exact canonical source identity and retains accepted evidence until explicit dismissal', async () => {
    const f = fixture(); await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Launch')?.disabled).toBe(false));
    f.button('Launch')!.click(); f.button('Launch')!.click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Launch accepted'));
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledWith(input, expect.any(AbortSignal)); expect(f.button('Launch')?.disabled).toBe(true);
    const link = f.container.querySelector<HTMLAnchorElement>('a[href*="run=run-one"]')!; expect(link.href).toContain('repo=owner%2Fproject'); link.click(); expect(f.context.navigate).toHaveBeenCalledWith(link.getAttribute('href'));
    f.button('Dismiss saved launch')!.click(); await vi.waitFor(() => expect(f.button('Launch')?.disabled).toBe(false)); expect(f.acknowledge).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }); f.lifetime.abort();
  });
  it('does not launch from all-repository scope', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, repo: null } };
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    expect(f.button('Launch')).toBeUndefined(); expect(f.container.textContent).toContain('Select one repository'); f.lifetime.abort();
  });
  it('restores uncertain delivery and retries the saved input across source revision changes', async () => {
    const f = fixture(); f.entries = [saved]; f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [{ ...source, instanceRevision: 9 }] } }] } });
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Retry delivery')?.disabled).toBe(false));
    expect(f.button('Launch')?.disabled).toBe(true); f.button('Retry delivery')!.click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: receipt.requestId }, expect.any(AbortSignal)));
    expect(f.submit).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('recovers an uncertain response and retains its receipt independently of visible tasks', async () => {
    const f = fixture(); f.submit.mockImplementation(async () => { f.entries = [saved]; return { status: 'unavailable', reason: 'connection-failed' }; });
    const instance = await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Launch')?.disabled).toBe(false)); f.button('Launch')!.click();
    await vi.waitFor(() => expect(f.button('Check launch receipt')?.disabled).toBe(false)); f.read.mockResolvedValue({ status: 'available', value: { selection: source, items: [], nextCursor: null } }); await instance.refresh?.();
    expect(f.button('Check launch receipt')).toBeDefined(); expect(f.container.textContent).toContain(task.ref.externalId); f.button('Check launch receipt')!.click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Launch accepted')); expect(f.submit).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
  it('retains every saved request for the same task and blocks relaunch until all are dismissed', async () => {
    const f = fixture(); const otherId = '22222222-2222-4222-8222-222222222222'; f.entries = [{ ...saved, receipt }, { command: { ...input, requestId: otherId }, receipt: { ...receipt, requestId: otherId, status: 'rejected', message: 'Revision changed' } }];
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Dismiss saved launch')).toHaveLength(2));
    f.buttons('Dismiss saved launch')[0]!.click(); await vi.waitFor(() => expect(f.buttons('Dismiss saved launch')).toHaveLength(1)); expect(f.button('Launch')?.disabled).toBe(true);
    f.button('Dismiss saved launch')!.click(); await vi.waitFor(() => expect(f.button('Launch')?.disabled).toBe(false)); expect(f.acknowledge).toHaveBeenCalledTimes(2); f.lifetime.abort();
  });
  it('requires Recovery without offering delivery retry', async () => {
    const f = fixture(); f.entries = [{ ...saved, receipt: { ...receipt, status: 'recovery-required' } }];
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Launch requires Recovery'));
    expect(f.button('Retry delivery')).toBeUndefined(); expect(f.button('Dismiss saved launch')).toBeUndefined(); expect(f.container.querySelector('a[href="/recovery"]')).not.toBeNull(); f.lifetime.abort();
  });
  it('fails closed when durable evidence cannot be loaded', async () => {
    const f = fixture(); f.pending.mockRejectedValue(new Error('Storage unavailable'));
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    expect(f.container.textContent).toContain('Saved launch requests are unavailable'); expect(f.button('Launch')?.disabled).toBe(true); f.button('Launch')!.click(); expect(f.submit).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('clears stale tasks before refresh and leaves failed pagination non-actionable', async () => {
    const f = fixture(); f.read.mockResolvedValueOnce({ status: 'available', value: { selection: source, items: [task], nextCursor: 'next' } }).mockResolvedValueOnce({ status: 'unavailable', reason: 'selection-changed' });
    const instance = await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Load more')?.disabled).toBe(false)); f.button('Load more')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('selection-changed')); expect(f.button('Launch')?.disabled).toBe(true);
    f.discover.mockImplementation(() => new Promise(() => {})); void instance.refresh?.(); expect(f.container.textContent).not.toContain(task.title); f.lifetime.abort();
  });
  it('restores interrupted commands without retaining their busy state', async () => {
    const f = fixture(); f.submit.mockImplementation(() => new Promise(() => {}));
    const instance = await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.button('Launch')?.disabled).toBe(false)); f.button('Launch')!.click();
    f.entries = [saved]; f.activity.abort(); const activity = new AbortController(); await instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 2, signal: activity.signal } });
    await vi.waitFor(() => expect(f.button('Check launch receipt')?.disabled).toBe(false)); f.button('Check launch receipt')!.click(); await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1)); expect(f.submit).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
  it('discards late provider data after the activity epoch changes', async () => {
    const f = fixture(); let finish!: (value: Awaited<ReturnType<NonNullable<TaskReadServiceV1['underway']>>>) => void;
    f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; })); const instance = await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    const activity = new AbortController(); await instance.update({ ...f.state, repo: 'owner/other', activity: { repo: 'owner/other', epoch: 2, active: false, signal: activity.signal } });
    finish({ status: 'available', value: { selection: source, items: [task], nextCursor: null } }); await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).not.toContain(task.title); f.lifetime.abort();
  });
});

it.each(['missing-retry', 'removed-request', 'newer-request'] as const)('never allocates launch identity from a retained row after %s', async scenario => {
  const f = fixture(); const original: RunCommandPendingV1 = { command: { ...input, requestId: sourceId }, receipt: null }; f.entries = [original];
  if (scenario === 'missing-retry') delete f.context.services.runCommands!.retry;
  await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Check launch receipt')[0]?.disabled).toBe(false));
  const retry = f.buttons('Retry delivery')[0]!;
  if (scenario === 'missing-retry') { expect(retry.disabled).toBe(true); retry.click(); expect(f.retry).not.toHaveBeenCalled(); }
  else {
    const next: readonly RunCommandPendingV1[] = scenario === 'newer-request' ? [{ command: { ...input, requestId: '22222222-2222-4222-8222-222222222222' }, receipt: null }] : [];
    f.entries = next; retry.click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: sourceId }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.buttons('Retry delivery')).toHaveLength(next.length)); expect(await f.pending()).toEqual(next);
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled(); f.lifetime.abort();
});
