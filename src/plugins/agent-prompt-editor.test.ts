import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAgentPromptEditorV1 } from './agent-prompt-editor';
import type { AgentPromptSettingsSnapshotV1 } from './agent-prompts';
import { DraftStorage } from './agent-prompt-editor-state';

const controllers: AbortController[] = [];
const snapshot: AgentPromptSettingsSnapshotV1 = { version: 1, revision: 'a'.repeat(64), roles: [
  { id: 'coding.implement', label: 'Implementation', description: 'Build a change', providerLabel: 'Coding', defaultText: 'Implement instructions', text: 'Implement instructions', overridden: false },
  { id: 'coding.review', label: 'Review', description: 'Review a change', providerLabel: 'Coding', defaultText: 'Review instructions', text: 'Review instructions', overridden: false },
] };
beforeEach(() => localStorage.clear());
afterEach(() => { controllers.splice(0).forEach(controller => controller.abort()); document.body.replaceChildren(); });
async function fixture(roleId: string) {
  const lifetime = new AbortController(); controllers.push(lifetime);
  const container = document.createElement('div'); document.body.append(container);
  const service = { version: 1 as const, snapshot: vi.fn(async () => ({ status: 'available' as const, value: snapshot })), save: vi.fn(async () => ({ status: 'available' as const, value: snapshot })) };
  const editor = createAgentPromptEditorV1(container, { service, signal: lifetime.signal, contributionId: 'overview/page', instanceId: 'role-editor', fixedRoleId: roleId,
    state: { active: true, pirateMode: false, signal: lifetime.signal } });
  await vi.waitFor(() => expect(container.querySelector('[data-status]')?.textContent).not.toContain('Loading'));
  return { container, service, editor, lifetime };
}
it('fixes the requested role over saved selection and ignores picker changes', async () => {
  new DraftStorage('overview/page', 'role-editor').save({ version: 1, selectedRole: 'coding.implement', drafts: { 'coding.review': { revision: snapshot.revision, text: 'Saved review draft' } } });
  const f = await fixture('coding.review');
  const picker = f.container.querySelector<HTMLSelectElement>('[data-role]')!;
  expect(picker.closest('label')?.hidden).toBe(true);
  expect(f.container.querySelector<HTMLTextAreaElement>('[data-text]')?.value).toBe('Saved review draft');
  picker.value = 'coding.implement'; picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(f.container.querySelector<HTMLTextAreaElement>('[data-text]')?.value).toBe('Saved review draft');
});
it('keeps a missing role unavailable and blocks every prompt mutation', async () => {
  const f = await fixture('coding.missing');
  expect(f.container.querySelector('[data-status]')?.textContent).toContain('This agent role is unavailable');
  expect(f.container.querySelector<HTMLTextAreaElement>('[data-text]')?.disabled).toBe(true);
  for (const name of ['save', 'restore', 'discard', 'rebase']) {
    const button = f.container.querySelector<HTMLButtonElement>(`[data-${name}]`)!;
    expect(button.disabled).toBe(true); button.click();
  }
  expect(f.service.save).not.toHaveBeenCalled();
});
it('cancels inactive editors and resumes snapshot reads when reactivated', async () => {
  const f = await fixture('coding.review');
  f.editor.update({ active: false, pirateMode: true, signal: f.lifetime.signal });
  expect(f.container.querySelector<HTMLTextAreaElement>('[data-text]')?.disabled).toBe(true);
  expect(f.container.querySelector('[data-repos-label]')?.textContent).toBe('galleons');
  await f.editor.refresh(); expect(f.service.snapshot).toHaveBeenCalledOnce();
  f.editor.update({ active: true, pirateMode: true, signal: f.lifetime.signal });
  await vi.waitFor(() => expect(f.service.snapshot).toHaveBeenCalledTimes(2));
  f.lifetime.abort(); expect(f.container.childElementCount).toBe(0);
});
