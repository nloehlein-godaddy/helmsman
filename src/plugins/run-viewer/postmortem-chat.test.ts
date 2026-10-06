import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelState, PostmortemEventV1, PostmortemServiceV1, PostmortemSnapshotV1 } from '@helmsman/plugin-sdk';
import { PostmortemChat, postmortemStatusText } from './postmortem-chat';

const chats: PostmortemChat[] = [];
afterEach(() => { chats.splice(0).forEach(chat => chat.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const SID = '00000000-0000-4000-8000-000000000001';
const target = { repo: 'org/app', runId: 'run-1' };
const session = { id: SID, runId: 'run-1', provider: 'codex' as const, model: null, effort: 'high', status: 'ready' as const, error: null, turns: 1, costUsd: 0.1 };
const snapshot = (patch: Partial<PostmortemSnapshotV1> = {}): PostmortemSnapshotV1 => ({ session, activity: null,
  messages: [{ id: 1, clientId: null, role: 'agent', kind: 'text', text: 'Likely cause: <img src=x> exec SIGKILL', ts: 't' }], patches: [], ...patch });
const available = (value: PostmortemSnapshotV1) => ({ status: 'available' as const, value });
function setup() {
  const activity = new AbortController();
  const state: PluginPanelState = { repo: 'org/app', visible: true, themeId: 'default', pirateMode: false, pane: null, instanceId: 'viewer', savedState: null,
    activity: { repo: 'org/app', epoch: 1, active: true, signal: activity.signal } };
  let listener: ((event: PostmortemEventV1) => void) | undefined;
  const service: PostmortemServiceV1 = { version: 1, start: vi.fn(async () => available(snapshot())), read: vi.fn(async () => available(snapshot())),
    send: vi.fn(async () => available(snapshot({ session: { ...session, status: 'busy' } }))), stop: vi.fn(async () => available(snapshot({ session: { ...session, status: 'idle' } }))),
    watch: vi.fn((_input, next, signal) => { listener = next; return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }) };
  const chat = new PostmortemChat(service); chats.push(chat); document.body.append(chat.element); chat.update(state, target);
  const button = (text: string) => [...chat.element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  const emit = (event: PostmortemEventV1) => listener?.(event);
  return { chat, service, state, activity, button, emit, editor: () => chat.element.querySelector('textarea')! };
}
async function started(f: ReturnType<typeof setup>) {
  f.chat.open(target); f.button('Start post-mortem')!.click();
  await vi.waitFor(() => expect(f.chat.element.textContent).toContain('Likely cause'));
}

describe('post-mortem chat', () => {
  it('stays hidden until opened and starts with the chosen provider, model and effort', async () => {
    const f = setup();
    expect(f.chat.element.hidden).toBe(true);
    f.chat.open(target); expect(f.chat.element.hidden).toBe(false);
    const [provider, model, effort] = [...f.chat.element.querySelectorAll('select')];
    provider!.value = 'claude-code'; provider!.dispatchEvent(new Event('change'));
    expect([...model!.options].map(option => option.value)).toEqual(['', 'opus', 'sonnet']);
    model!.value = 'opus'; expect(effort!.value).toBe('high');
    f.button('Start post-mortem')!.click();
    await vi.waitFor(() => expect(f.service.start).toHaveBeenCalledWith({ repo: 'org/app', runId: 'run-1', provider: 'claude-code', model: 'opus', effort: 'high' }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.chat.element.querySelectorAll('select')).toHaveLength(0));
  });

  it('renders the transcript as inert text and merges streamed messages by id', async () => {
    const f = setup(); await started(f);
    expect(f.chat.element.querySelector('img')).toBeNull();
    f.emit({ type: 'message', message: { id: 1, clientId: null, role: 'agent', kind: 'text', text: 'Likely cause: <img src=x> exec SIGKILL', ts: 't' } });
    f.emit({ type: 'message', message: { id: 2, clientId: null, role: 'agent', kind: 'command', text: '$ ls', ts: 't' } });
    expect(f.chat.element.querySelectorAll('[data-message-id]')).toHaveLength(2);
  });

  it('disables the composer while busy and shows thinking or resuming', async () => {
    const f = setup(); await started(f);
    f.emit({ type: 'status', session: { ...session, status: 'busy' }, activity: 'thinking' });
    expect(f.editor().disabled).toBe(true); expect(f.chat.element.textContent).toContain('thinking…');
    f.emit({ type: 'status', session: { ...session, status: 'busy' }, activity: 'resuming' });
    expect(f.chat.element.textContent).toContain('resuming…');
    f.emit({ type: 'status', session, activity: null });
    expect(f.editor().disabled).toBe(false);
  });

  it('reuses the clientId when a send must be retried', async () => {
    const f = setup(); await started(f);
    vi.mocked(f.service.send).mockResolvedValueOnce({ status: 'unavailable', code: 0, message: 'Post-mortem service is unreachable.' });
    f.editor().value = 'Why?'; f.editor().dispatchEvent(new Event('input')); f.button('Send')!.click();
    await vi.waitFor(() => expect(f.chat.element.querySelector('[role=alert]')?.textContent).toBe('Post-mortem service is unreachable.'));
    f.button('Send')!.click();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
    const ids = vi.mocked(f.service.send).mock.calls.map(call => call[0].clientId);
    expect(ids[0]).toBe(ids[1]);
    await vi.waitFor(() => expect(f.editor().value).toBe(''));
  });

  it('lists patches with badges and copies the apply command', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    const f = setup(); await started(f);
    f.emit({ type: 'patches', patches: [
      { file: '1-target.patch', path: '/p/1-target.patch', repo: 'target', baseSha: 'abc1234def5678', summary: 'Chunk argv', valid: true, reason: null, applyCommand: "git -C '/r' apply '/p/1-target.patch'" },
      { file: '2-helmsman.patch', path: '/p/2-helmsman.patch', repo: 'helmsman', baseSha: null, summary: '', valid: false, reason: 'missing sidecar', applyCommand: null }] });
    expect(f.chat.element.textContent).toContain('valid'); expect(f.chat.element.textContent).toContain('invalid: missing sidecar');
    f.button('Copy git apply')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("git -C '/r' apply '/p/1-target.patch'"));
    f.button('Copy path')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/p/1-target.patch'));
    expect([...f.chat.element.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === 'Copy git apply').map(item => item.disabled)).toEqual([false, true]);
  });

  it('shows capped and error states with a fresh start', async () => {
    const f = setup(); await started(f);
    f.emit({ type: 'status', session: { ...session, status: 'capped' }, activity: null });
    expect(f.editor().disabled).toBe(true); expect(f.chat.element.textContent).toContain('capped');
    f.emit({ type: 'status', session: { ...session, status: 'error', error: 'auth failed' }, activity: null });
    expect(f.editor().disabled).toBe(false); expect(f.chat.element.textContent).toContain('error: auth failed');
    f.button('Start new post-mortem')!.click();
    await vi.waitFor(() => expect(f.service.start).toHaveBeenLastCalledWith({ repo: 'org/app', runId: 'run-1', effort: 'high', fresh: true }, expect.any(AbortSignal)));
  });

  it('reports start failures and stops on request', async () => {
    const f = setup();
    vi.mocked(f.service.start).mockResolvedValueOnce({ status: 'unavailable', code: 412, message: 'Post-mortem sandbox requires macOS' });
    f.chat.open(target); f.button('Start post-mortem')!.click();
    await vi.waitFor(() => expect(f.chat.element.querySelector('[role=alert]')?.textContent).toBe('Post-mortem sandbox requires macOS'));
    f.button('Start post-mortem')!.click(); await vi.waitFor(() => expect(f.button('Stop')?.disabled).toBe(false));
    f.button('Stop')!.click();
    await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledWith({ repo: 'org/app', sessionId: SID }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.chat.element.textContent).toContain('idle'));
  });

  it('resets and aborts the stream when the target or scope changes', async () => {
    const f = setup(); await started(f);
    const signal = vi.mocked(f.service.watch).mock.calls[0]?.[2];
    f.chat.update(f.state, { repo: 'org/app', runId: 'run-2' });
    expect(signal?.aborted).toBe(true); expect(f.chat.element.hidden).toBe(true);
    expect(postmortemStatusText(null)).toBe('');
  });
});
