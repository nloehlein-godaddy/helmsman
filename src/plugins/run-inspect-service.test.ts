import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostRunInspectService } from './run-inspect-service';
import type { RunReadScopeV1 } from './run-read-service';
import { RUN_INSPECT_LIMITS } from './run-inspect';

const repo = 'owner/project'; const other = 'owner/other'; const observedAt = '2026-09-20T12:00:00Z';
const target = { repo, runId: 'run-1', expectedAttempt: 1 }; const query = { version: 1 as const, target };
const metadata = { version: 1, target, observedAt, provenance: 'run-wide', throughSequence: 1, filename: 'helmsman-run-1.log', contentType: 'text/plain; charset=utf-8' };
const headers = { 'Content-Type': metadata.contentType, 'X-Helmsman-Run-Inspect': encodeURIComponent(JSON.stringify(metadata)) };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController(); let scope: RunReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const response = vi.fn(async (url: URL): Promise<Response> => {
    if (url.pathname.endsWith('/export')) return new Response('complete log', { headers });
    if (url.pathname.endsWith('/resolve')) return Response.json({ version: 1, target, observedAt });
    if (url.pathname.endsWith('/history')) return Response.json({ version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null, total: 0, totalQuality: 'exact', observedAt, coverage: 'insertion-bounded-current-state' });
    return Response.json({ version: 1, target, observedAt, provenance: 'run-wide', workerStatus: 'running', events: [], throughSequence: 0, hasEarlier: false, hasLater: false, nextCursor: null, followCursor: 'follow' });
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' }); const url = new URL(String(input), 'http://localhost');
    return url.pathname === '/api/context' ? Response.json({ repos: [repo, other] }) : response(url);
  });
  const service = createHostRunInspectService(lifetime.signal, { scope: () => scope, fetch: fetcher });
  return { service, lifetime, activity, response, fetcher, get scope() { return scope; }, set scope(value: RunReadScopeV1) { scope = value; } };
}
afterEach(() => { vi.useRealTimers(); });
describe('host run inspection adapter', () => {
  it('adds effective scope to resolve/log/export and validates returned metadata', async () => {
    const f = fixture(); expect(await f.service.resolve({ version: 1, runId: target.runId })).toMatchObject({ status: 'available', value: { target } });
    expect(Object.fromEntries(f.response.mock.calls.at(-1)![0].searchParams)).toEqual({ repo, runId: target.runId });
    expect(await f.service.log({ ...query, direction: 'backward', cursor: null, limit: 2 })).toMatchObject({ status: 'available' });
    expect(Object.fromEntries(f.response.mock.calls.at(-1)![0].searchParams)).toEqual({ repo, scopeRepo: repo, expectedAttempt: '1', direction: 'backward', limit: '2' });
    const result = await f.service.exportLog(query); expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(); expect(await new Response(result.value.stream).text()).toBe('complete log');
    expect(Object.fromEntries(f.response.mock.calls.at(-1)![0].searchParams)).toEqual({ repo, scopeRepo: repo, expectedAttempt: '1' });
  });
  it('rejects scope widening before any fetch and omits concrete scope only in All', async () => {
    const f = fixture(); expect(await f.service.exportLog({ ...query, target: { ...target, repo: other } })).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(await f.service.history({ version: 1, repo: null, kind: 'all', limit: 1, cursor: null })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.scope = { ...f.scope, repo: null }; await f.service.resolve({ version: 1, runId: target.runId }); expect(f.response.mock.calls.at(-1)?.[0].searchParams.has('repo')).toBe(false);
  });
  it.each(['attempt-changed', 'cursor-invalid', 'selection-changed'] as const)('preserves actionable409 %s errors without private details', async reason => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ error: reason, private: '/secret' }, { status: 409 }));
    expect(await f.service.log({ ...query, direction: 'backward', cursor: null, limit: 1 })).toEqual({ status: 'unavailable', reason });
  });
  it('rejects foreign resolve identities and cancels oversized JSON bodies', async () => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ version: 1, target: { ...target, repo: other }, observedAt }));
    expect(await f.service.resolve({ version: 1, runId: target.runId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    const cancel = vi.fn(); f.response.mockResolvedValue(new Response(new ReadableStream({ start(value) { value.enqueue(new Uint8Array(RUN_INSPECT_LIMITS.responseBytes + 1)); }, cancel })));
    expect(await f.service.resolve({ version: 1, runId: target.runId })).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['lifetime', 'activity', 'caller'] as const)('cancels an unread exported stream after the method resolves on %s disposal', async owner => {
    const f = fixture(); const caller = new AbortController(); const cancel = vi.fn();
    f.response.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers }));
    const result = await f.service.exportLog(query, caller.signal); if (result.status !== 'available') throw new Error();
    (owner === 'caller' ? caller : f[owner]).abort(); expect(cancel).toHaveBeenCalledOnce();
    await expect(result.value.stream.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not pull upstream export bytes without downstream demand and propagates cancellation', async () => {
    const f = fixture(); const pull = vi.fn((value: ReadableStreamDefaultController<Uint8Array>) => value.enqueue(new TextEncoder().encode('chunk'))); const cancel = vi.fn();
    f.response.mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers }));
    const result = await f.service.exportLog(query); if (result.status !== 'available') throw new Error(); expect(pull).not.toHaveBeenCalled();
    const reader = result.value.stream.getReader(); await reader.read(); expect(pull).toHaveBeenCalledOnce(); await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('fences a late export read after epoch changes even without an abort event', async () => {
    const f = fixture(); const cancel = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    f.response.mockResolvedValue(new Response(new ReadableStream({ start(value) { controller = value; }, cancel }), { headers }));
    const result = await f.service.exportLog(query); if (result.status !== 'available') throw new Error(); const pending = result.value.stream.getReader().read(); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    f.scope = { ...f.scope, epoch: 2 }; controller.enqueue(new Uint8Array([1])); await rejected; expect(cancel).toHaveBeenCalledOnce();
  });
  it('splits coalesced network bytes into at most64KiB per downstream pull without fetching ahead', async () => {
    const f = fixture(); const bytes = new Uint8Array(4 * RUN_INSPECT_LIMITS.exportChunkBytes + 5); bytes.forEach((_, index) => { bytes[index] = index % 251; });
    let emitted = false; const pull = vi.fn((value: ReadableStreamDefaultController<Uint8Array>) => { if (emitted) value.close(); else { emitted = true; value.enqueue(bytes); } });
    f.response.mockResolvedValue(new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers }));
    const result = await f.service.exportLog(query); if (result.status !== 'available') throw new Error(); const reader = result.value.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < 5; index++) { const part = await reader.read(); expect(part.done).toBe(false); expect(part.value!.byteLength).toBeLessThanOrEqual(RUN_INSPECT_LIMITS.exportChunkBytes); chunks.push(part.value!); expect(pull).toHaveBeenCalledOnce(); }
    expect((await reader.read()).done).toBe(true); expect(pull).toHaveBeenCalledTimes(2);
    const combined = new Uint8Array(bytes.byteLength); let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; } expect(combined).toEqual(bytes);
  });
  it('rejects rebound export headers and disposes unread bodies', async () => {
    const f = fixture(); const cancel = vi.fn(); f.response.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { ...headers,
      'X-Helmsman-Run-Inspect': encodeURIComponent(JSON.stringify({ ...metadata, target: { ...target, expectedAttempt: 2 } })) } }));
    expect(await f.service.exportLog(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels a pending fetch even when transport ignores abort, and disposes its late body', async () => {
    const f = fixture(); let resolve!: (response: Response) => void; f.response.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = f.service.exportLog(query); await vi.waitFor(() => expect(f.response).toHaveBeenCalled()); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.lifetime.abort(); await rejected;
    const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel }), { headers })); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('limits response-header timeout without imposing that deadline on a healthy export stream', async () => {
    vi.useFakeTimers(); const f = fixture(); const cancel = vi.fn(); f.response.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers }));
    const result = await f.service.exportLog(query); if (result.status !== 'available') throw new Error(); await vi.advanceTimersByTimeAsync(31_000); expect(cancel).not.toHaveBeenCalled(); await result.value.stream.cancel();
    const next = fixture(); next.response.mockImplementation(() => new Promise(() => {})); const pending = next.service.exportLog(query); await vi.advanceTimersByTimeAsync(31_000);
    expect(await pending).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});
