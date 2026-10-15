import { afterEach, expect, it, vi } from 'vitest';
import type { PluginPanelState, RunInstructionPendingV1, RunInstructionServiceV1, RunInstructionSnapshotV1 } from '@helmsman/plugin-sdk';
import { RunInstructions } from './instructions';

const widgets: RunInstructions[] = [];
afterEach(() => { widgets.splice(0).forEach(widget => widget.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const query = { version: 1 as const, repo: 'org/repo', runId: 'run-1', expectedAttempt: 2 };
const snapshot: RunInstructionSnapshotV1 = { ...query, channelId: '00000000-0000-4000-8000-000000000001', available: true, reason: null,
  targets: [{ id: '00000000-0000-4000-8000-000000000002', provider: 'Retained agent', stage: 'review' }] };
const available = <T>(value: T) => ({ status: 'available' as const, value });
function setup(options: { snapshot?: RunInstructionSnapshotV1; pending?: RunInstructionPendingV1[] } = {}) {
  const activity = new AbortController();
  const state: PluginPanelState = { repo: query.repo, visible: true, themeId: 'default', pirateMode: false, pane: null, instanceId: 'viewer', savedState: null,
    activity: { repo: query.repo, epoch: 1, active: true, signal: activity.signal } };
  let saved: RunInstructionPendingV1[] = options.pending ?? [];
  const submit = vi.fn<RunInstructionServiceV1['submit']>(async input => {
    const requestId = '00000000-0000-4000-8000-000000000003'; const receipt = { version: 1 as const, input, requestId, status: 'sending' as const, message: null };
    saved = [{ command: { ...input, requestId }, receipt }]; return available(receipt);
  });
  const service: RunInstructionServiceV1 = { version: 1, read: vi.fn<RunInstructionServiceV1['read']>(async () => available(options.snapshot ?? snapshot)), submit,
    pending: async () => saved, receipt: async () => available(saved[0]?.receipt ?? null), retry: vi.fn(), acknowledge: vi.fn() };
  const widget = new RunInstructions(service); widgets.push(widget); document.body.append(widget.element); widget.update(state, query);
  return { widget, service, state, activity, submit };
}
it('sends to the selected attempt and target and blocks a second send until the saved receipt is resolved', async () => {
  const f = setup(); const editor = f.widget.element.querySelector('textarea')!; const send = f.widget.element.querySelector('button')!;
  await vi.waitFor(() => expect(f.widget.element.querySelector('select')?.options.length).toBe(1));
  editor.value = 'Use the existing API'; editor.dispatchEvent(new Event('input')); expect(send.disabled).toBe(false); send.click();
  await vi.waitFor(() => expect(f.widget.element.textContent).toContain('sending'));
  expect(f.submit).toHaveBeenCalledWith({ ...query, expectedChannelId: snapshot.channelId, targetId: snapshot.targets[0]!.id, text: 'Use the existing API' }, expect.any(AbortSignal));
  editor.value = 'Another instruction'; editor.dispatchEvent(new Event('input')); expect(send.disabled).toBe(true);
});
const instructionRequest: RunInstructionPendingV1 = {
  command: { ...query, requestId: '00000000-0000-4000-8000-000000000004', expectedChannelId: snapshot.channelId!, targetId: snapshot.targets[0]!.id, text: '  Preserve <customer> content exactly.\n' },
  receipt: null,
};
it('hides the empty form when there is no active agent and shows the exact service reason', async () => {
  const f = setup({ snapshot: { ...snapshot, available: false, targets: [], reason: 'This execution has changed. Refresh the run.' } });
  await vi.waitFor(() => expect(f.widget.element.querySelector('.instruction-status')?.textContent).toBe('This execution has changed. Refresh the run.'));
  expect(f.widget.element.querySelector('h3')?.textContent).toBe('Live instructions');
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-form')?.hidden).toBe(true);
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-agent')?.hidden).toBe(true);
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-send')?.hidden).toBe(true);
  expect(f.submit).not.toHaveBeenCalled();
});
it('preserves the exact unsent draft and receipts when a channel becomes unavailable', async () => {
  const f = setup({ pending: [instructionRequest] }); const editor = f.widget.element.querySelector('textarea')!;
  await vi.waitFor(() => expect(f.widget.element.querySelector('select')?.options.length).toBe(1));
  const text = '  Keep <raw> user content.\n  Preserve indentation.  '; editor.value = text; editor.dispatchEvent(new Event('input'));
  vi.mocked(f.service.read).mockResolvedValueOnce(available({ ...snapshot, available: false, targets: [], reason: 'Waiting for an agent that can receive instructions.' }));
  [...f.widget.element.querySelectorAll('button')].find(button => button.textContent === 'Check delivery')!.click();
  await vi.waitFor(() => expect(f.widget.element.querySelector('.instruction-status')?.textContent).toBe('Waiting for an agent that can receive instructions.'));
  expect(f.widget.element.querySelector('textarea')).toBe(editor); expect(editor.value).toBe(text);
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-editor')?.hidden).toBe(false);
  expect(f.widget.element.querySelector('.instruction-editor>span')?.textContent).toBe('Saved draft');
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-agent')?.hidden).toBe(true);
  expect(f.widget.element.querySelector<HTMLElement>('.instruction-send')?.hidden).toBe(true);
  const receipt = f.widget.element.querySelector('[data-instruction-request]')!;
  expect(receipt.querySelector('p')?.textContent).toBe(instructionRequest.command.text);
  expect(receipt.querySelector('customer')).toBeNull(); expect(receipt.textContent).toContain('Recover saved request');
  expect(f.submit).not.toHaveBeenCalled();
});
it('keeps active form controls stable through receipt refreshes and submits the original text', async () => {
  const f = setup({ pending: [{ ...instructionRequest, command: { ...instructionRequest.command, expectedAttempt: 1 } }] });
  const editor = f.widget.element.querySelector('textarea')!; const target = f.widget.element.querySelector('select')!;
  await vi.waitFor(() => expect(target.options.length).toBe(1));
  const text = '  Keep exact spacing.\n'; editor.value = text; editor.dispatchEvent(new Event('input')); editor.focus();
  [...f.widget.element.querySelectorAll('button')].find(button => button.textContent === 'Check delivery')!.click();
  await vi.waitFor(() => expect(f.service.read).toHaveBeenCalledTimes(2));
  expect(f.widget.element.querySelector('textarea')).toBe(editor); expect(f.widget.element.querySelector('select')).toBe(target);
  expect(document.activeElement).toBe(editor); expect(editor.value).toBe(text);
  f.widget.element.querySelector<HTMLButtonElement>('.instruction-send')!.click();
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ text }), expect.any(AbortSignal));
});
it('discards delayed observations after changing scope and retains unsent drafts per attempt', async () => {
  const f = setup(); const editor = f.widget.element.querySelector('textarea')!;
  editor.value = 'Draft for this run';
  f.widget.update({ ...f.state, visible: false }, query); expect(f.widget.element.hidden).toBe(true);
  f.widget.update(f.state, query); expect(editor.value).toBe('Draft for this run');
  f.activity.abort(); expect((f.service.read as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].aborted).toBe(true);
});
