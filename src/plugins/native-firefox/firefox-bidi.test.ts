import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectFirefoxBidi } from './firefox-bidi';

class FakeWebSocket extends EventTarget {
  static latest: FakeWebSocket | null = null;
  constructor(_url: string) { super(); FakeWebSocket.latest = this; }
  send(_value: string) {}
  close() {}
}

afterEach(() => { vi.unstubAllGlobals(); FakeWebSocket.latest = null; });

describe('Firefox BiDi client', () => {
  it('keeps an established session alive after its setup signal expires', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const controller = new AbortController(); const pending = connectFirefoxBidi('ws://127.0.0.1:9222/session', controller.signal);
    FakeWebSocket.latest!.dispatchEvent(new Event('open'));
    const client = await pending;
    controller.abort();
    expect(client.closed).toBe(false);
    client.close();
  });

  it('rejects oversized protocol frames before parsing them', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const pending = connectFirefoxBidi('ws://127.0.0.1:9222/session'); FakeWebSocket.latest!.dispatchEvent(new Event('open'));
    const client = await pending;
    const request = client.request('browsingContext.getTree', {});
    FakeWebSocket.latest!.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(4 * 1024 * 1024 + 1) }));
    await expect(request).rejects.toThrow('disconnected');
    expect(client.closed).toBe(true);
  });

  it('rejects a matched BiDi error response instead of leaving its request pending', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const pending = connectFirefoxBidi('ws://127.0.0.1:9222/session'); FakeWebSocket.latest!.dispatchEvent(new Event('open'));
    const client = await pending;
    const request = client.request('browsingContext.getTree', {});
    FakeWebSocket.latest!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, type: 'error', error: 'no such frame', message: 'gone' }) }));
    await expect(request).rejects.toThrow('disconnected');
    expect(client.closed).toBe(true);
  });
});
