import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, TaskReadServiceV1, TaskReadSourceV1, TaskViewsReadServiceV1, TaskBugsReportV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/project';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'source-one', instanceRevision: 2, repo, label: 'Tasks', availability: 'available', readViews: ['bugs'] };
const unknown = { value: null, quality: 'unavailable' as const }; const known = { value: 25000, quality: 'approximate' as const };
const report: TaskBugsReportV1 = { version: 1, repo, asOf: '2026-09-20T00:00:00.000Z', open: known, createdLast7d: unknown, completedLast7d: { value: 0, quality: 'exact' }, pastSla: unknown,
  rows: [{ ref: { sourceId, externalId: '1' }, displayKey: 'TASK-1', title: 'Actual bug', url: 'https://bugs.example/1', priority: 'P1', severity: null, dueAt: '2026-09-18', createdAt: '2026-09-10T00:00:00.000Z' }], rowsQuality: 'partial',
  oldest: null, oldestQuality: 'partial', resolutionP75: { days: 4.5, sampleSize: 100, population: known, quality: 'partial', capped: true } };
function fixture() {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }));
  const bugs = vi.fn<TaskViewsReadServiceV1['bugs']>(async () => ({ status: 'available', value: { selection: source, report } }));
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, tasks: { version: 1, discover, list: vi.fn(), load: vi.fn() }, taskViews: { version: 1, bugs, triage: vi.fn() } }, saveState: vi.fn(async () => {}), navigate: vi.fn(), onDispose: vi.fn() };
  return { container, lifetime, activity, state, context, discover, bugs };
}
afterEach(() => document.body.replaceChildren());
describe('standalone Bugs presentation', () => {
  it('preserves null, exact-zero and approximate counts alongside sample coverage and actual dates', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
    const values = [...f.container.querySelectorAll('dd')].map(value => value.textContent); expect(values.slice(0, 4)).toEqual(['≈ 25,000', 'Unavailable', '0', 'Unavailable']);
    expect(f.container.textContent).toContain('100 sampled · Population ≈ 25,000 · partial · capped sample');
    expect(f.container.textContent).toContain('2026-09-18'); expect(f.container.textContent).toContain('Open bug rows have partial coverage');
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('https://bugs.example/1'); f.lifetime.abort();
  });
  it('does not call unavailable empty rows a clean zero and isolates source failure', async () => {
    const f = fixture(); f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, { ...source, instanceId: 'disabled', label: 'Disabled', availability: 'disabled' }] } }] } });
    f.bugs.mockResolvedValue({ status: 'available', value: { selection: source, report: { ...report, rows: [], rowsQuality: 'unavailable' } } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Open bug rows are unavailable or incomplete'));
    expect(f.container.textContent).not.toContain('No open bugs.'); expect(f.container.textContent).toContain('Source disabled'); expect(f.bugs).toHaveBeenCalledOnce(); f.lifetime.abort();
  });
  it('retains unavailable selection and never silently replaces it with another source', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 1, value: { repo, sourceId, instanceId: 'missing' } } } };
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Your selection is kept')); expect(f.bugs).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('cancels hidden work and rejects stale scope data on reactivation', async () => {
    const f = fixture(); const original = f.bugs.getMockImplementation()!; let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
    f.bugs.mockImplementation(async (...args) => { await wait; return original(...args); }); const instance = await panel.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.bugs).toHaveBeenCalledOnce()); f.activity.abort();
    await instance.update({ ...f.state, repo: 'other/repo', visible: false, activity: { ...f.state.activity, repo: 'other/repo', epoch: 2, active: false } }); finish();
    await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).not.toContain('Actual bug');
    const active = new AbortController(); await instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 3, signal: active.signal } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug')); f.lifetime.abort();
  });
});

it('renders independent source cards and provider text literally without inventing scope links', async () => {
  const f = fixture(); const second = { ...source, sourceId: '22222222-2222-4222-8222-222222222222', instanceId: 'second-source', label: 'Second source' };
  f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, second] } }] } });
  f.bugs.mockImplementation(async query => ({ status: 'available', value: { selection: query, report: { ...report, rows: [{ ...report.rows[0]!, title: '<img src=x onerror=alert(1)>', ref: { sourceId: query.sourceId, externalId: '1' } }] } } }));
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.bugs).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.container.textContent).toContain('Second source')); expect(f.container.textContent).toContain('<img src=x onerror=alert(1)>'); expect(f.container.querySelector('img,script')).toBeNull(); f.lifetime.abort();
});

it('clears old rows during an active repository change and rejects a late previous-scope response', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  const nextRepo = 'other/repo'; const nextSource = { ...source, repo: nextRepo }; let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  f.bugs.mockImplementation(async query => { if (query.repo === repo) await wait; return { status: 'available', value: { selection: query, report: { ...report, repo: query.repo, rows: [{ ...report.rows[0]!, title: query.repo === repo ? 'Late former bug' : 'Current scoped bug' }] } } }; });
  void instance.refresh?.(); await vi.waitFor(() => expect(f.bugs.mock.calls.length).toBe(2));
  f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: nextRepo, galleons: [{ repo: nextRepo, sources: { status: 'available', value: [nextSource] } }] } });
  const nextActivity = new AbortController(); f.activity.abort(); await instance.update({ ...f.state, repo: nextRepo, activity: { repo: nextRepo, epoch: 2, active: true, signal: nextActivity.signal } });
  expect(f.container.textContent).not.toContain('Actual bug'); await vi.waitFor(() => expect(f.container.textContent).toContain('Current scoped bug'));
  finish(); await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).not.toContain('Late former bug'); expect(f.container.textContent).toContain('Current scoped bug'); f.lifetime.abort();
});
