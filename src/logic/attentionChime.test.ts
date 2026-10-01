import { afterEach, expect, it, vi } from 'vitest';
import { AttentionChime } from './attentionChime';
afterEach(() => vi.unstubAllGlobals());
it('waits for interaction and fences delayed resume before starting a quiet short tone', async () => {
  let resume!: () => void; let allowed = true; const start = vi.fn(); const stop = vi.fn(); const gain = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  const context = { state: 'running', currentTime: 5, destination: {}, resume: vi.fn(async () => { await new Promise<void>(done => { resume = done; }); context.state = 'running'; }), close: vi.fn(async () => {}),
    createGain: vi.fn(() => ({ gain, connect() {}, disconnect() {} })), createOscillator: vi.fn(() => ({ frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start, stop })) };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  const chime = new AttentionChime(); expect(await chime.play(() => true)).toBe(false); expect(start).not.toHaveBeenCalled();
  await chime.unlock(); context.state = 'suspended'; const pending = chime.play(() => allowed); allowed = false; resume(); expect(await pending).toBe(false); expect(start).not.toHaveBeenCalled();
  allowed = true; expect(await chime.play(() => allowed)).toBe(true); expect(start).toHaveBeenCalledWith(5); expect(stop).toHaveBeenCalledWith(5.3);
  expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.045, 5.025); chime.dispose(); expect(context.close).toHaveBeenCalledOnce(); expect(chime.ready).toBe(false);
});
