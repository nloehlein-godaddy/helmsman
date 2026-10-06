import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, SourceAdminPendingV1, SourceAdminServiceV1, SourceAdminSnapshotV1, SourceAdminSourceV1 } from '@helmsman/plugin-sdk';
import panel, { reconcileConfiguration } from './panel';
import automatic from './automatic';
import { configuration, consumeResult, emptyState, rawValues, readState, saveValue } from './state';
const repo = 'org/a';
const source: SourceAdminSourceV1 = { target: { sourceId: '11111111-1111-4111-8111-111111111111', sourceRevision: 1, instanceId: 'local', instanceRevision: 1 }, label: 'Local', providerId: 'example.tasks/provider', identityLevel: 'stable', current: true, available: true, desiredEnabled: true, allowedRepos: [repo], settingsFields: { flag: { label: 'Flag', schema: { type: 'boolean', default: true } }, statuses: { label: 'Statuses', schema: { type: 'string-list', default: ['Todo'], maxItems: 10, maxLength: 100 } } }, settings: {}, replacements: [{ mode: 'refresh', providerId: 'example.tasks/provider', artifactHash: 'a'.repeat(64) }] };
const controllers: AbortController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.abort(); document.body.replaceChildren(); });
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController(); controllers.push(lifetime, activity);
  const container = document.createElement('div'); document.body.append(container);
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'settings', savedState: null, activity: { epoch: 1, repo, active: true, signal: activity.signal } };
  let current: SourceAdminSnapshotV1 = { version: 1, repo, repos: [repo], sources: [structuredClone(source)], schedules: [{ repo, revision: 0, instanceIds: [] }], runtimes: [{ repo, epoch: '22222222-2222-4222-8222-222222222222', revision: 0, enabled: false }] };
  const journal: SourceAdminPendingV1[] = [];
  const snapshot = vi.fn<SourceAdminServiceV1['snapshot']>(async () => ({ status: 'available', value: current }));
  const submit = vi.fn<SourceAdminServiceV1['submit']>(async input => { journal.splice(0, journal.length, { command: { ...input, requestId: '33333333-3333-4333-8333-333333333333' }, receipt: null }); return { status: 'unavailable', reason: 'connection-failed' }; });
  const retry = vi.fn<NonNullable<SourceAdminServiceV1['retry']>>(async query => {
    const entry = journal.find(value => value.command.repo === query.repo && value.command.requestId === query.requestId);
    return entry?.receipt ? { status: 'available', value: entry.receipt } : { status: 'unavailable', reason: entry ? 'connection-failed' : 'not-found' };
  });
  const pending = vi.fn<SourceAdminServiceV1['pending']>(async () => [...journal]);
  const receipt = vi.fn<SourceAdminServiceV1['receipt']>(async () => ({ status: 'available', value: journal[0]?.receipt ?? null }));
  const acknowledge = vi.fn<SourceAdminServiceV1['acknowledge']>(async () => { journal.splice(0); });
  const validateReplacement = vi.fn<SourceAdminServiceV1['validateReplacement']>(async input => ({ status: 'available', value: { ...input, validationId: '44444444-4444-4444-8444-444444444444', instanceId: 'next', evidenceHash: 'b'.repeat(64) } }));
  const saveState = vi.fn<PluginPanelContext['saveState']>(async () => {});
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), saveState, navigate: vi.fn(), setScope: vi.fn(), services: { version: 1, sourceAdmin: { version: 1, snapshot, submit, retry, pending, receipt, acknowledge, validateReplacement } } };
  return { container, state, context, activity, journal, snapshot, submit, retry, pending, receipt, acknowledge, validateReplacement, saveState, setSnapshot(value: SourceAdminSnapshotV1) { current = value; }, current: () => current };
}
function button(f: ReturnType<typeof fixture>, label: string) { const value = [...f.container.querySelectorAll('button')].find(item => item.textContent === label); if (!value) throw new Error(`Missing ${label}: ${f.container.textContent}`); return value; }
function field(f: ReturnType<typeof fixture>, label: string) { const value = [...f.container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[aria-label]')].find(item => item.getAttribute('aria-label') === label); if (!value) throw new Error(`Missing ${label}`); return value; }
function edit(f: ReturnType<typeof fixture>, label: string, value: string) { const input = field(f, label); input.value = value; input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }
async function ready(f: ReturnType<typeof fixture>) { await vi.waitFor(() => expect(button(f, 'Enable automatic starts').disabled).toBe(false)); }
async function open(f: ReturnType<typeof fixture>) { await ready(f); edit(f, 'Source instance', 'local'); }

describe('source settings authored state', () => {
  it('preserves omitted provider defaults and validates explicit JSON field edits', () => {
    const values = rawValues(source); const draft = { target: source.target, values, baseline: structuredClone(values) };
    expect(configuration(draft, source).settings).toEqual({});
    draft.values.fields.statuses = '["Ready\\nnow"]'; expect(configuration(draft, source).settings).toEqual({ statuses: ['Ready\nnow'] });
    draft.values.fields.statuses = '[42]'; expect(() => configuration(draft, source)).toThrow('Statuses');
  });
  it('merges untouched fields from a newer revision and retains dirty values including explicit removals', () => {
    const original = { ...source, settings: { flag: false, statuses: ['Old'] } }; const baseline = rawValues(original); const values = structuredClone(baseline); values.label = 'Unsent'; delete values.fields.flag;
    const merged = reconcileConfiguration({ target: source.target, values, baseline }, { ...source, target: { ...source.target, instanceRevision: 2 }, label: 'Server', settings: { flag: true, statuses: ['New'] } });
    expect(merged.values.label).toBe('Unsent'); expect(merged.values.fields).toEqual({ statuses: '[\n  "New"\n]' }); expect(merged.target.instanceRevision).toBe(2);
  });
  it('rejects unknown state versions and keeps receipt consumption idempotent without losing newer input', () => {
    expect(readState({ version: 2, value: {} })).toBeNull(); const saved = emptyState(); const baseline = rawValues(source); saved.configurations.push({ target: source.target, baseline, values: { ...baseline, label: 'Newer' } });
    const input = { version: 1 as const, kind: 'configure' as const, repo, target: source.target, changes: { label: 'Submitted', desiredEnabled: true, allowedRepos: [repo], settings: {} } }; const requestId = '33333333-3333-4333-8333-333333333333';
    const entry: SourceAdminPendingV1 = { command: { ...input, requestId }, receipt: { version: 1, requestId, input, status: 'succeeded', result: { kind: 'configured', target: { ...source.target, instanceRevision: 2 } }, message: null } };
    const next = consumeResult(saved, entry); expect(next.configurations[0]?.values.label).toBe('Newer'); expect(next.configurations[0]?.baseline.label).toBe('Submitted'); expect(consumeResult(next, entry)).toBe(next); expect(readState(saveValue(next))).toEqual(next);
  });
});
describe('source settings authored panel', () => {
  it('persists a configuration before sending and retries only the original intent after edits', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f); edit(f, 'Source label', 'Original submission'); button(f, 'Apply source configuration').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); await vi.waitFor(() => expect(button(f, 'Retry original settings request').disabled).toBe(false));
    expect(f.saveState.mock.invocationCallOrder[0]).toBeLessThan(f.submit.mock.invocationCallOrder[0]!);
    edit(f, 'Source label', 'Newer draft'); button(f, 'Retry original settings request').click(); await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId: f.journal[0]?.command.requestId }, expect.any(AbortSignal))); expect(f.submit).toHaveBeenCalledOnce(); expect(field(f, 'Source label').value).toBe('Newer draft');
  });
  it('does not acknowledge outcomes if saving the consumed state fails', async () => {
    const f = fixture(); const input = { version: 1 as const, kind: 'runtime' as const, repo, epoch: f.current().runtimes[0]!.epoch, expectedRevision: 0, enabled: true }; const requestId = '33333333-3333-4333-8333-333333333333';
    f.journal.push({ command: { ...input, requestId }, receipt: { version: 1, requestId, input, status: 'expired', result: null, message: 'Old process' } });
    await panel.mount(f.container, f.context); await vi.waitFor(() => expect(button(f, 'Accept outcome and dismiss').disabled).toBe(false)); f.saveState.mockRejectedValue(new Error('offline')); button(f, 'Accept outcome and dismiss').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Drafts could not be saved')); expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('shows draft retry only after an asynchronous save failure and emphasizes live save actions', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f);
    const retry = button(f, 'Retry saving drafts'); expect(retry.hidden).toBe(true); expect(f.container.textContent).toContain('saved as drafts automatically');
    expect(button(f, 'Apply source configuration').classList.contains('primary-action')).toBe(true);
    expect(button(f, 'Save automatic source selection').classList.contains('primary-action')).toBe(true);
    f.saveState.mockRejectedValueOnce(new Error('offline')); edit(f, 'Source label', 'Retained edit');
    await vi.waitFor(() => expect(retry.hidden).toBe(false)); expect(f.container.textContent).toContain('Drafts could not be saved');
    let hidden = retry.hidden; Object.defineProperty(retry, 'hidden', { configurable: true, get: () => hidden, set: value => { if (value && document.activeElement === retry) retry.blur(); hidden = value; } });
    retry.focus(); retry.click(); await vi.waitFor(() => expect(retry.hidden).toBe(true));
    expect(document.activeElement).toBe(button(f, 'Refresh source settings'));
  });
  it('shows historical enabled receipts separately from current disabled runtime and never reenables automatically', async () => {
    const f = fixture(); const input = { version: 1 as const, kind: 'runtime' as const, repo, epoch: '55555555-5555-4555-8555-555555555555', expectedRevision: 0, enabled: true }; const requestId = '33333333-3333-4333-8333-333333333333';
    f.journal.push({ command: { ...input, requestId }, receipt: { version: 1, requestId, input, status: 'succeeded', result: { kind: 'runtime', runtime: { repo, epoch: input.epoch, revision: 1, enabled: true } }, message: null } });
    await automatic.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain('historical receipt')); expect(f.container.textContent).toContain('Current process automatic starts: disabled'); expect(button(f, 'Enable automatic starts').disabled).toBe(true); expect(f.submit).not.toHaveBeenCalled();
  });
  it('pins validated replacement evidence and invalidates it as soon as actor text changes', async () => {
    const f = fixture(); await panel.mount(f.container, f.context); await open(f); edit(f, 'Replacement candidate', JSON.stringify(source.replacements[0])); edit(f, 'Replacement actor', 'operator'); edit(f, 'Replacement reason', 'upgrade'); button(f, 'Validate replacement').click();
    await vi.waitFor(() => expect(button(f, 'Apply validated replacement').disabled).toBe(false)); expect(f.validateReplacement.mock.calls[0]?.[0]).toMatchObject({ target: source.target, artifactHash: 'a'.repeat(64) });
    edit(f, 'Replacement actor', 'another'); button(f, 'Apply validated replacement').click(); await Promise.resolve(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('preserves focused unsent configuration and its caret through refresh', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f); edit(f, 'Source label', 'Unsent label'); const input = field(f, 'Source label') as HTMLInputElement; input.focus(); input.setSelectionRange(2, 6);
    await instance.refresh?.(); const refreshed = field(f, 'Source label') as HTMLInputElement; expect(refreshed.value).toBe('Unsent label'); expect(document.activeElement).toBe(refreshed); expect(refreshed.selectionStart).toBe(2); expect(refreshed.selectionEnd).toBe(6);
  });
  it('keeps replacement text across revision refresh and requires explicit reconciliation', async () => {
    const f = fixture(); const instance = await panel.mount(f.container, f.context); await open(f); edit(f, 'Replacement actor', 'Keep actor'); edit(f, 'Replacement reason', 'Keep reason');
    f.setSnapshot({ ...f.current(), sources: [{ ...source, target: { ...source.target, instanceRevision: 2 } }] }); await instance.refresh?.();
    expect(field(f, 'Replacement actor').value).toBe('Keep actor'); expect(field(f, 'Replacement reason').value).toBe('Keep reason'); expect(button(f, 'Validate replacement').disabled).toBe(true);
    button(f, 'Reconcile replacement draft').click(); expect(field(f, 'Replacement actor').value).toBe('Keep actor');
  });
  it('prunes acknowledged receipt markers before their bounded history can block saves', async () => {
    const f = fixture(); const saved = emptyState(); saved.consumed = Array.from({ length: 1000 }, (_, index) => `old-${index}`);
    await panel.mount(f.container, { ...f.context, state: { ...f.state, savedState: saveValue(saved) } }); await ready(f);
    await vi.waitFor(() => expect(f.saveState).toHaveBeenCalled()); expect(f.saveState.mock.calls.at(-1)?.[0]).toMatchObject({ value: { consumed: [] } });
  });
  it('lets operators remove saved source selections no longer visible in discovery', async () => {
    const f = fixture(); f.setSnapshot({ ...f.current(), schedules: [{ repo, revision: 1, instanceIds: ['retired'] }] }); await automatic.mount(f.container, f.context); await ready(f);
    const checkbox = field(f, 'Unavailable scheduled source retired') as HTMLInputElement; checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true })); button(f, 'Save automatic source selection').click();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ kind: 'schedule', expectedRevision: 1, instanceIds: [] });
  });
  it('keeps changed values from removed schemas visible until explicitly discarded', async () => {
    const f = fixture(); const saved = emptyState(); const baseline = rawValues(source); saved.selected = source.target.instanceId; saved.configurations.push({ target: source.target, baseline, values: { ...baseline, fields: { obsolete: 'Keep this text' } } });
    await panel.mount(f.container, { ...f.context, state: { ...f.state, savedState: saveValue(saved) } }); await ready(f); expect(f.container.textContent).toContain('Keep this text');
    button(f, 'Discard unsupported setting draft obsolete').click(); button(f, 'Apply source configuration').click(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()); expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ changes: { settings: {} } });
  });
  it('never overwrites unsupported saved state', async () => {
    const f = fixture(); await panel.mount(f.container, { ...f.context, state: { ...f.state, savedState: { version: 2, value: { future: true } } } }); expect(f.container.textContent).toContain('unsupported'); expect(f.snapshot).not.toHaveBeenCalled(); expect(f.saveState).not.toHaveBeenCalled();
  });
});

it.each([['configuration', panel], ['automatic', automatic]] as const)('%s retry never recreates a peer-acknowledged request or changes a newer reservation', async (_name, module) => {
  const f = fixture(); const input = { version: 1 as const, kind: 'runtime' as const, repo, epoch: f.current().runtimes[0]!.epoch, expectedRevision: 0, enabled: true };
  const requestId = '33333333-3333-4333-8333-333333333333'; f.journal.push({ command: { ...input, requestId }, receipt: null });
  await module.mount(f.container, f.context); await vi.waitFor(() => expect(button(f, 'Retry original settings request').disabled).toBe(false));
  const next = { command: { ...input, requestId: '55555555-5555-4555-8555-555555555555', enabled: false }, receipt: null };
  f.journal.splice(0, f.journal.length, next); button(f, 'Retry original settings request').click();
  await vi.waitFor(() => expect(f.retry).toHaveBeenCalledWith({ repo, requestId }, expect.any(AbortSignal)));
  await vi.waitFor(() => expect(f.container.textContent).toContain('Original request unavailable: not-found'));
  expect(f.journal).toEqual([next]); expect(f.submit).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled();
});
it('keeps source settings receipt checks available when exact retry is absent', async () => {
  const f = fixture(); delete f.context.services.sourceAdmin!.retry;
  f.journal.push({ command: { version: 1, kind: 'runtime', repo, epoch: f.current().runtimes[0]!.epoch, expectedRevision: 0, enabled: true, requestId: '33333333-3333-4333-8333-333333333333' }, receipt: null });
  await panel.mount(f.container, f.context); await vi.waitFor(() => expect(button(f, 'Check saved request').disabled).toBe(false));
  expect(button(f, 'Retry original settings request').disabled).toBe(true); button(f, 'Retry original settings request').click(); expect(f.submit).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled();
});
