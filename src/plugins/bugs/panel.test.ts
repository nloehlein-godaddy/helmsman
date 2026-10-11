import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, TaskReadServiceV1, TaskReadSourceV1, TaskViewsReadServiceV1, TaskBugsReportV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/project';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'source-one', instanceRevision: 2, repo, label: 'Tasks', availability: 'available', readViews: ['bugs'] };
const unknown = { value: null, quality: 'unavailable' as const }; const known = { value: 25000, quality: 'approximate' as const };
const report: TaskBugsReportV1 = { version: 1, repo, asOf: '2026-09-20T00:00:00.000Z', open: known, createdLast7d: unknown, completedLast7d: { value: 0, quality: 'exact' }, pastSla: unknown,
  rows: [{ ref: { sourceId, externalId: '1' }, displayKey: 'TASK-1', title: 'Actual bug', url: 'https://bugs.example/1', priority: 'P1', severity: null, dueAt: '2026-09-18', createdAt: '2026-09-10T00:00:00.000Z', description: 'First line\n<img src=x onerror=alert(1)>' }], rowsQuality: 'partial',
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
    expect(f.container.textContent).toContain('Sep 18, 2026'); expect(f.container.querySelector('time[datetime="2026-09-18"]')).not.toBeNull(); expect(f.container.textContent).toContain('Open bug rows have partial coverage');
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('https://bugs.example/1'); f.lifetime.abort();
  });
  it('does not call unavailable empty rows a clean zero and isolates source failure', async () => {
    const f = fixture(); f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, { ...source, instanceId: 'disabled', label: 'Disabled', availability: 'disabled' }] } }] } });
    f.bugs.mockResolvedValue({ status: 'available', value: { selection: source, report: { ...report, rows: [], rowsQuality: 'unavailable' } } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Open bug rows are unavailable or incomplete'));
    expect(f.container.textContent).not.toContain('No open bugs.'); expect(f.container.textContent).toContain('Source disabled'); expect(f.bugs).toHaveBeenCalledOnce(); f.lifetime.abort();
  });
  it('renders only unambiguous S0-S5 values as accessible severity badges', async () => {
    const f = fixture(); f.bugs.mockResolvedValue({ status: 'available', value: { selection: source, report: { ...report, rows: [
      { ...report.rows[0]!, severity: 'S1 – Production outage' },
      { ...report.rows[0]!, ref: { sourceId, externalId: '2' }, severity: 'Severity S2 - Major' },
      { ...report.rows[0]!, ref: { sourceId, externalId: '3' }, severity: 'Critical S3' },
    ] } } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelector('.severity-badge')).not.toBeNull());
    const badge = f.container.querySelector<HTMLElement>('.severity-badge');
    expect(badge?.textContent).toBe('S1'); expect(badge?.getAttribute('aria-label')).toBe('Severity S1 – Production outage'); expect(badge?.getAttribute('title')).toBe('S1 – Production outage');
    const badges = f.container.querySelectorAll<HTMLElement>('.severity-badge');
    expect(badges).toHaveLength(2); expect(badges[1]?.getAttribute('aria-label')).toBe('Severity S2 - Major'); expect(f.container.textContent).toContain('Critical S3'); f.lifetime.abort();
  });
  it('uses matching priority badges without reinterpreting provider labels', async () => {
    const f = fixture(); const priorities = ['P0', 'Priority P2 - High', 'Critical P3', null];
    f.bugs.mockResolvedValue({ status: 'available', value: { selection: source, report: { ...report, rows: priorities.map((priority, index) => ({ ...report.rows[0]!, ref: { sourceId, externalId: String(index) }, priority })) } } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelector('.priority-badge')).not.toBeNull());
    const badges = f.container.querySelectorAll<HTMLElement>('.priority-badge');
    expect(badges).toHaveLength(2); expect(badges[0]?.textContent).toBe('P0'); expect(badges[0]?.getAttribute('aria-label')).toBe('Priority P0');
    expect(badges[1]?.textContent).toBe('P2'); expect(badges[1]?.getAttribute('title')).toBe('Priority P2 - High');
    expect(f.container.textContent).toContain('Critical P3'); expect(f.container.textContent).toContain('Unknown'); f.lifetime.abort();
  });
  it('persists task-scoped description disclosure, renders it as literal text, and keeps its focus on refresh', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Show description for TASK-1"]')).toBeTruthy());
    const toggle = f.container.querySelector<HTMLButtonElement>('[aria-label="Show description for TASK-1"]')!;
    expect(toggle.closest('td')?.className).toBe('bugs-expander-cell'); expect(toggle.closest('tr')?.querySelector('.bugs-title-cell button')).toBeNull();
    expect(toggle.textContent).toBe(''); expect(toggle.title).toBe('Show description for TASK-1'); expect(toggle.querySelector('[aria-hidden="true"]')).not.toBeNull(); toggle.click();
    expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Hide description for TASK-1"]')?.getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide description for TASK-1');
    expect(f.container.querySelector('.bugs-description-row td')?.getAttribute('colspan')).toBe('5');
    expect(f.container.textContent).toContain('<img src=x onerror=alert(1)>'); expect(f.container.querySelector('img,script')).toBeNull();
    await vi.waitFor(() => expect(f.context.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ descriptionExpanded: [expect.stringContaining(sourceId)] }) })));
    await instance.refresh?.(); await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide description for TASK-1')); f.lifetime.abort();
  });
  it('serializes rapid disclosure saves so the last choice persists', async () => {
    const f = fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const save = vi.fn(async () => {}); save.mockImplementationOnce(() => pending); f.context = { ...f.context, saveState: save };
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelector('.bugs-description-toggle')).not.toBeNull());
    f.container.querySelector<HTMLButtonElement>('.bugs-description-toggle')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    f.container.querySelector<HTMLButtonElement>('.bugs-description-toggle')!.click();
    f.container.querySelector<HTMLButtonElement>('.bugs-description-toggle')!.click();
    expect(save).toHaveBeenCalledOnce(); release();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(f.context.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ descriptionExpanded: [expect.stringContaining(sourceId)] }) })));
    expect(f.container.querySelector('.bugs-description-toggle')?.getAttribute('aria-expanded')).toBe('true'); f.lifetime.abort();
  });
  it('does not restore stale panel focus after the operator moves focus outside the panel', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Show description for TASK-1"]')).toBeTruthy());
    f.container.querySelector<HTMLButtonElement>('[aria-label="Show description for TASK-1"]')!.click();
    const header = document.createElement('button'); header.textContent = 'Header control'; document.body.append(header); header.focus();
    await instance.refresh?.(); await vi.waitFor(() => expect(document.activeElement).toBe(header)); f.lifetime.abort();
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

it('delegates heading and Refresh to the composed host while retaining standalone controls', async () => {
  const standalone = fixture(); await panel.mount(standalone.container, standalone.context);
  await vi.waitFor(() => expect(standalone.container.textContent).toContain('Actual bug'));
  expect(standalone.container.querySelector('h2')?.textContent).toBe('Bugs');
  expect(standalone.container.querySelector('[data-bugs-focus="refresh"]')).not.toBeNull();
  const composed = fixture(); const wrapper = document.createElement('section'); wrapper.dataset.compositionPage = 'bugs'; document.body.append(wrapper); wrapper.append(composed.container);
  await panel.mount(composed.container, composed.context); await vi.waitFor(() => expect(composed.container.textContent).toContain('Actual bug'));
  expect(composed.container.querySelector('h2')).toBeNull(); expect(composed.container.querySelector('[data-bugs-focus="refresh"]')).toBeNull();
  expect(composed.container.querySelector('.bugs-source')?.textContent).toContain('Source');
  expect(composed.container.querySelectorAll('thead th')).toHaveLength(5); standalone.lifetime.abort(); composed.lifetime.abort();
});

it('disambiguates same-label source instances and exposes galleon identity only when needed', async () => {
  const f = fixture(); const second = { ...source, instanceId: 'source-two' };
  f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, second] } }] } });
  const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.querySelectorAll('.bugs-report')).toHaveLength(2));
  const options = [...f.container.querySelectorAll('option')].map(option => option.textContent);
  expect(options).toEqual(['All bug sources', 'Tasks · source-one', 'Tasks · source-two']);
  expect(f.container.querySelector('.bugs-report-heading')?.textContent).not.toContain(repo);
  const activity = new AbortController(); await instance.update({ ...f.state, repo: null, activity: { repo: null, epoch: 2, active: true, signal: activity.signal } });
  await vi.waitFor(() => expect(f.container.querySelector('.bugs-report-heading')?.textContent).toContain(repo));
  expect(f.container.querySelector('select')?.textContent).toContain(`Tasks · source-one · ${repo}`); f.lifetime.abort();
});

it('keeps last-observed reports and description focus through a same-scope refresh failure', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  f.container.querySelector<HTMLButtonElement>('[aria-label="Show description for TASK-1"]')!.click();
  let fail!: () => void; f.bugs.mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new Error('offline')); }));
  const refreshing = instance.refresh?.(); await vi.waitFor(() => expect(f.bugs).toHaveBeenCalledTimes(2));
  expect(f.container.textContent).toContain('Actual bug'); expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide description for TASK-1');
  fail(); await refreshing; expect(f.container.textContent).toContain('Showing the last observed report.');
  expect(f.container.querySelector('time')?.getAttribute('datetime')).toBe(report.asOf);
  expect(f.container.textContent).toContain('<img src=x onerror=alert(1)>'); f.lifetime.abort();
});

it('keeps last-observed reports when discovery fails and clears that warning after recovery', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  f.discover.mockRejectedValueOnce(new Error('offline')); await instance.refresh?.();
  expect(f.container.textContent).toContain('Showing the last observed reports.'); expect(f.container.textContent).toContain('Actual bug');
  await instance.refresh?.(); expect(f.container.textContent).not.toContain('Showing the last observed reports.'); f.lifetime.abort();
});

it('uses human UTC dates without discarding raw evidence or treating malformed provider dates as ages', async () => {
  const f = fixture(); f.bugs.mockResolvedValue({ status: 'available', value: { selection: source, report: { ...report, oldest: { ...report.rows[0]!, createdAt: 'unparseable' } } } });
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  expect(f.container.querySelector('.bugs-observed')?.textContent).toContain('Sep 20, 2026');
  expect(f.container.querySelector('.bugs-observed')?.textContent).toContain('UTC');
  expect(f.container.textContent).toContain('Age unavailable'); expect(f.container.textContent).not.toContain('NaN');
  expect(f.container.textContent).toContain('75% of sampled completions resolved within this time.'); f.lifetime.abort();
});

it('does not retain a report from an earlier source revision or imply a known unavailable resolution time', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  const revised = { ...source, instanceRevision: source.instanceRevision + 1 };
  f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [revised] } }] } });
  f.bugs.mockRejectedValueOnce(new Error('unavailable')); await instance.refresh?.();
  expect(f.container.textContent).not.toContain('Actual bug'); expect(f.container.textContent).not.toContain('Showing the last observed report.');
  f.bugs.mockResolvedValue({ status: 'available', value: { selection: revised, report: { ...report, resolutionP75: { ...report.resolutionP75, days: null } } } }); await instance.refresh?.();
  expect(f.container.textContent).toContain('Resolution time · 75th percentile'); expect(f.container.textContent).not.toContain('resolved within this time'); f.lifetime.abort();
});

it('names each accessible table and retains explicit header, row and cell semantics for mobile layouts', async () => {
  const f = fixture(); await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  const table = f.container.querySelector('[role="table"]'); expect(table?.getAttribute('aria-label')).toBe('Open bugs · Tasks');
  expect(table?.querySelectorAll('[role="columnheader"][scope="col"]')).toHaveLength(5);
  expect(table?.querySelectorAll('[role="rowgroup"]')).toHaveLength(2);
  expect(table?.querySelector('tbody [role="row"]')?.querySelectorAll('[role="cell"]')).toHaveLength(5); f.lifetime.abort();
});

it('exposes busy state while readable last-observed reports are refreshing', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Actual bug'));
  expect(f.container.querySelector('.plugin-bugs')?.getAttribute('aria-busy')).toBe('false');
  const original = f.bugs.getMockImplementation()!; let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  f.bugs.mockImplementation(async (...args) => { await wait; return original(...args); }); const refreshing = instance.refresh?.();
  expect(f.container.querySelector('.plugin-bugs')?.getAttribute('aria-busy')).toBe('true'); expect(f.container.textContent).toContain('Actual bug');
  finish(); await refreshing; expect(f.container.querySelector('.plugin-bugs')?.getAttribute('aria-busy')).toBe('false'); f.lifetime.abort();
});

it('does not claim a retained last-observed report when all source reads failed', async () => {
  const f = fixture(); f.bugs.mockRejectedValue(new Error('offline')); const instance = await panel.mount(f.container, f.context);
  await vi.waitFor(() => expect(f.container.textContent).toContain('Bug metrics could not be read'));
  f.discover.mockRejectedValueOnce(new Error('offline')); await instance.refresh?.();
  expect(f.container.textContent).toContain('Task sources could not be read. Refresh to retry.'); expect(f.container.textContent).not.toContain('Showing the last observed');
  f.discover.mockResolvedValueOnce({ status: 'unavailable', reason: 'service-unavailable' }); await instance.refresh?.();
  expect(f.container.textContent).not.toContain('Showing the last observed'); f.lifetime.abort();
});
