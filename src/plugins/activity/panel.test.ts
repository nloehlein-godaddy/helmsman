import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityReadServiceV1, ActivityReadSnapshotV1, PluginPanelContext, PluginPanelState, PullRequestReadServiceV1, TaskReadServiceV1, TaskReadSourceV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/repo';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'tasks', instanceRevision: 2, repo, label: 'Work', availability: 'available', readViews: ['history'] };
const snapshot: ActivityReadSnapshotV1 = { selection: source, history: { version: 1, repo, from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z', historyQuality: 'partial', throughputQuality: 'complete',
  days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${14 + index}`, completed: index === 6 ? 3 : 0 })), events: [{ id: 'history-1', ref: { sourceId, externalId: '1' }, displayKey: 'TASK-2', title: 'Source task', url: null, at: '2026-09-20T10:00:00.000Z', kind: 'status-changed', status: 'Done' }] } };
const lifetimes: AbortController[] = [];
function fixture() {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-activity', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }));
  const query = vi.fn<ActivityReadServiceV1['query']>(async () => ({ status: 'available', value: snapshot }));
  const prs = vi.fn<PullRequestReadServiceV1['list']>(async () => ({ status: 'available', value: { version: 1, repo, kind: 'authored-recent', quality: 'partial', truncated: true, browseUrl: null,
    items: [{ repo, number: 42, title: 'PR', url: 'https://provider.example/owner/repo/pull/42', status: 'merged', createdAt: '2026-09-19T10:00:00.000Z', mergedAt: '2026-09-20T11:00:00.000Z', draft: false, ticketId: 'TASK-2', reviewDecision: 'CHANGES_REQUESTED', comments: null, reviews: null }] } }));
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, tasks: { version: 1, discover, list: vi.fn(), load: vi.fn() }, activity: { version: 1, query }, pullRequests: { version: 1, list: prs, watchList: vi.fn() } }, saveState: vi.fn(), navigate: vi.fn(), onDispose: vi.fn() };
  return { container, lifetime, activity, state, context, discover, query, prs };
}
afterEach(() => { for (const lifetime of lifetimes.splice(0)) lifetime.abort(); document.body.replaceChildren(); vi.useRealTimers(); });
describe('standalone source activity panel', () => {
  it('refreshes source history from the footer with the standalone heading retained', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await instance.refresh?.();
    expect(f.container.querySelector('header button')).toBeNull(); expect(f.container.querySelector('header h2')).not.toBeNull();
    const reads = f.query.mock.calls.length; f.container.querySelector<HTMLButtonElement>('footer button')?.click();
    await vi.waitFor(() => expect(f.query.mock.calls.length).toBeGreaterThan(reads));
  });

  it('keeps source completion counts separate from actual PR events and does not invent review timestamps', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await instance.refresh?.();
    expect([...f.container.querySelectorAll('dd')].map(value => value.textContent)).toEqual(['0', '0', '0', '0', '0', '0', '3']);
    const rows = [...f.container.querySelectorAll('li')]; expect(rows).toHaveLength(3); expect(rows[0]?.textContent).toContain('PR #42 merged'); expect(rows[1]?.textContent).toContain('TASK-2 → Done');
    expect(f.container.textContent).not.toContain('changes requested'); expect(f.container.textContent).toContain('Source event history is partial'); expect(f.container.textContent).toContain('UTC');
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('https://provider.example/owner/repo/pull/42');
    expect(f.query).toHaveBeenCalledWith(source, expect.any(AbortSignal)); expect(f.prs).toHaveBeenCalledWith({ version: 1, repo, kind: 'authored-recent', limit: 12 }, expect.any(AbortSignal));
  });
  it('reports unavailable providers and unknown completion counts without fake zeroes or clean empty results', async () => {
    const f = fixture(); f.query.mockResolvedValue({ status: 'available', value: { ...snapshot, history: { ...snapshot.history, events: [], throughputQuality: 'partial', days: snapshot.history.days.map(day => ({ ...day, completed: null })) } } });
    f.prs.mockResolvedValue({ status: 'unavailable', reason: 'service-unavailable' }); const instance = await panel.mount(f.container, f.context); await instance.refresh?.();
    expect([...f.container.querySelectorAll('dd')].every(value => value.textContent === 'Unknown')).toBe(true); expect(f.container.textContent).toContain('Pull request activity unavailable'); expect(f.container.textContent).toContain('incomplete history'); expect(f.container.textContent).not.toContain('No activity in the available history');
  });
  it('keeps overlapping source metrics separate while deduplicating canonical source events', async () => {
    const f = fixture(); f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, { ...source, instanceId: 'second', label: 'Second view' }] } }] } });
    const instance = await panel.mount(f.container, f.context); await instance.refresh?.();
    expect(f.container.querySelectorAll('dl')).toHaveLength(2); expect(f.container.querySelectorAll('li')).toHaveLength(3); expect(f.container.textContent).toContain('Second view');
  });
  it('does not fall back to snapshots when history is undeclared and renders hostile labels as literal text', async () => {
    const f = fixture(); f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [{ ...source, label: '<img src=x onerror=alert(1)>', readViews: [] }] } }] } });
    const instance = await panel.mount(f.container, f.context); await instance.refresh?.(); expect(f.query).not.toHaveBeenCalled(); expect(f.container.textContent).toContain('does not provide task history'); expect(f.container.querySelector('img')).toBeNull();
  });
  it('coalesces refresh calls, discards stale activity, and reads again after visibility returns', async () => {
    const f = fixture(); let finish!: (result: Awaited<ReturnType<ActivityReadServiceV1['query']>>) => void; f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1)); void instance.refresh?.(); expect(f.query).toHaveBeenCalledTimes(1);
    await instance.update({ ...f.state, visible: false }); expect(f.query.mock.calls[0]?.[1]?.aborted).toBe(true);
    finish({ status: 'available', value: snapshot }); await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).not.toContain('TASK-2');
    await instance.update(f.state); await vi.waitFor(() => expect(f.container.textContent).toContain('TASK-2')); expect(f.query).toHaveBeenCalledTimes(2);
    f.lifetime.abort(); const reads = f.query.mock.calls.length; await instance.refresh?.(); expect(f.query).toHaveBeenCalledTimes(reads);
  });
  it('never overlaps periodic reads and stops polling on scope suspension', async () => {
    vi.useFakeTimers(); const f = fixture(); const instance = await panel.mount(f.container, f.context); await instance.refresh?.(); expect(f.query).toHaveBeenCalledTimes(1);
    f.query.mockImplementation(() => new Promise(() => {})); await vi.advanceTimersByTimeAsync(90_000); expect(f.query).toHaveBeenCalledTimes(2);
    await instance.update({ ...f.state, activity: { ...f.state.activity, active: false } }); await vi.advanceTimersByTimeAsync(60_000); expect(f.query).toHaveBeenCalledTimes(2);
  });
});
