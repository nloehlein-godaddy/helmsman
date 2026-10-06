import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, RunCommandPendingV1, RunCommandServiceV1, RunCommandV1, TaskReadServiceV1, TaskReadSourceV1, TaskReadTaskV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
import { emptyDraft, saveValue } from './state';

const repo = 'owner/project'; const otherRepo = 'owner/other';
const sourceId = '11111111-1111-4111-8111-111111111111';
const source: TaskReadSourceV1 = { version: 1, repo, sourceId, instanceId: 'source-one', instanceRevision: 2, label: 'Issue source', availability: 'available' };
const task: TaskReadTaskV1 = { version: 1, repo, ref: { sourceId, externalId: '10042' }, revision: 'r1', displayKey: 'ISSUE-42', title: 'Canonical task',
  url: null, state: 'ready', priority: null, requirements: { description: 'Work', acceptanceCriteria: [], links: [] } };
const lifetimes: AbortController[] = [];
afterEach(() => { for (const controller of lifetimes.splice(0)) controller.abort(); document.body.replaceChildren(); });
function fixture() {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); lifetimes.push(lifetime); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'newrun-one', savedState: null,
    activity: { repo, epoch: 1, active: true, signal: activity.signal } };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo: null, galleons: [
    { repo, sources: { status: 'available', value: [source] } }, { repo: otherRepo, sources: { status: 'available', value: [] } },
  ] } }));
  const list = vi.fn<TaskReadServiceV1['list']>(async () => ({ status: 'available', value: { selection: source, items: [task], nextCursor: null } }));
  const load = vi.fn<TaskReadServiceV1['load']>(async () => ({ status: 'available', value: { selection: source, ref: task.ref, task } }));
  const lookup = vi.fn<NonNullable<TaskReadServiceV1['lookup']>>(async () => ({ status: 'available', value: { selection: source, ref: task.ref, task } }));
  const journal: RunCommandPendingV1[] = [];
  const reserve = (input: Parameters<RunCommandServiceV1['submit']>[0]) => {
    const existing = journal.find(entry => { const { requestId: _id, ...saved } = entry.command; return JSON.stringify(saved) === JSON.stringify(input); });
    if (existing) return existing;
    const entry: RunCommandPendingV1 = { command: { ...input, requestId: `00000000-0000-4000-8000-${String(journal.length + 1).padStart(12, '0')}` }, receipt: null };
    journal.push(entry); return entry;
  };
  const submit = vi.fn<RunCommandServiceV1['submit']>(async input => {
    const entry = reserve(input); const receipt = { version: 1 as const, requestId: entry.command.requestId, repo: input.repo, action: input.action,
      status: 'accepted' as const, runId: 'new-run', attempt: 1, message: null };
    journal[journal.indexOf(entry)] = { command: entry.command, receipt }; return { status: 'available', value: receipt };
  });
  const retry = vi.fn<NonNullable<RunCommandServiceV1['retry']>>(async query => {
    const entry = journal.find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
    if (!entry) return { status: 'unavailable', reason: 'not-found' };
    const receipt = { version: 1 as const, ...query, action: entry.command.action, status: 'accepted' as const, runId: 'new-run', attempt: 1, message: null };
    journal[journal.indexOf(entry)] = { command: entry.command, receipt }; return { status: 'available', value: receipt };
  });
  const pending = vi.fn<RunCommandServiceV1['pending']>(async () => [...journal]);
  const receipt = vi.fn<RunCommandServiceV1['receipt']>(async query => ({ status: 'available', value: journal.find(entry => entry.command.requestId === query.requestId && entry.command.repo === query.repo)?.receipt ?? null }));
  const acknowledge = vi.fn<RunCommandServiceV1['acknowledge']>(async query => { const index = journal.findIndex(entry => entry.command.requestId === query.requestId && entry.command.repo === query.repo); if (index >= 0) journal.splice(index, 1); });
  const saveState = vi.fn<PluginPanelContext['saveState']>(async () => {});
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), saveState,
    services: { version: 1, tasks: { version: 1, discover, list, load, lookup }, runCommands: { version: 1, submit, retry, pending, receipt, acknowledge } } };
  return { container, lifetime, activity, state, context, discover, list, load, lookup, saveState, journal, reserve, submit, retry, pending, receipt, acknowledge };
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const value = Array.from(container.querySelectorAll('button')).find(button => button.textContent === text);
  if (!value) throw new Error(`Missing button ${text}: ${container.textContent}`); return value;
}
function field(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const value = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!value) throw new Error(`Missing field ${label}`); return value;
}
function edit(container: HTMLElement, label: string, value: string): void {
  const input = field(container, label); input.value = value; input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function ready(f: ReturnType<typeof fixture>) { await vi.waitFor(() => expect(button(f.container, 'Start run').disabled).toBe(false)); }
async function selectSource(f: ReturnType<typeof fixture>) {
  edit(f.container, 'Launch mode', 'source');
  const select = field(f.container, 'Task source') as HTMLSelectElement;
  edit(f.container, 'Task source', select.options[1]!.value);
  await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
  const tasks = field(f.container, 'Task') as HTMLSelectElement; edit(f.container, 'Task', tasks.options[1]!.value);
  await ready(f);
}
describe('New Run authored panel', () => {
  it('shares launch actions with refresh while composed headers consume no extra row', async () => {
    const f = fixture(); f.container.dataset.panelInstance = 'launch'; f.container.setAttribute('role', 'tabpanel'); f.container.setAttribute('aria-labelledby', 'launch-tab');
    await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'Keep this draft during refresh');
    expect(f.container.querySelector('header button')).toBeNull();
    expect(window.getComputedStyle(f.container.querySelector('header')!).display).toBe('contents');
    expect(Array.from(f.container.querySelectorAll('.newrun-actions button')).map(button => button.textContent)).toEqual(['Start run', 'Save draft', 'Refresh']);
    const reads = f.discover.mock.calls.length; button(f.container, 'Refresh').click();
    await vi.waitFor(() => expect(f.discover.mock.calls.length).toBeGreaterThan(reads)); await ready(f);
    expect(field(f.container, 'Task instructions').value).toBe('Keep this draft during refresh');
    expect(f.submit).not.toHaveBeenCalled();
    f.container.removeAttribute('role');
    expect(window.getComputedStyle(f.container.querySelector('header')!).display).toBe('flex');
    expect(window.getComputedStyle(f.container.querySelector('h2')!).position).not.toBe('absolute');
  });

  it('reveals saved tuning on scope changes and preserves explicit disclosure within that scope', async () => {
    const f = fixture(); const savedState = saveValue({ selectedRepo: repo, drafts: [
      { repo: otherRepo, draft: { ...emptyDraft(), model: 'gpt-5.6-sol', effort: 'high' } },
    ] });
    const initial = { ...f.state, repo: null, savedState, activity: { ...f.state.activity, repo: null } };
    const instance = await panel.mount(f.container, { ...f.context, state: initial }); await ready(f);
    const disclosure = () => f.container.querySelector<HTMLDetailsElement>('.newrun-advanced')!;
    expect(disclosure().open).toBe(false);
    edit(f.container, 'Galleon', otherRepo); await ready(f);
    expect(disclosure().open).toBe(true);
    expect(field(f.container, 'Model (optional)').value).toBe('gpt-5.6-sol');
    expect(field(f.container, 'Effort').value).toBe('high');
    disclosure().open = false;
    await instance.update({ ...initial, themeId: 'light' });
    expect(disclosure().open).toBe(false);
    await instance.refresh?.();
    expect(disclosure().open).toBe(false);
    edit(f.container, 'Galleon', repo); await ready(f);
    expect(disclosure().open).toBe(false);
    edit(f.container, 'Galleon', otherRepo); await ready(f);
    expect(disclosure().open).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps keyboard focus on tuning disclosure through asynchronous refresh', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    const result = await f.discover();
    let complete!: (value: typeof result) => void;
    f.discover.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const refreshed = instance.refresh?.();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const summary = f.container.querySelector<HTMLElement>('summary[aria-label="Model and effort"]')!;
    summary.focus();
    expect(document.activeElement).toBe(summary);
    complete(result); await refreshed;
    expect(document.activeElement).toBe(f.container.querySelector('summary[aria-label="Model and effort"]'));
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('preserves task text, mode, galleon choice and tuning through theme and wording changes', async () => {
    const f = fixture(); const initial = { ...f.state, repo: null, activity: { ...f.state.activity, repo: null } };
    const instance = await panel.mount(f.container, { ...f.context, state: initial });
    await vi.waitFor(() => expect((field(f.container, 'Galleon') as HTMLSelectElement).options.length).toBe(3));
    edit(f.container, 'Galleon', otherRepo); await ready(f);
    const values = [['Task instructions', 'Preserve this unsent task\nAnd its second line.'], ['Model (optional)', 'gpt-5.6-sol'], ['Effort', 'xhigh']] as const;
    for (const [label, value] of values) edit(f.container, label, value);
    for (const pirateMode of [true, false]) {
      await instance.update({ ...initial, pirateMode, themeId: pirateMode ? 'light' : 'dark' });
      for (const [label, value] of values) expect(field(f.container, label).value).toBe(value);
      expect(field(f.container, 'Launch mode').value).toBe('freeform');
      expect(field(f.container, 'Galleon').value).toBe(otherRepo);
    }
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps a pending launch disabled through wording updates without duplicate submission', async () => {
    const f = fixture(); let finish!: () => void;
    const submit = f.submit.getMockImplementation()!;
    f.submit.mockImplementation(async (input, signal) => { await new Promise<void>(resolve => { finish = resolve; }); return submit(input, signal); });
    const instance = await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'Launch once'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    for (const pirateMode of [true, false]) {
      await instance.update({ ...f.state, pirateMode });
      const launch = button(f.container, pirateMode ? 'Weigh anchor' : 'Start run');
      expect(launch.disabled).toBe(true); launch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(field(f.container, 'Task instructions').value).toBe('Launch once');
    }
    expect(f.submit).toHaveBeenCalledOnce(); finish();
    await vi.waitFor(() => expect(f.container.textContent).toContain('accepted'));
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it('saves scoped instructions before launch and retains accepted receipt until explicit dismissal', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f);
    expect(f.container.querySelector('[aria-label="Galleon"]')).toBeNull();
    edit(f.container, 'Task instructions', 'Implement with tests'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledWith({ version: 1, repo, action: 'launch', launch: { mode: 'freeform', task: 'Implement with tests' } }, expect.any(AbortSignal));
    expect(f.saveState.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.submit.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(f.container.textContent).toContain('accepted'));
    expect(f.acknowledge).not.toHaveBeenCalled(); expect(field(f.container, 'Task instructions').value).toBe('Implement with tests');
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/runs?repo=owner%2Fproject&run=new-run');
    button(f.container, 'Dismiss request').click(); await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalledTimes(1));
    await ready(f);
  });
  it.each(['review', 'rerun'] as const)('launches %s with validated PR identity and tuning', async mode => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Launch mode', mode); edit(f.container, 'PR number', '42');
    if (mode === 'rerun') edit(f.container, 'PR feedback', 'Fix the edge case');
    edit(f.container, 'Model (optional)', 'gpt-6-astra'); edit(f.container, 'Effort', 'high');
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ repo, launch: { mode, prNumber: 42, model: 'gpt-6-astra', effort: 'high', ...(mode === 'rerun' ? { feedback: 'Fix the edge case' } : {}) } });
  });
  it('rejects empty instructions and invalid PRs before calling commands', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f);
    button(f.container, 'Start run').click(); expect(f.container.textContent).toContain('Enter task instructions');
    edit(f.container, 'Launch mode', 'review'); edit(f.container, 'PR number', '0'); button(f.container, 'Start run').click();
    expect(f.container.textContent).toContain('positive PR'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('launches the canonical source reference after reloading its exact revision and galleon', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f); await selectSource(f);
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.load).toHaveBeenCalledWith(expect.objectContaining({ repo, sourceId, instanceId: source.instanceId, instanceRevision: 2, ref: task.ref }), expect.any(AbortSignal));
    expect(f.submit.mock.calls[0]?.[0]).toEqual({ version: 1, repo, action: 'launch', launch: { mode: 'source', workRef: { sourceId, externalId: '10042' }, sourceInstanceId: source.instanceId, sourceInstanceRevision: 2 } });
  });
  it('rejects a source task that changed scope or readiness before launch', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f); await selectSource(f);
    f.load.mockResolvedValue({ status: 'available', value: { selection: source, ref: task.ref, task: { ...task, state: 'done' } } });
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('no longer ready')); expect(f.submit).not.toHaveBeenCalled();
  });
  it('resolves typed display keys through the selected source and launches the returned immutable identity', async () => {
    const f = fixture(); f.list.mockResolvedValue({ status: 'available', value: { selection: source, items: [], nextCursor: null } });
    await panel.mount(f.container, f.context); await ready(f); edit(f.container, 'Launch mode', 'source');
    edit(f.container, 'Task source', (field(f.container, 'Task source') as HTMLSelectElement).options[1]!.value); await ready(f);
    edit(f.container, 'Task key', 'OLD-42'); button(f.container, 'Find task').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('ISSUE-42: Canonical task'));
    expect(f.lookup).toHaveBeenCalledWith({ version: 1, repo, sourceId, instanceId: source.instanceId, instanceRevision: 2, displayKey: 'OLD-42' }, expect.any(AbortSignal));
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ launch: { workRef: task.ref } });
  });
  it('does not let a late lookup overwrite a newly edited key', async () => {
    const f = fixture(); let resolve!: (value: Awaited<ReturnType<NonNullable<TaskReadServiceV1['lookup']>>>) => void;
    f.lookup.mockImplementation(() => new Promise(done => { resolve = done; }));
    await panel.mount(f.container, f.context); await ready(f); await selectSource(f);
    edit(f.container, 'Task key', 'OLD-42'); button(f.container, 'Find task').click();
    edit(f.container, 'Task key', 'OTHER-9'); resolve({ status: 'available', value: { selection: source, ref: { sourceId, externalId: '99' }, task: { ...task, ref: { sourceId, externalId: '99' }, title: 'Late task' } } });
    await vi.waitFor(() => expect(button(f.container, 'Find task').disabled).toBe(false));
    expect(f.container.textContent).not.toContain('Late task'); expect(field(f.container, 'Task key').value).toBe('OTHER-9');
  });
  it('keeps unknown key lookup distinct from a task deleted before load', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f); await selectSource(f);
    f.lookup.mockResolvedValueOnce({ status: 'available', value: null }); edit(f.container, 'Task key', 'MISSING-1'); button(f.container, 'Find task').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Task key not found'));
    f.lookup.mockResolvedValueOnce({ status: 'available', value: { selection: source, ref: task.ref, task: null } }); button(f.container, 'Find task').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('task disappeared'));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('clears a previous task when editing its key and refresh releases a cancelled lookup', async () => {
    const f = fixture(); f.lookup.mockImplementation(() => new Promise(() => {}));
    const instance = await panel.mount(f.container, f.context); await ready(f); await selectSource(f);
    edit(f.container, 'Task key', 'ANOTHER-1'); expect(field(f.container, 'Task').value).toBe('');
    button(f.container, 'Find task').click(); expect(button(f.container, 'Start run').disabled).toBe(true);
    await instance.refresh?.(); await vi.waitFor(() => expect(button(f.container, 'Find task').disabled).toBe(false));
    expect(field(f.container, 'Task').value).toBe(''); expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps a missing saved source revision until explicitly replaced', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: saveValue({ selectedRepo: null, drafts: [{ repo, draft: { ...emptyDraft(), mode: 'source', source: { ...source, instanceRevision: 1 }, ref: task.ref } }] }) } };
    await panel.mount(f.container, f.context); await ready(f);
    expect(f.container.textContent).toContain('Saved source unavailable or changed'); expect(f.list).not.toHaveBeenCalled();
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('saved source selection changed')); expect(f.submit).not.toHaveBeenCalled();
  });
  it('requires an explicit local galleon only in all-galleon scope', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, repo: null, activity: { ...f.state.activity, repo: null } } };
    await panel.mount(f.container, f.context);
    await vi.waitFor(() => expect((field(f.container, 'Galleon') as HTMLSelectElement).options.length).toBe(3));
    expect(f.container.querySelector('[aria-label="Task instructions"]')).toBeNull();
    edit(f.container, 'Galleon', otherRepo); await ready(f); edit(f.container, 'Task instructions', 'Work elsewhere'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); expect(f.submit.mock.calls[0]?.[0].repo).toBe(otherRepo);
  });
  it('preserves independent drafts across scope switches and remount', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'First galleon'); await vi.waitFor(() => expect(f.saveState).toHaveBeenCalled());
    const alternate = { ...f.state, repo: otherRepo, activity: { ...f.state.activity, repo: otherRepo, epoch: 2, signal: new AbortController().signal } };
    await instance.update(alternate); await ready(f); edit(f.container, 'Task instructions', 'Second galleon');
    await vi.waitFor(() => expect(JSON.stringify(f.saveState.mock.calls.at(-1)?.[0])).toContain('Second galleon'));
    await instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 3, signal: new AbortController().signal } }); await ready(f);
    expect(field(f.container, 'Task instructions').value).toBe('First galleon');
    const savedState = f.saveState.mock.calls.at(-1)![0]; await instance.dispose();
    const next = fixture(); await panel.mount(next.container, { ...next.context, state: { ...next.state, savedState } }); await ready(next);
    expect(field(next.container, 'Task instructions').value).toBe('First galleon');
  });
  it('preserves unsaved text and blocks launch or acknowledgment when saving fails', async () => {
    const f = fixture(); f.saveState.mockRejectedValue(new Error('Conflict')); await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'Keep this draft'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Draft could not be saved')); expect(f.submit).not.toHaveBeenCalled();
    expect(field(f.container, 'Task instructions').value).toBe('Keep this draft');
  });
  it('enforces aggregate saved-state bytes without losing oversized text', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', '界'.repeat(6000)); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('16 KiB'));
    expect(field(f.container, 'Task instructions').value).toHaveLength(6000); expect(f.submit).not.toHaveBeenCalled();
  });
  it('deduplicates double clicks while saving the draft', async () => {
    const f = fixture(); let complete!: () => void;
    f.saveState.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'Once'); button(f.container, 'Start run').click(); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function')); complete();
    await vi.waitFor(() => expect(f.saveState).toHaveBeenCalledTimes(2)); complete();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  });
  it('restores lost response identity and explicitly retries delivery of the same command', async () => {
    const f = fixture(); f.submit.mockImplementationOnce(async input => { f.reserve(input); return { status: 'unavailable', reason: 'connection-failed' }; });
    await panel.mount(f.container, f.context); await ready(f); edit(f.container, 'Task instructions', 'Protected'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('delivery unconfirmed'));
    const requestId = f.journal[0]!.command.requestId; expect(button(f.container, 'Start run').disabled).toBe(true);
    button(f.container, 'Check request').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('No recorded receipt'));
    button(f.container, 'Retry delivery').click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId }, expect.any(AbortSignal)));
    expect(f.journal).toHaveLength(1); expect(f.journal[0]?.command.requestId).toBe(requestId); expect(f.submit).toHaveBeenCalledOnce();
  });
  it('keeps unknown outcomes after scope cancellation without clearing the draft', async () => {
    const f = fixture(); let finish!: () => void;
    f.submit.mockImplementation(async input => { f.reserve(input); await new Promise<void>(resolve => { finish = resolve; }); return { status: 'unavailable', reason: 'connection-failed' }; });
    const instance = await panel.mount(f.container, f.context); await ready(f); edit(f.container, 'Task instructions', 'Keep after hiding'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); f.activity.abort();
    await instance.update({ ...f.state, visible: false, activity: { ...f.state.activity, active: false } }); finish();
    await instance.update({ ...f.state, activity: { ...f.state.activity, epoch: 2, signal: new AbortController().signal } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('delivery unconfirmed'));
    expect(field(f.container, 'Task instructions').value).toBe('Keep after hiding'); expect(f.acknowledge).not.toHaveBeenCalled();
  });
  it('offers recovery instead of delivery retry for ambiguous execution evidence', async () => {
    const f = fixture(); const command: RunCommandV1 = { version: 1, repo, action: 'launch', requestId: '00000000-0000-4000-8000-000000000001', launch: { mode: 'freeform', task: 'Already sent' } };
    f.journal.push({ command, receipt: { version: 1, requestId: command.requestId, repo, action: 'launch', status: 'recovery-required', runId: 'run', attempt: 1, message: null } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('recovery-required'));
    expect(f.container.textContent).not.toContain('Retry delivery'); expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/recovery?repo=owner%2Fproject');
  });
  it('does not overwrite unsupported saved state or accept commands while journal reads fail', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 99, value: { future: true } } } };
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('unsupported format'));
    expect(f.saveState).not.toHaveBeenCalled(); expect(f.container.querySelector('form')).toBeNull();
    const next = fixture(); next.pending.mockRejectedValue(new Error('Storage unavailable')); await panel.mount(next.container, next.context);
    await vi.waitFor(() => expect(next.container.textContent).toContain('Saved launch requests could not be read')); expect(button(next.container, 'Start run').disabled).toBe(true);
  });
  it('preserves focused input and caret when the host acknowledges saved state', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    const input = field(f.container, 'Task instructions') as HTMLTextAreaElement; input.focus(); edit(f.container, 'Task instructions', 'Keep the caret'); input.setSelectionRange(4, 4);
    await vi.waitFor(() => expect(f.saveState).toHaveBeenCalled());
    await instance.update({ ...f.state, savedState: f.saveState.mock.calls.at(-1)![0] });
    expect(document.activeElement).toBe(field(f.container, 'Task instructions'));
    expect((field(f.container, 'Task instructions') as HTMLTextAreaElement).selectionStart).toBe(4);
  });
  it('keeps more than 100 terminal requests dismissible without collapsing their IDs', async () => {
    const f = fixture();
    for (let index = 0; index < 101; index++) {
      const requestId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      f.journal.push({ command: { version: 1, requestId, repo, action: 'launch', launch: { mode: 'freeform', task: `Task ${index}` } },
        receipt: { version: 1, requestId, repo, action: 'launch', status: 'accepted', runId: `run-${index}`, attempt: 1, message: null } });
    }
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('Showing 100 of 101'));
    expect(f.container.querySelectorAll('a')).toHaveLength(100);
    button(f.container, 'Dismiss request').click(); await vi.waitFor(() => expect(f.journal).toHaveLength(100));
    expect(f.acknowledge).toHaveBeenCalledWith({ repo, requestId: '00000000-0000-4000-8000-000000000001' });
    await vi.waitFor(() => expect(f.container.textContent).not.toContain('Showing 100 of 101'));
    expect(Array.from(f.container.querySelectorAll('a')).some(link => link.href.includes('run=run-100'))).toBe(true);
  });
  it('does not acknowledge an accepted launch while its edited draft remains unsaved', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f);
    edit(f.container, 'Task instructions', 'Accepted'); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('accepted'));
    f.saveState.mockRejectedValue(new Error('Conflict')); edit(f.container, 'Task instructions', 'Keep this new draft');
    button(f.container, 'Dismiss request').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Draft could not be saved'));
    expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.journal).toHaveLength(1);
  });
  it('preserves a legacy ticket locator as unresolved until its source is chosen explicitly', async () => {
    const f = fixture(); const routeState = { version: 1, value: { legacyTicket: 'OLD-42' } };
    f.context = { ...f.context, state: { ...f.state, routeState, savedState: saveValue({ selectedRepo: null, drafts: [{ repo, draft: { ...emptyDraft(), task: 'Retained instructions' } }] }) } };
    const instance = await panel.mount(f.container, f.context); await ready(f);
    expect(f.container.textContent).toContain('Linked task: OLD-42'); expect(field(f.container, 'Task instructions').value).toBe('Retained instructions');
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    button(f.container, 'Choose source for linked task').click(); await ready(f);
    expect(field(f.container, 'Launch mode').value).toBe('source'); expect(field(f.container, 'Task key').value).toBe('OLD-42');
    expect(field(f.container, 'Task source').value).toBe(''); expect(field(f.container, 'Task').value).toBe(''); expect(f.lookup).not.toHaveBeenCalled();
    await instance.refresh?.(); expect(f.container.textContent).toContain('Linked task: OLD-42'); expect(f.submit).not.toHaveBeenCalled();
    edit(f.container, 'Launch mode', 'freeform'); expect(field(f.container, 'Task instructions').value).toBe('Retained instructions');
  });
});

it.each(['missing', 'newer', 'unsupported'] as const)('does not create a launch from a stale delivery row when original request is %s', async scenario => {
  const f = fixture(); const entry = f.reserve({ version: 1, repo, action: 'launch', launch: { mode: 'freeform', task: 'Original task' } });
  if (scenario === 'unsupported') delete f.context.services.runCommands!.retry;
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(button(f.container, 'Check request').disabled).toBe(false));
  edit(f.container, 'Task instructions', 'New unsent task');
  if (scenario === 'unsupported') {
    expect(button(f.container, 'Retry delivery').disabled).toBe(true); button(f.container, 'Retry delivery').click(); expect(f.retry).not.toHaveBeenCalled();
    button(f.container, 'Check request').click(); await vi.waitFor(() => expect(f.receipt).toHaveBeenCalledOnce());
  } else {
    f.journal.splice(0);
    if (scenario === 'newer') f.journal.push({ command: { ...entry.command, requestId: '00000000-0000-4000-8000-000000000002' }, receipt: null });
    const preserved = structuredClone(f.journal);
    button(f.container, 'Retry delivery').click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: entry.command.requestId }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.container.textContent).toContain('Launch outcome is unconfirmed')); expect(f.journal).toEqual(preserved);
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled(); expect(field(f.container, 'Task instructions').value).toBe('New unsent task');
});

describe('New Run keyboard focus through redraws', () => {
  it.each(['Save draft', 'Refresh'])('retains %s focus through asynchronous refresh', async label => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    const result = await f.discover(); let complete!: (value: typeof result) => void;
    f.discover.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const refreshed = instance.refresh?.(); await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    button(f.container, label).focus(); complete(result); await refreshed;
    expect(document.activeElement).toBe(button(f.container, label));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps focus on explicit galleon selection while its scope changes', async () => {
    const f = fixture(); const state = { ...f.state, repo: null, activity: { ...f.state.activity, repo: null } };
    await panel.mount(f.container, { ...f.context, state });
    await vi.waitFor(() => expect((field(f.container, 'Galleon') as HTMLSelectElement).options.length).toBe(3));
    field(f.container, 'Galleon').focus(); edit(f.container, 'Galleon', otherRepo); await ready(f);
    expect(document.activeElement).toBe(field(f.container, 'Galleon'));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('preserves launch focus when its wording changes', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    button(f.container, 'Start run').focus(); await instance.update({ ...f.state, pirateMode: true });
    expect(document.activeElement).toBe(button(f.container, 'Weigh anchor')); expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps a recovery action on its original request when requests reorder', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    f.reserve({ version: 1, repo, action: 'launch', launch: { mode: 'freeform', task: 'First task' } });
    f.reserve({ version: 1, repo, action: 'launch', launch: { mode: 'freeform', task: 'Second task' } });
    await instance.refresh?.();
    const requestId = f.journal[1]!.command.requestId;
    const selector = `[data-request-id="${requestId}"]`;
    button(f.container.querySelector<HTMLElement>(selector)!, 'Retry delivery').focus();
    f.journal.reverse(); await instance.refresh?.();
    expect(document.activeElement).toBe(button(f.container.querySelector<HTMLElement>(selector)!, 'Retry delivery'));
    f.journal.splice(0, 1); await instance.refresh?.();
    expect(document.activeElement).toBe(button(f.container, 'Refresh'));
    expect(f.retry).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('falls back to Refresh when a focused action becomes unavailable', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    button(f.container, 'Start run').focus();
    f.reserve({ version: 1, repo, action: 'launch', launch: { mode: 'freeform', task: 'Pending task' } });
    await instance.refresh?.();
    expect(button(f.container, 'Start run').disabled).toBe(true);
    expect(document.activeElement).toBe(button(f.container, 'Refresh')); expect(f.submit).not.toHaveBeenCalled();
  });
  it('does not reclaim focus moved outside New Run during refresh', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f);
    const result = await f.discover(); let complete!: (value: typeof result) => void;
    f.discover.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    button(f.container, 'Save draft').focus(); const refreshed = instance.refresh?.();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    complete(result); await refreshed; expect(document.activeElement).toBe(outside); expect(f.submit).not.toHaveBeenCalled();
  });
});
