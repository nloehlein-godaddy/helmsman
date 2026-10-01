import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHostPageServices } from './host-services';
import { PageAttentionHost } from './page-attention-host';
import type { AttentionAudio } from '../logic/attentionChime';
import type { PluginPageAttentionV1, PluginPageModule } from './sdk';

const hosts: PageAttentionHost[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { hosts.splice(0).forEach(host => host.dispose()); vi.useRealTimers(); });
function fixture() {
  let unlocked = false; let rings = 0;
  const audio: AttentionAudio = { get ready() { return unlocked; }, unlock: vi.fn(async () => { unlocked = true; }), play: vi.fn(async current => { if (!unlocked || !current()) return false; rings++; return true; }), stop: vi.fn(), dispose: vi.fn() };
  let snapshot: PluginPageAttentionV1 | null = { version: 1, keys: ['question-a'] };
  const module: PluginPageModule = { mount: vi.fn(), attention: vi.fn(async () => snapshot) };
  const changed = vi.fn(); const host = new PageAttentionHost(changed, { audio, services: () => createHostPageServices(new AbortController().signal) }); hosts.push(host);
  const selection = { id: 'example.questions/page', module, repo: 'org/a', selected: false };
  host.update(selection);
  return { host, audio, module, selection, changed, rings: () => rings, snapshot: (value: PluginPageAttentionV1 | null) => { snapshot = value; } };
}
it('highlights pending off-tab, revalidates on unlock and chimes once per newly observed batch', async () => {
  const f = fixture(); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(true); expect(f.rings()).toBe(0);
  await f.host.unlock(); expect(f.rings()).toBe(1);
  await vi.advanceTimersByTimeAsync(15_000); expect(f.rings()).toBe(1);
  f.snapshot({ version: 1, keys: ['question-a', 'question-b', 'question-c'] }); await f.host.refresh(); expect(f.rings()).toBe(2);
  f.host.update({ ...f.selection, selected: true }); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(false);
  f.snapshot({ version: 1, keys: ['question-a', 'question-d'] }); await f.host.refresh(); expect(f.rings()).toBe(2);
  f.host.update(f.selection); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(true); expect(f.rings()).toBe(2);
  f.snapshot({ version: 1, keys: [] }); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(false);
});
it('drops stale deferred audio after resolution, a visit, scope change, or failed fresh observation', async () => {
  const f = fixture(); await f.host.refresh();
  f.snapshot({ version: 1, keys: [] }); await f.host.unlock(); expect(f.rings()).toBe(0);
  f.snapshot({ version: 1, keys: ['question-b'] }); await f.host.refresh(); expect(f.rings()).toBe(1);
  vi.mocked(f.module.attention!).mockRejectedValueOnce(new Error('Unavailable')); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(false);
  await f.host.refresh(); expect(f.rings()).toBe(1);
  f.host.update({ ...f.selection, repo: 'org/b' }); f.snapshot({ version: 1, keys: ['other-scope'] }); await f.host.refresh(); expect(f.rings()).toBe(2);
  f.host.update({ ...f.selection, selected: true }); await f.host.refresh(); expect(f.rings()).toBe(2);
});
it('does not replay an initial batch after visiting before audio unlock', async () => {
  const f = fixture(); await f.host.refresh(); f.host.update({ ...f.selection, selected: true }); await f.host.refresh();
  f.host.update(f.selection); await f.host.unlock(); expect(f.rings()).toBe(0); expect(f.changed).toHaveBeenLastCalledWith(true);
});
it('aborts replaced reads, rejects late scoped results and clears when the selected contribution disappears', async () => {
  const f = fixture(); let resolve!: (value: PluginPageAttentionV1) => void;
  vi.mocked(f.module.attention!).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = f.host.refresh(); const signal = vi.mocked(f.module.attention!).mock.calls.at(-1)![0].signal;
  f.host.update({ ...f.selection, repo: 'org/b' }); f.snapshot({ version: 1, keys: [] }); await f.host.refresh();
  expect(signal.aborted).toBe(true); resolve({ version: 1, keys: ['late'] }); await pending; expect(f.changed).toHaveBeenLastCalledWith(false);
  f.host.update(null); const calls = vi.mocked(f.module.attention!).mock.calls.length; await vi.advanceTimersByTimeAsync(20_000);
  expect(f.module.attention).toHaveBeenCalledTimes(calls); expect(f.audio.stop).toHaveBeenCalled();
});
it('continues polling while an audio resume is pending and fences its eventual sound after navigation', async () => {
  const f = fixture(); let resume!: () => void; let attempted = false;
  vi.mocked(f.audio.play).mockImplementation(async current => { await new Promise<void>(done => { resume = done; }); attempted = current(); return attempted; });
  await f.host.refresh(); const calls = vi.mocked(f.module.attention!).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000); expect(vi.mocked(f.module.attention!).mock.calls.length).toBeGreaterThan(calls);
  f.host.update({ ...f.selection, selected: true }); resume(); await Promise.resolve(); expect(attempted).toBe(false);
});
it('rejects malformed attention results and supports modules without the optional hook', async () => {
  const f = fixture(); vi.mocked(f.module.attention!).mockResolvedValue({ version: 1, keys: ['duplicate', 'duplicate'] }); await f.host.refresh();
  expect(f.changed).toHaveBeenLastCalledWith(false); expect(f.rings()).toBe(0);
  f.host.update({ ...f.selection, module: { mount: vi.fn() } }); await f.host.refresh(); expect(f.changed).toHaveBeenLastCalledWith(false);
  f.host.dispose(); expect(f.audio.dispose).toHaveBeenCalledOnce();
});

it('revalidates unheard initial questions after an outage and does not refetch on every unlocked gesture', async () => {
  const f = fixture(); await f.host.refresh();
  vi.mocked(f.module.attention!).mockRejectedValueOnce(new Error('Temporary outage')); await f.host.refresh();
  await f.host.unlock(); expect(f.rings()).toBe(1);
  const calls = vi.mocked(f.module.attention!).mock.calls.length;
  await f.host.unlock(); await f.host.unlock(); expect(f.module.attention).toHaveBeenCalledTimes(calls);
});
