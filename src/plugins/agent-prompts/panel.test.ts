import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentPromptSettingsSaveV1, AgentPromptSettingsSnapshotV1, PluginPanelContext, PluginPanelState } from '@helmsman/plugin-sdk';
import panel from './panel';
const available = <T>(value: T) => ({ status: 'available' as const, value });
const snapshot: AgentPromptSettingsSnapshotV1 = { version: 1, revision: 'a'.repeat(64), roles: [
  { id: 'coding.implement', label: 'Implementation', description: 'Build the requested change', providerLabel: 'Coding workflow', defaultText: 'Built-in implementation', text: 'Built-in implementation', overridden: false },
  { id: 'review.pull-request', label: 'PR review', description: 'Review a pull request', providerLabel: 'Review workflow', defaultText: 'Built-in review', text: 'Custom review', overridden: true },
] };
const lifetimes: AbortController[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => { lifetimes.splice(0).forEach(controller => controller.abort()); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function fixture(expectReady = true) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime);
  const state: PluginPanelState = { repo: 'org/b', headerRepo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'editor', savedState: null, activity: { epoch: 1, signal: new AbortController().signal, active: true, repo: 'org/b' } };
  const service = { version: 1 as const, snapshot: vi.fn(async () => available(snapshot)), save: vi.fn(async (input: AgentPromptSettingsSaveV1): Promise<ReturnType<typeof available<AgentPromptSettingsSnapshotV1>>> => available({ ...snapshot, revision: 'b'.repeat(64), roles: snapshot.roles.map(role => role.id === input.roleId ? { ...role, overridden: input.text !== null, text: input.text ?? role.defaultText } : role) })) };
  const context: PluginPanelContext = { contributionId: 'helmsman.agent-prompts/panel', state, activity: state.activity, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), saveState: vi.fn(async () => {}), services: { version: 1, agentPrompts: service } };
  const instance = (await panel.mount(container, context))!; await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('[data-text]')?.disabled).toBe(!expectReady));
  return { container, instance, service, state, lifetime, context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (f: Fixture) => f.container.querySelector<HTMLTextAreaElement>('[data-text]')!;
const click = (f: Fixture, selector: string) => f.container.querySelector<HTMLButtonElement>(selector)!.click();
function edit(f: Fixture, text: string) { input(f).value = text; input(f).dispatchEvent(new Event('input', { bubbles: true })); }
function choose(f: Fixture, role: string) { const select = f.container.querySelector<HTMLSelectElement>('[data-role]')!; select.value = role; select.dispatchEvent(new Event('change', { bubbles: true })); }
it('shows actual role defaults, provider, global scope, and preserves header scope', async () => {
  const f = await fixture(); expect(input(f).value).toBe('Built-in implementation'); expect(f.container.textContent).toContain('Coding workflow'); expect(f.container.textContent).toContain('Global defaults');
  choose(f, 'review.pull-request'); expect(input(f).value).toBe('Custom review'); expect(f.container.querySelector('[data-default]')?.textContent).toBe('Built-in review'); expect(f.container.querySelector('[data-source]')?.textContent).toBe('Custom prompt'); expect(f.context.navigate).not.toHaveBeenCalled();
});
it('preserves typing focus, selection, per-role drafts and edits through refresh', async () => {
  const f = await fixture(); const textarea = input(f); textarea.focus(); edit(f, 'Draft implementation'); textarea.setSelectionRange(5, 5);
  expect(input(f)).toBe(textarea); expect(document.activeElement).toBe(textarea); expect(textarea.selectionStart).toBe(5);
  choose(f, 'review.pull-request'); edit(f, 'Draft review'); choose(f, 'coding.implement'); expect(input(f).value).toBe('Draft implementation'); await f.instance.refresh?.(); expect(input(f).value).toBe('Draft implementation');
  choose(f, 'review.pull-request'); expect(input(f).value).toBe('Draft review');
});
it('saves only the selected role against its original revision', async () => {
  const f = await fixture(); edit(f, 'New instructions'); click(f, '[data-save]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Prompt saved for new agents'));
  expect(f.service.save).toHaveBeenCalledWith({ version: 1, expectedRevision: snapshot.revision, roleId: 'coding.implement', text: 'New instructions' }, expect.any(AbortSignal)); expect(f.service.save).toHaveBeenCalledOnce();
});
it('stages Restore default and publishes null only through Save', async () => {
  const f = await fixture(); choose(f, 'review.pull-request'); click(f, '[data-restore]'); expect(input(f).value).toBe('Built-in review'); expect(f.service.save).not.toHaveBeenCalled();
  click(f, '[data-save]'); await vi.waitFor(() => expect(f.service.save).toHaveBeenCalledOnce()); expect(f.service.save.mock.calls[0]?.[0].text).toBeNull();
});
it('keeps conflict drafts and requires an explicit rebase before Save', async () => {
  const f = await fixture(); edit(f, 'My draft'); f.service.snapshot.mockResolvedValue(available({ ...snapshot, revision: 'c'.repeat(64) })); await f.instance.refresh?.();
  expect(input(f).value).toBe('My draft'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true);
  const rebase = f.container.querySelector<HTMLButtonElement>('[data-rebase]')!; rebase.focus(); click(f, '[data-rebase]'); expect(f.service.save).not.toHaveBeenCalled(); expect(document.activeElement).toBe(f.container.querySelector('[data-save]'));
  click(f, '[data-save]'); await vi.waitFor(() => expect(f.service.save).toHaveBeenCalledOnce()); expect(f.service.save.mock.calls[0]?.[0].expectedRevision).toBe('c'.repeat(64));
});
it('updates unchanged roles from fresh settings while preserving dirty roles', async () => {
  const f = await fixture(); choose(f, 'review.pull-request'); edit(f, 'Dirty review'); choose(f, 'coding.implement');
  f.service.snapshot.mockResolvedValue(available({ ...snapshot, revision: 'c'.repeat(64), roles: snapshot.roles.map(role => role.id === 'coding.implement' ? { ...role, overridden: true, text: 'New saved implementation' } : role) }));
  await f.instance.refresh?.(); expect(input(f).value).toBe('New saved implementation'); expect(f.container.querySelector('[data-conflict]')?.textContent).toBe('');
  choose(f, 'review.pull-request'); expect(input(f).value).toBe('Dirty review'); expect(f.container.querySelector('[data-conflict]')?.textContent).toContain('changed since');
});
it('preserves unsupported local data and disables the editor', async () => {
  const key = 'helmsman.agent-prompts.v1:helmsman.agent-prompts/panel:editor:draft'; localStorage.setItem(key, '{"version":2}');
  const f = await fixture(false); expect(f.container.textContent).toContain('unsupported format'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true); expect(f.service.save).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe('{"version":2}');
});
it('retains newer typing during an in-flight save without silently rebasing it', async () => {
  const f = await fixture(); let resolve!: (value: ReturnType<typeof available<AgentPromptSettingsSnapshotV1>>) => void;
  f.service.save.mockReturnValue(new Promise(done => { resolve = done; })); edit(f, 'Submitted'); click(f, '[data-save]'); edit(f, 'Newer draft');
  resolve(available({ ...snapshot, revision: 'b'.repeat(64), roles: snapshot.roles.map(role => role.id === 'coding.implement' ? { ...role, overridden: true, text: 'Submitted' } : role) }));
  await vi.waitFor(() => expect(f.container.textContent).toContain('Prompt saved')); expect(input(f).value).toBe('Newer draft'); expect(f.container.querySelector('[data-conflict]')?.textContent).toContain('changed since');
});
it('preserves drafts after a failed save and does not automatically retry', async () => {
  const f = await fixture(); f.service.save.mockRejectedValue(new Error('Offline')); edit(f, 'Kept draft'); click(f, '[data-save]'); await vi.waitFor(() => expect(f.container.textContent).toContain('Offline'));
  expect(input(f).value).toBe('Kept draft'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true); expect(f.service.save).toHaveBeenCalledOnce(); await f.instance.refresh?.(); expect(input(f).value).toBe('Kept draft'); expect(f.service.save).toHaveBeenCalledOnce();
});
it('blocks mutations on storage failure and keeps the editor available', async () => {
  const f = await fixture(); const original = Storage.prototype.setItem; const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  edit(f, 'Kept locally'); expect(input(f).value).toBe('Kept locally'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true); click(f, '[data-save]'); expect(f.service.save).not.toHaveBeenCalled();
  spy.mockImplementation(original); click(f, '[data-save-draft]'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(false);
});
it('blocks empty and oversized UTF8 instructions with recoverable feedback', async () => {
  const f = await fixture(); edit(f, ''); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true); expect(input(f).getAttribute('aria-invalid')).toBe('true');
  edit(f, 'é'.repeat(2049)); expect(f.container.textContent).toContain('4 KiB'); expect(f.service.save).not.toHaveBeenCalled(); edit(f, 'Recovered'); expect(f.container.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(false);
});
it('ignores late reads after disposal and disables inactive mutation attempts', async () => {
  const f = await fixture(); edit(f, 'Draft'); f.instance.update?.({ ...f.state, visible: false }); click(f, '[data-save]'); expect(f.service.save).not.toHaveBeenCalled();
  f.lifetime.abort(); expect(f.container.children).toHaveLength(0);
});
