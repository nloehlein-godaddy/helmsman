import { afterEach, expect, it, vi } from 'vitest';
import type { PluginPanelState, WhiteboardServiceV1, WhiteboardSnapshotV1 } from '@helmsman/plugin-sdk';
import { WhiteboardCompanion } from './whiteboard';

const instances: WhiteboardCompanion[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); vi.useRealTimers(); document.body.replaceChildren(); });
const target = { kind: 'run' as const, repo: 'org/a', runId: 'run-1', expectedAttempt: 2 };
const state: PluginPanelState = { repo: 'org/a', themeId: 'default', pirateMode: false, visible: true, pane: null, instanceId: 'viewer', savedState: null,
  activity: { epoch: 1, repo: 'org/a', active: true, signal: new AbortController().signal } };
const snapshot = (status: WhiteboardSnapshotV1['status']): WhiteboardSnapshotV1 => ({ version: 1, target, status, sessionId: null, baseSha: null, headSha: null, message: null });
const available = (value: WhiteboardSnapshotV1) => ({ status: 'available' as const, value });
function mount(service?: WhiteboardServiceV1) {
  const instance = new WhiteboardCompanion(service); instances.push(instance); document.body.append(instance.element); instance.update(state, target);
  return { instance, button: instance.element.querySelector('button')! };
}

it('reports an unavailable installation without pretending an explanation exists', () => {
  const f = mount(); expect(f.button.textContent).toBe('Explain in Whiteboard'); expect(f.button.disabled).toBe(true);
  expect(f.instance.element.textContent).toContain('Whiteboard is not available.');
});

it('shows creation until the read service confirms a ready session', async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => available(snapshot('creating'))).mockResolvedValueOnce(available(snapshot('creating'))).mockResolvedValueOnce(available(snapshot('ready')));
  const f = mount({ version: 1, read, explain: vi.fn(), open: vi.fn() });
  await vi.advanceTimersByTimeAsync(0); expect(f.button.disabled).toBe(true); expect(f.instance.element.textContent).toContain('being created');
  await vi.advanceTimersByTimeAsync(2000); expect(f.button.textContent).toBe('Open in Whiteboard'); expect(f.button.disabled).toBe(false);
});

it('blocks retries when creation outcome is unknown', async () => {
  const explain = vi.fn(async () => ({ status: 'unavailable' as const, code: 0, message: 'Creation outcome is unknown. Check Recovery.' }));
  const f = mount({ version: 1, read: vi.fn(async () => available(snapshot('absent'))), explain, open: vi.fn() });
  await vi.waitFor(() => expect(f.button.disabled).toBe(false)); f.button.click();
  await vi.waitFor(() => expect(f.instance.element.textContent).toContain('Creation outcome is unknown.'));
  expect(f.button.textContent).toBe('Check Whiteboard status'); expect(f.button.disabled).toBe(false); f.button.click(); expect(explain).toHaveBeenCalledTimes(1);
});

it('reports failures and disables recovery-required explanations', async () => {
  const f = mount({ version: 1, read: vi.fn(async () => available(snapshot('failed'))), explain: vi.fn(async () => available(snapshot('recovery-required'))), open: vi.fn() });
  await vi.waitFor(() => expect(f.instance.element.textContent).toContain('failed. Try again.')); expect(f.button.disabled).toBe(false);
  f.button.click(); await vi.waitFor(() => expect(f.instance.element.textContent).toContain('Recovery is required')); expect(f.button.disabled).toBe(true);
});
