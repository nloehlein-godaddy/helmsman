import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, RunCommandPendingV1, RunCommandServiceV1, SourceCommandPendingV1, SourceCommandServiceV1, TaskEditEnvelopeV1, TaskEditListItemV1, TaskEditServiceV1, TaskEditSourceV1, TodoLegacyRecoveryServiceV1 } from '@helmsman/plugin-sdk';
import panel from './panel';

const repo = 'owner/project'; const otherRepo = 'owner/other';
const source: TaskEditSourceV1 = { selection: { version: 1, sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'local', instanceRevision: 2, repo }, label: 'Local tasks', availability: 'available',
  editors: [{ id: 'helmsman/local-task-editor', version: 1, commands: { create: 'add', update: 'edit', delete: 'remove' } }] };
const fields = { title: 'Existing Todo', repo, description: 'Original description', acceptanceCriteria: 'Expected result', priority: 'P2', state: 'todo' };
const task: TaskEditListItemV1 = { version: 1, ref: { sourceId: source.selection.sourceId, externalId: 'TODO-1' }, revision: 'record-1', repo, displayKey: 'TODO-1', title: fields.title, state: 'ready', priority: 2, url: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  requirements: { description: fields.description, acceptanceCriteria: [fields.acceptanceCriteria], links: [] } };
const envelope = (create = false): TaskEditEnvelopeV1 => ({ version: 1, selection: source.selection, sourceRevision: 3, editor: { id: 'helmsman/local-task-editor', version: 1 },
  target: create ? null : { ref: task.ref, revision: task.revision }, value: create ? { ...fields, title: '', description: '', acceptanceCriteria: '' } : { ...fields }, destinationRepos: [repo, otherRepo], relatedRun: null,
  commands: { create: create ? { commandId: 'add', available: true, reason: null } : null, update: create ? null : { commandId: 'edit', available: true, reason: null }, delete: create ? null : { commandId: 'remove', available: true, reason: null } } });
const lifetimes: AbortController[] = [];
afterEach(() => { for (const controller of lifetimes.splice(0)) controller.abort(); document.body.replaceChildren(); });
function fixture() {
  const lifetime = new AbortController(); lifetimes.push(lifetime); const activity = new AbortController();
  const container = document.createElement('div'); document.body.append(container);
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'todos-one', savedState: null, activity: { epoch: 1, repo, active: true, signal: activity.signal } };
  const discover = vi.fn<TaskEditServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, sources: [source] } }));
  const list = vi.fn<TaskEditServiceV1['list']>(async input => ({ status: 'available', value: { selection: input.selection, items: [task], nextCursor: null, total: 1 } }));
  const create = vi.fn<TaskEditServiceV1['create']>(async input => ({ status: 'available', value: { ...envelope(true), selection: input.selection, value: { ...fields, title: '', description: '', acceptanceCriteria: '', repo: input.selection.repo } } }));
  const load = vi.fn<TaskEditServiceV1['load']>(async () => ({ status: 'available', value: envelope() }));
  const journal: SourceCommandPendingV1[] = [];
  const submit = vi.fn<SourceCommandServiceV1['submit']>(async input => {
    const command = { ...input, requestId: '22222222-2222-4222-8222-222222222222' }; const { input: _input, ...identity } = command;
    const receipt = { ...identity, status: 'succeeded' as const, result: input.action === 'delete' ? { kind: 'deleted' as const, ref: task.ref, repo, previousRevision: 'record-1' }
      : { kind: 'changed' as const, ref: task.ref, repo: input.destinationRepo!, revision: 'record-2' }, message: null };
    journal.splice(0, journal.length, { command, receipt }); return { status: 'available', value: receipt };
  });
  const pending = vi.fn<SourceCommandServiceV1['pending']>(async () => [...journal]);
  const receipt = vi.fn<SourceCommandServiceV1['receipt']>(async () => ({ status: 'available', value: journal[0]?.receipt ?? null }));
  const acknowledge = vi.fn<SourceCommandServiceV1['acknowledge']>(async () => { journal.splice(0); });
  const saveState = vi.fn<PluginPanelContext['saveState']>(async () => {});
  const setScope = vi.fn<NonNullable<PluginPanelContext['setScope']>>(async () => {});
  const runJournal: RunCommandPendingV1[] = [];
  const runSubmit = vi.fn<RunCommandServiceV1['submit']>(async input => {
    const command = { ...input, requestId: '33333333-3333-4333-8333-333333333333' };
    const receipt = { version: 1 as const, action: input.action, repo: input.repo, requestId: command.requestId, status: 'accepted' as const, runId: 'run-one', attempt: 1, message: null };
    runJournal.splice(0, runJournal.length, { command, receipt }); return { status: 'available', value: receipt };
  });
  const runAcknowledge = vi.fn<RunCommandServiceV1['acknowledge']>(async () => { runJournal.splice(0); });
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), saveState, setScope,
    services: { version: 1, taskEdit: { version: 1, discover, list, create, load }, sourceCommands: { version: 1, submit, pending, receipt, acknowledge },
      runCommands: { version: 1, submit: runSubmit, pending: vi.fn(async () => [...runJournal]), receipt: vi.fn<RunCommandServiceV1['receipt']>(async () => ({ status: 'available', value: runJournal[0]?.receipt ?? null })), acknowledge: runAcknowledge } } };
  return { container, lifetime, activity, state, context, discover, list, create, load, journal, submit, pending, receipt, acknowledge, saveState, setScope, runJournal, runSubmit, runAcknowledge };
}
function button(container: HTMLElement, label: string) { const value = [...container.querySelectorAll('button')].find(value => value.textContent === label || value.firstChild?.textContent === label); if (!value) throw new Error(`Missing ${label}: ${container.textContent}`); return value; }
function field(container: HTMLElement, label: string) { const value = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[aria-label]')].find(value => value.getAttribute('aria-label') === label); if (!value) throw new Error(`Missing ${label}`); return value; }
function edit(container: HTMLElement, label: string, value: string) { const control = field(container, label); control.value = value; control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }
async function ready(f: ReturnType<typeof fixture>) { await vi.waitFor(() => expect(f.container.textContent).toContain(fields.title)); }
async function open(f: ReturnType<typeof fixture>) { await ready(f); button(f.container, fields.title).click(); await vi.waitFor(() => expect(field(f.container, 'Title').value).toBe(fields.title)); }

describe('authored Todo editor', () => {
  it('discovers editor contracts instead of provider IDs and keeps focused dirty form through refresh', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f);
    edit(f.container, 'Description', 'Unsent text'); const description = field(f.container, 'Description') as HTMLTextAreaElement; description.focus(); description.setSelectionRange(3, 6);
    await instance.refresh?.();
    expect(field(f.container, 'Description')).toBe(description); expect(description.value).toBe('Unsent text'); expect(document.activeElement).toBe(description); expect(description.selectionStart).toBe(3);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('persists original input before sending and consumes canonical identity before acknowledging', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await ready(f); button(f.container, 'New Todo').click();
    await vi.waitFor(() => expect(field(f.container, 'Title').value).toBe(''));
    edit(f.container, 'Title', 'Create this'); button(f.container, 'Create Todo').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const submitted = f.submit.mock.calls[0]![0]; expect(submitted).toMatchObject({ action: 'create', commandId: 'add', selection: source.selection, input: { title: 'Create this' } });
    expect(f.saveState.mock.invocationCallOrder[0]).toBeLessThan(f.submit.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Apply saved result'));
    edit(f.container, 'Title', 'Newer text'); button(f.container, 'Apply saved result').click();
    await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalledOnce());
    const consumed = f.saveState.mock.calls.map(call => call[0]?.value).find(value => JSON.stringify(value).includes('record-2'));
    expect(consumed).toMatchObject({ drafts: [{ target: { revision: 'record-2' }, values: { title: 'Newer text' }, submitted: null }] });
    expect(field(f.container, 'Title').value).toBe('Newer text');
  });
  it('pins edits to the origin when the header changes and offers an explicit panel scope override', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f); edit(f.container, 'Title', 'Keep editing');
    const controller = new AbortController(); f.activity.abort();
    await instance.update({ ...f.state, repo: otherRepo, activity: { epoch: 2, repo: otherRepo, active: true, signal: controller.signal } });
    expect(field(f.container, 'Title').value).toBe('Keep editing'); expect(button(f.container, 'Save Todo').disabled).toBe(true);
    button(f.container, `Use ${repo} for this panel`).click(); await vi.waitFor(() => expect(f.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo }));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('moves existing Todos using origin selection and an explicit destination in the immutable command', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f); edit(f.container, 'Destination repository', otherRepo); button(f.container, 'Save Todo').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ selection: source.selection, destinationRepo: otherRepo, target: { ref: task.ref, expectedRevision: 'record-1' }, input: { repo: otherRepo } });
    expect(f.setScope).not.toHaveBeenCalled();
  });
  it('lets an unspecified new destination follow the header after text is drafted', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f); button(f.container, 'New Todo').click();
    await vi.waitFor(() => expect(field(f.container, 'Title').value).toBe('')); edit(f.container, 'Title', 'Draft follows header');
    f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: otherRepo, sources: [{ ...source, selection: { ...source.selection, repo: otherRepo } }] } });
    const controller = new AbortController(); f.activity.abort();
    await instance.update({ ...f.state, repo: otherRepo, activity: { epoch: 2, repo: otherRepo, active: true, signal: controller.signal } });
    await vi.waitFor(() => expect(field(f.container, 'Destination repository').textContent).toContain(`Follow header (${otherRepo})`));
    expect(field(f.container, 'Title').value).toBe('Draft follows header');
    button(f.container, 'Create Todo').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ selection: { repo: otherRepo }, destinationRepo: otherRepo, input: { title: 'Draft follows header', repo: otherRepo } });
  });
  it('requires a successful explicit scope change before creating at another destination', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await ready(f); button(f.container, 'New Todo').click();
    await vi.waitFor(() => expect(field(f.container, 'Title').value).toBe('')); edit(f.container, 'Title', 'Fixed destination');
    const controller = new AbortController();
    f.setScope.mockImplementation(async () => {
      f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: otherRepo, sources: [{ ...source, selection: { ...source.selection, repo: otherRepo } }] } });
      f.activity.abort(); await instance.update({ ...f.state, repo: otherRepo, activity: { epoch: 2, repo: otherRepo, active: true, signal: controller.signal } });
    });
    edit(f.container, 'Destination repository', otherRepo); await vi.waitFor(() => expect(f.setScope).toHaveBeenCalledWith({ kind: 'galleon', repo: otherRepo }));
    await vi.waitFor(() => expect(button(f.container, 'Create Todo').disabled).toBe(false)); button(f.container, 'Create Todo').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); expect(f.submit.mock.calls[0]![0]).toMatchObject({ selection: { repo: otherRepo }, input: { title: 'Fixed destination' } });
  });
  it('requires specific deletion confirmation and retains uncertain request identity', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f);
    f.submit.mockImplementation(async input => { f.journal.push({ command: { ...input, requestId: '22222222-2222-4222-8222-222222222222' }, receipt: null }); return { status: 'unavailable', reason: 'connection-failed' }; });
    button(f.container, 'Delete Todo').click(); expect(f.submit).not.toHaveBeenCalled(); expect(f.container.textContent).toContain(`Delete TODO-1: ${fields.title}?`);
    button(f.container, 'Confirm deletion').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.container.textContent).toContain('Retry delivery'));
    expect(button(f.container, 'Save Todo').disabled).toBe(true); button(f.container, 'Retry delivery').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2)); expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]); expect(f.acknowledge).not.toHaveBeenCalled();
  });
  it('keeps stale revisions for explicit reconciliation and blocks active claim edits', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f); edit(f.container, 'Description', 'My draft');
    f.load.mockResolvedValue({ status: 'available', value: { ...envelope(), target: { ref: task.ref, revision: 'record-2' } } });
    await instance.refresh?.(); expect(button(f.container, 'Save Todo').disabled).toBe(true); expect(field(f.container, 'Description').value).toBe('My draft');
    button(f.container, 'Reconcile with current revision').click(); await vi.waitFor(() => expect(button(f.container, 'Save Todo').disabled).toBe(false));
    f.load.mockResolvedValue({ status: 'available', value: { ...envelope(), target: { ref: task.ref, revision: 'record-2' }, commands: { create: null, update: { commandId: 'edit', available: false, reason: 'Owned by a running worker.' }, delete: null } } });
    await instance.refresh?.(); expect(button(f.container, 'Save Todo').disabled).toBe(true); expect(field(f.container, 'Title').disabled).toBe(true); expect(f.container.textContent).toContain('Owned by a running worker.');
  });
  it('preserves unknown saved state without issuing editor reads or overwriting it', async () => {
    const f = fixture(); await panel.mount(f.container, { ...f.context, state: { ...f.state, savedState: { version: 99, value: { draft: 'Future fields' } } } });
    expect(f.container.textContent).toContain('unsupported format'); expect(f.discover).not.toHaveBeenCalled(); expect(f.saveState).not.toHaveBeenCalled();
  });
  it('keeps terminal results until their draft transition can be saved', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f); button(f.container, 'Save Todo').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Apply saved result')); f.saveState.mockRejectedValue(new Error('Storage full'));
    button(f.container, 'Apply saved result').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Drafts could not be saved'));
    expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.journal).toHaveLength(1);
  });
  it('launches only canonical saved described Todos and retains the receipt through later editing', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f);
    expect(button(f.container, 'Start run').disabled).toBe(false);
    edit(f.container, 'Title', 'Unsaved edit'); expect(button(f.container, 'Start run').disabled).toBe(true);
    edit(f.container, 'Title', fields.title); button(f.container, 'Start run').click();
    await vi.waitFor(() => expect(f.runSubmit).toHaveBeenCalledOnce());
    expect(f.runSubmit.mock.calls[0]![0]).toEqual({ version: 1, action: 'launch', repo, launch: { mode: 'source', workRef: task.ref, sourceInstanceId: source.selection.instanceId, sourceInstanceRevision: source.selection.instanceRevision } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Dismiss launch request'));
    edit(f.container, 'Description', 'Draft after launch'); button(f.container, 'Dismiss launch request').click();
    await vi.waitFor(() => expect(f.runAcknowledge).toHaveBeenCalledOnce()); expect(field(f.container, 'Description').value).toBe('Draft after launch');
    expect(f.container.querySelector('a[href*="run=run-one"]')).toBeNull();
  });
  it('uses source-owned related run identity and does not launch a stale or claimed Todo', async () => {
    const f = fixture(); f.load.mockResolvedValue({ status: 'available', value: { ...envelope(), relatedRun: { repo, runId: 'previous-run' } } });
    await panel.mount(f.container, f.context); await open(f);
    expect(f.container.querySelector('a')?.getAttribute('href')).toBe('/runs?repo=owner%2Fproject&run=previous-run');
    f.load.mockResolvedValue({ status: 'available', value: { ...envelope(), target: { ref: task.ref, revision: 'new-revision' } } });
    button(f.container, 'Start run').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Reconcile the current source and task revision'));
    expect(f.runSubmit).not.toHaveBeenCalled();
  });
  it('sends search to the provider before pagination while preserving the search control and editor', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f);
    edit(f.container, 'Description', 'Unsent draft'); const description = field(f.container, 'Description');
    const search = field(f.container, 'Search Todos'); edit(f.container, 'Search Todos', 'Criteria beyond first page');
    await vi.waitFor(() => expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { state: null, search: 'Criteria beyond first page' }, cursor: null }), expect.any(AbortSignal)));
    expect(field(f.container, 'Search Todos')).toBe(search); expect(field(f.container, 'Description')).toBe(description); expect(description.value).toBe('Unsent draft');
    edit(f.container, 'Todo state filter', 'todo');
    await vi.waitFor(() => expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { state: 'todo', search: 'Criteria beyond first page' } }), expect.any(AbortSignal)));
  });
  it('opens Recovery in the saved command’s scope', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f);
    f.submit.mockImplementation(async input => {
      const command = { ...input, requestId: '22222222-2222-4222-8222-222222222222' }; const { input: _input, ...identity } = command;
      const receipt = { ...identity, status: 'recovery-required' as const, result: null, message: 'Review the original operation.' };
      f.journal.push({ command, receipt }); return { status: 'available', value: receipt };
    });
    button(f.container, 'Save Todo').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Open Recovery'));
    button(f.container, 'Open Recovery').click(); expect(f.context.navigate).toHaveBeenCalledWith('/recovery?repo=owner%2Fproject');
  });
  it('reconciles untouched server fields while preserving dirty text after a worker releases a task', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f);
    edit(f.container, 'Description', 'Keep my local description');
    f.load.mockResolvedValue({ status: 'available', value: { ...envelope(), target: { ref: task.ref, revision: 'record-2' }, value: { ...fields, title: 'Changed by source', state: 'done' } } });
    await instance.refresh?.(); button(f.container, 'Reconcile with current revision').click();
    await vi.waitFor(() => expect(field(f.container, 'Title').value).toBe('Changed by source'));
    expect(field(f.container, 'State').value).toBe('done'); expect(field(f.container, 'Description').value).toBe('Keep my local description'); expect(button(f.container, 'Save Todo').disabled).toBe(false);
  });
  it('aggregates all scoped sources by priority and real creation age and edits the row’s exact origin', async () => {
    const f = fixture(); const other = { ...source, selection: { ...source.selection, repo: otherRepo } };
    f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: null, sources: [source, other] } });
    f.list.mockImplementation(async input => ({ status: 'available', value: { selection: input.selection, total: 1, nextCursor: null,
      items: input.selection.repo === repo ? [{ ...task, title: 'Newer task', createdAt: '2026-03-01T00:00:00Z' }] : [{ ...task, title: 'Older task', repo: otherRepo, ref: { ...task.ref, externalId: 'TODO-999' }, createdAt: '2025-03-01T00:00:00Z' }] } }));
    f.load.mockImplementation(async input => ({ status: 'available', value: { ...envelope(), selection: input.selection, target: { ref: input.ref, revision: 'record-1' }, value: { ...fields, repo: input.selection.repo } } }));
    await panel.mount(f.container, { ...f.context, state: { ...f.state, repo: null, activity: { ...f.state.activity, repo: null } } });
    await vi.waitFor(() => expect(f.container.querySelectorAll('.todo-row')).toHaveLength(2));
    expect([...f.container.querySelectorAll('.todo-row')].map(row => row.firstChild?.textContent)).toEqual(['Older task', 'Newer task']);
    expect(f.container.textContent).toContain('2 of 2 matching Todos loaded'); expect(button(f.container, 'New Todo').disabled).toBe(true);
    button(f.container, 'Older task').click(); await vi.waitFor(() => expect(f.load).toHaveBeenCalled());
    expect(f.load).toHaveBeenLastCalledWith(expect.objectContaining({ selection: other.selection, ref: { ...task.ref, externalId: 'TODO-999' } }), expect.any(AbortSignal));
  });
  it('retains independent cursors and unavailable-source counts during All-source pagination', async () => {
    const f = fixture(); const other = { ...source, selection: { ...source.selection, repo: otherRepo } };
    f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo: null, sources: [source, other] } });
    f.list.mockImplementation(async input => input.selection.repo === otherRepo ? { status: 'unavailable', reason: 'source-unavailable' }
      : { status: 'available', value: { selection: input.selection, total: 2, nextCursor: input.cursor ? null : 'first-source-next',
        items: [{ ...task, title: input.cursor ? 'Second page task' : fields.title, ref: { ...task.ref, externalId: input.cursor ? 'TODO-2' : 'TODO-1' } }] } });
    await panel.mount(f.container, { ...f.context, state: { ...f.state, repo: null, activity: { ...f.state.activity, repo: null } } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Its count is unknown'));
    expect(f.container.textContent).not.toContain('of 2 matching'); button(f.container, 'Load more Todos').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Second page task'));
    expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({ selection: source.selection, cursor: 'first-source-next' }), expect.any(AbortSignal));
    expect(f.container.querySelectorAll('.todo-row')).toHaveLength(2); expect(f.container.textContent).toContain('Its count is unknown');
  });
  it('requires explicit All scope before inspecting older requests', async () => {
    const f = fixture(); const pending = vi.fn<TodoLegacyRecoveryServiceV1['pending']>(async () => ({ status: 'unavailable', reason: 'all-galleons-required' }));
    const check = vi.fn<TodoLegacyRecoveryServiceV1['check']>();
    await panel.mount(f.container, { ...f.context, services: { ...f.context.services, todoLegacyRecovery: { version: 1, pending, check, acknowledge: vi.fn() } } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Older Todo requests require an explicit All scope'));
    expect(f.setScope).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
    button(f.container, 'Use All repositories to inspect older requests').click(); await vi.waitFor(() => expect(f.setScope).toHaveBeenCalledWith({ kind: 'all' }));
  });
  it('keeps unresolved older requests and saves current drafts before explicit terminal dismissal', async () => {
    const f = fixture(); const requestId = '44444444-4444-4444-8444-444444444444';
    const pending = vi.fn<TodoLegacyRecoveryServiceV1['pending']>(async () => ({ status: 'available', value: [{ requestId, commandId: 'update', externalId: 'TODO-1' }] }));
    const check = vi.fn<TodoLegacyRecoveryServiceV1['check']>(async () => ({ status: 'available', value: { version: 1, requestId, commandId: 'update', repo: null, status: 'unrecorded', reason: 'not-recorded', message: null, result: null } }));
    const acknowledge = vi.fn<TodoLegacyRecoveryServiceV1['acknowledge']>(async () => ({ status: 'available', value: undefined }));
    await panel.mount(f.container, { ...f.context, services: { ...f.context.services, todoLegacyRecovery: { version: 1, pending, check, acknowledge } } });
    await open(f); edit(f.container, 'Description', 'Keep current draft'); button(f.container, 'Check original request').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('unrecorded'));
    expect([...f.container.querySelectorAll('button')].some(button => button.textContent === 'Dismiss confirmed older request')).toBe(false);
    check.mockResolvedValue({ status: 'available', value: { version: 1, requestId, commandId: 'update', repo, status: 'succeeded', reason: null, message: null,
      result: { kind: 'changed', ref: task.ref, repo, revision: 'record-2' } } });
    button(f.container, 'Check original request').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Dismiss confirmed older request'));
    f.saveState.mockRejectedValue(new Error('Storage full')); button(f.container, 'Dismiss confirmed older request').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Drafts could not be saved')); expect(acknowledge).not.toHaveBeenCalled();
    f.saveState.mockResolvedValue(); button(f.container, 'Dismiss confirmed older request').click();
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith(requestId, expect.any(AbortSignal)));
    expect(field(f.container, 'Description').value).toBe('Keep current draft'); expect(f.submit).not.toHaveBeenCalled();
  });
});
