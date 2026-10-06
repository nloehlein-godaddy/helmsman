/** @vitest-environment node */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePostmortemApi, handlePostmortemEvents } from './routes';
import type { PostmortemEvent, PostmortemRunner, PostmortemSnapshot } from './runner';
import { PostmortemError } from './session-store';

const SID = '00000000-0000-4000-8000-000000000001';
const snapshot = { session: { id: SID, status: 'ready' }, activity: null, messages: [], patches: [] } as unknown as PostmortemSnapshot;
function service(overrides: Partial<PostmortemRunner> = {}) {
  let listener: ((event: PostmortemEvent) => void) | undefined;
  const value = { start: vi.fn(async () => snapshot), read: vi.fn(async () => snapshot), send: vi.fn(async () => snapshot), stop: vi.fn(async () => snapshot),
    subscribe: vi.fn((_id: string, next: (event: PostmortemEvent) => void) => { listener = next; return () => { listener = undefined; }; }),
    isLiveCapability: vi.fn(() => false), dispose: vi.fn(async () => {}), ...overrides } as unknown as PostmortemRunner;
  return { value, emit: (event: PostmortemEvent) => listener?.(event), listening: () => listener !== undefined };
}
const call = (method: string, path: string, body: unknown, value: PostmortemRunner, caller: string | undefined = 'helmsman.run-viewer/panel') =>
  handlePostmortemApi({ method, path, body, caller, service: value });
const failing = (status: number) => vi.fn(async () => { throw new PostmortemError(status, `status ${status}`); });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });

describe('post-mortem routes', () => {
  it('ignores unrelated paths and requires a valid contribution caller', async () => {
    const f = service();
    expect(await call('GET', '/api/runs/abc/feedback-snapshot', null, f.value)).toBeNull();
    expect(await handlePostmortemApi({ method: 'POST', path: '/api/runs/run-1/postmortem', body: null, service: f.value })).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(await handlePostmortemApi({ method: 'GET', path: `/api/postmortem/${SID}`, caller: 'x' })).toMatchObject({ status: 403 });
    expect(await handlePostmortemApi({ method: 'GET', path: `/api/postmortem/${SID}`, caller: 'helmsman.run-viewer/panel' })).toMatchObject({ status: 503 });
  });

  it('rejects malformed contribution ids and callers the authorize hook denies', async () => {
    const f = service();
    expect(await call('GET', `/api/postmortem/${SID}`, null, f.value, 'not-a-contribution-id')).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(await call('GET', `/api/postmortem/${SID}`, null, f.value, 'no-slash')).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(await handlePostmortemApi({ method: 'GET', path: `/api/postmortem/${SID}`, caller: 'helmsman.run-viewer/panel', service: f.value,
      authorize: () => { throw new PostmortemError(403, 'forbidden'); } })).toEqual({ status: 403, json: { error: 'forbidden' } });
    const authorize = vi.fn();
    expect(await handlePostmortemApi({ method: 'GET', path: `/api/postmortem/${SID}`, caller: 'helmsman.run-viewer/panel', service: f.value, authorize })).toEqual({ status: 200, json: snapshot });
    expect(authorize).toHaveBeenCalledWith('helmsman.run-viewer/panel');
  });

  it('rejects message bodies with unknown or malformed keys', async () => {
    const f = service();
    for (const body of [{ clientId: SID, text: 'hi', extra: 1 }, [1], 'nope']) {
      expect(await call('POST', `/api/postmortem/${SID}/messages`, body, f.value)).toMatchObject({ status: 400 });
    }
  });

  it('starts or reuses a session with validated options', async () => {
    const f = service();
    expect(await call('POST', '/api/runs/run-1/postmortem', { provider: 'claude-code', model: 'opus', effort: 'high', fresh: true }, f.value)).toEqual({ status: 200, json: snapshot });
    expect(f.value.start).toHaveBeenCalledWith('run-1', { provider: 'claude-code', model: 'opus', effort: 'high', fresh: true });
    expect(await call('POST', '/api/runs/run-1/postmortem', null, f.value)).toEqual({ status: 200, json: snapshot });
    expect(f.value.start).toHaveBeenLastCalledWith('run-1', {});
    for (const body of [{ provider: 'gpt' }, { model: '--danger' }, { effort: 'HIGH!' }, { fresh: 'yes' }, { extra: 1 }, [1]]) {
      expect(await call('POST', '/api/runs/run-1/postmortem', body, f.value)).toMatchObject({ status: 400 });
    }
  });

  it.each([[404, 'unknown run'], [409, 'ineligible run'], [412, 'sandbox unavailable'], [429, 'concurrency limit'], [503, 'model routing not configured']])('maps start %s (%s)', async status => {
    expect(await call('POST', '/api/runs/run-1/postmortem', {}, service({ start: failing(status) }).value)).toEqual({ status, json: { error: `status ${status}` } });
  });

  it.each([[409, 'turn in progress'], [423, 'capped'], [412, 'sandbox unavailable'], [429, 'concurrency limit'], [400, 'invalid message'], [503, 'model routing not configured']])('maps message %s (%s)', async status => {
    expect(await call('POST', `/api/postmortem/${SID}/messages`, { clientId: SID, text: 'hi' }, service({ send: failing(status) }).value)).toMatchObject({ status });
  });

  it('reads, sends, stops and rejects other methods', async () => {
    const f = service();
    expect(await call('GET', `/api/postmortem/${SID}`, null, f.value)).toEqual({ status: 200, json: snapshot });
    await call('POST', `/api/postmortem/${SID}/messages`, { clientId: SID, text: 'Why?' }, f.value);
    expect(f.value.send).toHaveBeenCalledWith(SID, { clientId: SID, text: 'Why?' });
    expect(await call('POST', `/api/postmortem/${SID}/stop`, null, f.value)).toEqual({ status: 200, json: snapshot });
    expect(await call('DELETE', `/api/postmortem/${SID}`, null, f.value)).toMatchObject({ status: 405 });
    expect(await call('GET', '/api/postmortem/not-a-uuid', null, f.value)).toBeNull();
    expect(await call('GET', `/api/postmortem/${SID}`, null, service({ read: vi.fn(async () => { throw new Error('boom'); }) }).value)).toMatchObject({ status: 500 });
  });

  it('streams a snapshot then live events over SSE and unsubscribes on close', async () => {
    const f = service();
    const server = createServer((req, res) => { void handlePostmortemEvents(req, res, new URL(req.url ?? '/', 'http://x').pathname,
      { caller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined, service: f.value }); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/api/postmortem/${SID}/events`;
    expect((await fetch(url)).status).toBe(403);
    const abort = new AbortController();
    const response = await fetch(url, { headers: { 'X-Helmsman-Contribution': 'helmsman.run-viewer/panel' }, signal: abort.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(JSON.parse(text.replace(/^data: /, '').trim())).toEqual({ type: 'snapshot', snapshot });
    f.emit({ type: 'patches', patches: [] });
    text = decoder.decode((await reader.read()).value);
    expect(text).toBe(`data: ${JSON.stringify({ type: 'patches', patches: [] })}\n\n`);
    abort.abort();
    await vi.waitFor(() => expect(f.listening()).toBe(false));
    const missing = service({ read: failing(404) });
    expect(await new Promise<boolean>(resolve => {
      const req = { method: 'GET', on: vi.fn() } as never;
      const res = { writeHead: vi.fn(() => res), end: vi.fn(() => resolve(true)), on: vi.fn() } as never;
      void handlePostmortemEvents(req, res, `/api/postmortem/${SID}/events`, { caller: 'helmsman.run-viewer/panel', service: missing.value });
    })).toBe(true);
  });

  it('rejects malformed contribution ids and authorize-denied callers on the events route', async () => {
    const f = service();
    const server = createServer((req, res) => { void handlePostmortemEvents(req, res, new URL(req.url ?? '/', 'http://x').pathname,
      { caller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined, service: f.value,
        authorize: caller => { if (caller === 'helmsman.denied/panel') throw new PostmortemError(403, 'forbidden'); } }); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/api/postmortem/${SID}/events`;
    expect((await fetch(url, { headers: { 'X-Helmsman-Contribution': 'not-a-contribution-id' } })).status).toBe(403);
    expect((await fetch(url, { headers: { 'X-Helmsman-Contribution': 'helmsman.denied/panel' } })).status).toBe(403);
    expect(f.listening()).toBe(false);
  });

  it('unsubscribes immediately on disconnect even while read() is still pending', async () => {
    let resolveRead: (value: PostmortemSnapshot) => void = () => {};
    const readGate = new Promise<PostmortemSnapshot>(resolve => { resolveRead = resolve; });
    const f = service({ read: vi.fn(() => readGate) });
    const server = createServer((req, res) => { void handlePostmortemEvents(req, res, new URL(req.url ?? '/', 'http://x').pathname,
      { caller: 'helmsman.run-viewer/panel', service: f.value }); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/api/postmortem/${SID}/events`;
    const abort = new AbortController();
    const pending = fetch(url, { signal: abort.signal }).catch(() => {});
    await vi.waitFor(() => expect(f.listening()).toBe(true));
    abort.abort();
    await vi.waitFor(() => expect(f.listening()).toBe(false));
    resolveRead(snapshot);
    await pending;
  });
});
