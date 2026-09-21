// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/plugin-download/worker.js', import.meta.url), 'utf8');
class Port {
  readonly messages: { type: string; sequence?: number }[] = []; closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(value: { type: string; sequence?: number }) { this.messages.push(value); }
  close() { this.closed = true; }
  start() {}
  receive(value: unknown) { this.onmessage?.({ data: value }); }
}
function fixture() {
  const handlers = new Map<string, (event: unknown) => void>();
  runInNewContext(source, { self: { location: { origin: 'https://helmsman.test' }, addEventListener(name: string, callback: (event: unknown) => void) { handlers.set(name, callback); } },
    URL, Response, ReadableStream, Uint8Array, ArrayBuffer, setTimeout, clearTimeout });
  const register = (token = 'a'.repeat(64), overrides: Record<string, unknown> = {}, origin = 'https://helmsman.test') => {
    const port = new Port(); handlers.get('message')?.({ data: { version: 1, type: 'register', token, filename: 'run.log', contentType: 'text/plain; charset=utf-8', ...overrides }, ports: [port], source: { id: 'client', url: origin } }); return port;
  };
  const fetch = (token = 'a'.repeat(64), method = 'GET'): Promise<Response> => {
    const result: { response: Response | null } = { response: null };
    handlers.get('fetch')?.({ request: new Request(`https://helmsman.test/plugin-download/file/${token}`, { method }), respondWith(value: Response) { result.response = value; }, waitUntil() {} });
    if (!result.response) throw new Error('No response'); return Promise.resolve(result.response);
  };
  return { register, fetch };
}
afterEach(() => vi.useRealTimers());

describe('scoped download worker protocol', () => {
  it('rejects malformed metadata and foreign registration origins', () => {
    const f = fixture(); const invalid = f.register(undefined, { filename: '../outside' }); expect(invalid.messages).toEqual([{ type: 'error' }]); expect(invalid.closed).toBe(true);
    const foreign = f.register(undefined, {}, 'https://foreign.test'); expect(foreign.messages).toEqual([{ type: 'error' }]); expect(foreign.closed).toBe(true);
  });
  it('consumes a token once and stops its response when the originating host aborts', async () => {
    const f = fixture(); const port = f.register(); const first = await f.fetch(); expect((await f.fetch()).status).toBe(410);
    const rebound = f.register(); expect(rebound.messages).toEqual([{ type: 'error' }]); expect(rebound.closed).toBe(true);
    const reader = first.body!.getReader(); const pending = reader.read(); port.receive({ type: 'abort' }); await expect(pending).rejects.toThrow('cancelled'); expect(port.closed).toBe(true);
  });
  it.each([{ type: 'chunk', sequence: 2, chunk: new ArrayBuffer(1) }, { type: 'chunk', sequence: 1, chunk: new ArrayBuffer(65537) }])('fails invalid sequence or oversized producer responses', async response => {
    const f = fixture(); const port = f.register(); const reader = (await f.fetch()).body!.getReader(); const pending = reader.read(); await Promise.resolve();
    expect(port.messages.at(-1)).toEqual({ type: 'pull', sequence: 1 }); port.receive(response); await expect(pending).rejects.toThrow(); expect(port.closed).toBe(true);
  });
  it('propagates native consumer cancellation back to the producer', async () => {
    const f = fixture(); const port = f.register(); const reader = (await f.fetch()).body!.getReader(); await reader.cancel();
    expect(port.messages.at(-1)).toEqual({ type: 'cancelled' }); expect(port.closed).toBe(true);
  });
  it('expires unopened tokens and releases client quotas', async () => {
    vi.useFakeTimers(); const f = fixture(); const ports = ['a', 'b', 'c', 'd'].map(value => f.register(value.repeat(64)));
    expect(f.register('e'.repeat(64)).messages).toEqual([{ type: 'error' }]); await vi.advanceTimersByTimeAsync(10001);
    expect(ports.every(port => port.closed)).toBe(true); expect((await f.fetch()).status).toBe(410);
    const next = f.register('e'.repeat(64)); expect(next.messages).toEqual([{ type: 'ready' }]); next.receive({ type: 'abort' });
  });
  it('errors an active stream when its host heartbeat disappears', async () => {
    vi.useFakeTimers(); const f = fixture(); const port = f.register(); const reader = (await f.fetch()).body!.getReader(); const pending = reader.read(); const failure = expect(pending).rejects.toThrow('host is unavailable');
    port.receive({ type: 'heartbeat' }); await vi.advanceTimersByTimeAsync(15001); await failure; expect(port.closed).toBe(true);
  });
});
