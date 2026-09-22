import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, TaskReadServiceV1, TaskReadSourceV1, TaskTriageItemV1, TaskViewsReadServiceV1, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, RunCommandServiceV1, TaskReadTaskV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/project';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'source-one', instanceRevision: 2, repo, label: 'Tasks', availability: 'available', readViews: ['triage'] };
const task: TaskTriageItemV1 = { ref: { sourceId, externalId: '10001' }, revision: 'r1', displayKey: 'TASK-2', title: 'Canonical task', state: 'ready', priority: 1, url: null, updatedAt: '2026-09-20T00:00:00.000Z' };
const loadedTask: TaskReadTaskV1 = { version: 1, ...task, repo, requirements: { description: 'First line\n<img src=x onerror=alert(1)>', acceptanceCriteria: [], links: [] } };
const input: RunCommandInputV1 = { version: 1, action: 'launch', repo, launch: { mode: 'source', workRef: task.ref, sourceInstanceId: source.instanceId, sourceInstanceRevision: source.instanceRevision } };
const receipt: RunCommandReceiptV1 = { version: 1, repo, requestId: sourceId, action: 'launch', status: 'accepted', runId: 'run-one', attempt: 1, message: null };
function fixture() {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }));
  const triage = vi.fn<TaskViewsReadServiceV1['triage']>(async query => ({ status: 'available', value: { selection: source, query, page: { version: 1, repo, group: query.group, items: [task], nextCursor: null, quality: 'complete' }, relatedRuns: [{ ref: task.ref, repo, runId: 'old-run' }], relatedRunsQuality: 'complete' } }));
  let entries: readonly RunCommandPendingV1[] = [];
  const pending = vi.fn<RunCommandServiceV1['pending']>(async () => entries);
  const submit = vi.fn<RunCommandServiceV1['submit']>(async submitted => { entries = [{ command: { ...submitted, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; });
  const retry = vi.fn<NonNullable<RunCommandServiceV1['retry']>>(async query => {
    const entry = entries.find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
    return entry ? { status: 'available', value: { ...receipt, requestId: query.requestId } } : { status: 'unavailable', reason: 'not-found' };
  });
  const reconcile = vi.fn<RunCommandServiceV1['receipt']>(async () => { entries = entries.map(entry => ({ ...entry, receipt })); return { status: 'available', value: receipt }; });
  const acknowledge = vi.fn<RunCommandServiceV1['acknowledge']>(async query => { entries = entries.filter(entry => entry.command.requestId !== query.requestId); });
  const load = vi.fn<TaskReadServiceV1['load']>(async query => ({ status: 'available', value: { selection: source, ref: query.ref, task: loadedTask } }));
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services: { version: 1, tasks: { version: 1, discover, list: vi.fn(), load }, taskViews: { version: 1, triage, bugs: vi.fn() }, runCommands: { version: 1, submit, retry, pending, receipt: reconcile, acknowledge } }, saveState: vi.fn(async () => {}), navigate: vi.fn(), onDispose: vi.fn() };
  const buttons = (name: string) => [...container.querySelectorAll('button')].filter(button => button.textContent === name);
  return { container, lifetime, activity, state, context, discover, triage, load, pending, submit, retry, reconcile, acknowledge, buttons, set entries(value: readonly RunCommandPendingV1[]) { entries = value; } };
}
afterEach(() => document.body.replaceChildren());
describe('standalone Triage presentation', () => {
  it('loads independent groups and uses exact source identity for launch and related-run links', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Launch')[0]?.disabled).toBe(false));
    expect(f.triage.mock.calls.map(([query]) => query.group)).toEqual(['unassigned-backlog', 'unassigned-todo', 'mine-open']);
    expect(f.container.querySelector('a[href*="run=old-run"]')?.getAttribute('href')).toContain('repo=owner%2Fproject');
    f.buttons('Launch')[0]!.click(); f.buttons('Launch')[1]!.click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Launch accepted'));
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    expect(f.buttons('Launch').every(button => button.disabled)).toBe(true); f.lifetime.abort();
  });
  it('keeps independent partial/unavailable groups explicit and filters before pagination', async () => {
    const f = fixture(); const original = f.triage.getMockImplementation()!;
    f.triage.mockImplementation(async (...args) => { const result = await original(...args); if (result.status !== 'available') return result;
      return { ...result, value: { ...result.value, page: { ...result.value.page, items: args[0].group === 'unassigned-backlog' ? [] : [task], quality: args[0].group === 'unassigned-backlog' ? 'unavailable' : 'partial' } } }; });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('This group is unavailable'));
    expect(f.container.textContent).toContain('Partial coverage');
    const priority = f.container.querySelector<HTMLInputElement>('[aria-label="Priority P1"]')!; priority.checked = false; priority.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.triage.mock.calls.at(-1)?.[0].priorities).toEqual([0, 2, 3, 4]));
    const days = f.container.querySelector<HTMLSelectElement>('[aria-label="Last updated"]')!; days.value = '7'; days.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.triage.mock.calls.at(-1)?.[0].updatedSince).not.toBeNull());
    const query = f.triage.mock.calls.at(-1)![0]; expect(Date.parse(query.until) - Date.parse(query.updatedSince!)).toBe(7 * 86_400_000);
    expect(f.context.saveState).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ priorities: [0, 2, 3, 4], days: 7 }) })); f.lifetime.abort();
  });
  it('loads a bounded literal description only after its disclosure opens and retains its scoped state', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Show description')).toHaveLength(3));
    expect(f.load).not.toHaveBeenCalled(); f.buttons('Show description')[0]!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('First line'));
    expect(f.load).toHaveBeenCalledTimes(1); expect(f.load).toHaveBeenCalledWith({ ...source, ref: task.ref }, expect.any(AbortSignal));
    const toggle = f.container.querySelector<HTMLButtonElement>('[aria-label="Hide description for TASK-2"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(toggle);
    expect(f.container.textContent).toContain('<img src=x onerror=alert(1)>'); expect(f.container.querySelector('img,script')).toBeNull();
    expect(f.context.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ descriptionExpanded: [expect.stringContaining(sourceId)] }) }));
    await instance.refresh?.(); expect(f.load).toHaveBeenCalledTimes(2); expect(f.container.textContent).toContain('First line'); f.lifetime.abort();
  });
  it('uses unique description content IDs for repeated task rows', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Show description')).toHaveLength(3));
    for (const button of f.buttons('Show description')) button.click();
    await vi.waitFor(() => expect(f.container.querySelectorAll('.triage-description-content')).toHaveLength(3));
    const ids = [...f.container.querySelectorAll<HTMLElement>('.triage-description-content')].map(content => content.id);
    expect(new Set(ids)).toHaveLength(ids.length); f.lifetime.abort();
  });
  it('aborts an in-flight description request when activity suspends', async () => {
    const f = fixture(); let requestSignal: AbortSignal | undefined;
    f.load.mockImplementation(async (_query, signal) => { requestSignal = signal; return await new Promise(() => {}); });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Show description')).toHaveLength(3)); f.buttons('Show description')[0]!.click();
    await vi.waitFor(() => expect(requestSignal).toBeDefined()); f.activity.abort();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true)); f.lifetime.abort();
  });
  it('does not render a description when the exact task revision changed during its load', async () => {
    const f = fixture(); f.load.mockResolvedValue({ status: 'available', value: { selection: source, ref: task.ref, task: { ...loadedTask, revision: 'r2', requirements: { ...loadedTask.requirements, description: 'Stale description' } } } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Show description')).toHaveLength(3)); f.buttons('Show description')[0]!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Description changed. Refresh to retry.'));
    expect(f.container.textContent).not.toContain('Stale description'); f.lifetime.abort();
  });
  it('keeps a stable query window through next/previous pages', async () => {
    const f = fixture(); const original = f.triage.getMockImplementation()!;
    f.triage.mockImplementation(async (...args) => { const result = await original(...args); if (result.status !== 'available') return result; const cursor = args[0].cursor;
      return { ...result, value: { ...result.value, page: { ...result.value.page, items: [{ ...task, ref: { ...task.ref, externalId: cursor ? 'second' : 'first' }, title: cursor ? 'Second page' : 'First page' }], nextCursor: cursor ? null : 'next' }, relatedRuns: [] } }; });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Next')[0]?.disabled).toBe(false));
    const first = f.triage.mock.calls[0]![0]; f.buttons('Next')[0]!.click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Second page'));
    expect(f.triage.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: 'next', until: first.until, updatedSince: first.updatedSince });
    f.buttons('Previous')[0]!.click(); expect(f.container.textContent).not.toContain('Second page'); const reads = f.triage.mock.calls.length;
    f.buttons('Next')[0]!.click(); expect(f.container.textContent).toContain('Second page'); expect(f.triage).toHaveBeenCalledTimes(reads); f.lifetime.abort();
  });
  it('retains saved requests after source disablement, retries original identity and scopes Recovery', async () => {
    const f = fixture(); f.entries = [{ command: { ...input, requestId: sourceId }, receipt: { ...receipt, status: 'recovery-required' } }];
    f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [{ ...source, availability: 'disabled' }] } }] } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Launch requires Recovery'));
    expect(f.container.querySelector('a[href*="/recovery"]')?.getAttribute('href')).toContain('repo=owner%2Fproject'); expect(f.triage).not.toHaveBeenCalled(); expect(f.buttons('Retry delivery')).toEqual([]); f.lifetime.abort();
  });
  it('fences late data across scope epochs and blocks launches from All', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, repo: null } }; const instance = await panel.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title)); expect(f.buttons('Launch')).toEqual([]);
    const original = f.triage.getMockImplementation()!; let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
    f.triage.mockImplementation(async (...args) => { await wait; return original(...args); }); void instance.refresh?.();
    await vi.waitFor(() => expect(f.triage.mock.calls.length).toBeGreaterThan(3)); f.activity.abort();
    await instance.update({ ...f.state, repo: 'other/project', activity: { ...f.state.activity, repo: 'other/project', epoch: 2, active: false } }); finish(); await Promise.resolve(); await Promise.resolve();
    expect(f.container.textContent).not.toContain(task.title); f.lifetime.abort();
  });
  it('keeps unsupported saved selections instead of widening to all sources', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 1, value: { source: { nonsense: true } } } } };
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('unsupported data')); expect(f.triage).not.toHaveBeenCalled(); f.lifetime.abort();
  });
  it('does not rewrite an unknown saved-state version through filter controls', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 99, value: { future: true } } } };
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('unsupported data'));
    expect(f.container.querySelector('fieldset')?.disabled).toBe(true);
    const priority = f.container.querySelector<HTMLInputElement>('[aria-label="Priority P1"]')!; priority.dispatchEvent(new Event('change'));
    expect(f.context.saveState).not.toHaveBeenCalled(); f.lifetime.abort();
  });
});

it('preserves migrated group collapse defaults and explicit expansion through refresh', async () => {
  const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 1, value: { source: null, priorities: [1], days: 7, pageSize: 25, collapsed: [], legacyCollapsedGroups: ['unassigned-backlog'], expanded: [] } } } };
  const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Expand group')).toHaveLength(1));
  expect(f.triage.mock.calls[0]?.[0]).toMatchObject({ priorities: [1], limit: 25 });
  f.buttons('Expand group')[0]!.click(); await vi.waitFor(() => expect(f.context.saveState).toHaveBeenCalled());
  expect(f.context.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ legacyCollapsedGroups: ['unassigned-backlog'], expanded: [expect.any(String)] }) }));
  await instance.refresh?.(); expect(f.buttons('Expand group')).toHaveLength(0);
  f.buttons('Collapse group')[0]!.click(); await instance.refresh?.(); expect(f.buttons('Expand group')).toHaveLength(1); f.lifetime.abort();
});
it.each(['backlog', 'todo', 'mine'] as const)('reveals legacy %s pane once and retains a later user collapse', async pane => {
  const f = fixture(); const routeState = { version: 1, value: { pane } }; const group = pane === 'backlog' ? 'unassigned-backlog' : pane === 'todo' ? 'unassigned-todo' : 'mine-open';
  const state = { ...f.state, routeState, savedState: { version: 1, value: { source: null, collapsed: [], legacyCollapsedGroups: [group], expanded: [] } } };
  f.context = { ...f.context, state }; const instance = await panel.mount(f.container, f.context);
  await vi.waitFor(() => expect(f.container.querySelector(`[data-triage-group="${group}"] ul`)).not.toBeNull());
  expect(document.activeElement).toBe(f.container.querySelector(`[data-triage-group="${group}"]`));
  const collapse = f.container.querySelector<HTMLButtonElement>(`[data-triage-group="${group}"] button`)!; collapse.click();
  await instance.refresh?.(); expect(f.container.querySelector(`[data-triage-group="${group}"] ul`)).toBeNull();
  await instance.update({ ...state, routeState: null }); await instance.update(state);
  expect(f.container.querySelector(`[data-triage-group="${group}"] ul`)).not.toBeNull(); f.lifetime.abort();
});
it.each([true, false])('renders provider text literally and preserves accurate group labels in Pirate mode %s', async pirateMode => {
  const f = fixture(); f.context = { ...f.context, state: { ...f.state, pirateMode } }; const original = f.triage.getMockImplementation()!;
  f.triage.mockImplementation(async (...args) => { const result = await original(...args); return result.status === 'available' ? { ...result, value: { ...result.value, page: { ...result.value.page, items: [{ ...task, title: '<img src=x onerror=alert(1)>' }] } } } : result; });
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('<img src=x onerror=alert(1)>'));
  expect(f.container.querySelector('img,script')).toBeNull(); expect(f.container.textContent).toContain('Mine · Open'); f.lifetime.abort();
});

it('clears old rows during an active repository change and rejects a late previous-scope response', async () => {
  const f = fixture(); const instance = await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
  const nextRepo = 'other/repo'; const nextSource = { ...source, repo: nextRepo }; let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  const original = f.triage.getMockImplementation()!;
  f.triage.mockImplementation(async (...args) => {
    if (args[0].repo === repo) await wait; const result = await original(...args);
    return result.status === 'available' ? { ...result, value: { ...result.value, selection: args[0].repo === repo ? source : nextSource, page: { ...result.value.page, repo: args[0].repo, items: [{ ...task, title: args[0].repo === repo ? 'Late former task' : 'Current scoped task' }] }, relatedRuns: [] } } : result;
  });
  void instance.refresh?.(); await vi.waitFor(() => expect(f.triage.mock.calls.length).toBeGreaterThan(3));
  f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: nextRepo, galleons: [{ repo: nextRepo, sources: { status: 'available', value: [nextSource] } }] } });
  const nextActivity = new AbortController(); f.activity.abort(); await instance.update({ ...f.state, repo: nextRepo, activity: { repo: nextRepo, epoch: 2, active: true, signal: nextActivity.signal } });
  expect(f.container.textContent).not.toContain(task.title); await vi.waitFor(() => expect(f.container.textContent).toContain('Current scoped task'));
  finish(); await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).not.toContain('Late former task'); expect(f.container.textContent).toContain('Current scoped task'); f.lifetime.abort();
});

it.each(['missing-retry', 'removed-request', 'newer-request'] as const)('never allocates launch identity from a retained row after %s', async scenario => {
  const f = fixture(); const original: RunCommandPendingV1 = { command: { ...input, requestId: sourceId }, receipt: null }; f.entries = [original];
  if (scenario === 'missing-retry') delete f.context.services.runCommands!.retry;
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.buttons('Check launch receipt')[0]?.disabled).toBe(false));
  const retry = f.buttons('Retry delivery')[0]!;
  if (scenario === 'missing-retry') { expect(retry.disabled).toBe(true); retry.click(); expect(f.retry).not.toHaveBeenCalled(); }
  else {
    const next: readonly RunCommandPendingV1[] = scenario === 'newer-request' ? [{ command: { ...input, requestId: '22222222-2222-4222-8222-222222222222' }, receipt: null }] : [];
    f.entries = next; retry.click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: sourceId }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.buttons('Retry delivery')).toHaveLength(next.length)); expect(await f.pending()).toEqual(next);
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled(); f.lifetime.abort();
});
