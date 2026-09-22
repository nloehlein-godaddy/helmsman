import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostRunReadService } from './run-read-service';
import type { RunReadScopeV1 } from './run-read-service';
import { RUN_READ_LIMITS } from './run-read';

const repo = 'owner/project'; const other = 'owner/other';
const query = { version: 1 as const, repo, kind: 'all' as const, limit: 10, cursor: null };
const detail = { version: 1 as const, repo, runId: 'run-1' };
const run = { version: 1, id: 'run-1', repo, displayKey: 'TASK-1', status: 'succeeded', attempt: 1,
  startedAt: '2026-09-20T12:00:00Z', endedAt: '2026-09-20T12:10:00Z', prNumber: null, costUsd: null, review: null, sourceSettlement: { state: 'pending' } };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: RunReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const context = vi.fn(async () => Response.json({ repos: [repo, other] }));
  const response = vi.fn(async (url: URL): Promise<Response> => {
    if (url.pathname.endsWith('/log')) return Response.json({ version: 1, repo, runId: 'run-1', events: [], nextCursor: 'next', hasMore: false, earlierTruncated: false, workerStatus: 'succeeded' });
    if (url.pathname.endsWith('/run-1')) return Response.json({ version: 1, repo, runId: 'run-1', run });
    return Response.json({ version: 1, repo: url.searchParams.get('repo'), items: [run], nextCursor: null });
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    const url = new URL(String(input), 'http://localhost');
    return url.pathname === '/api/context' ? context() : response(url);
  });
  const service = createHostRunReadService(lifetime.signal, { scope: () => scope, fetch: fetcher, pollIntervalMs: 100 });
  return { service, lifetime, activity, context, response, fetcher, get scope() { return scope; }, set scope(value: RunReadScopeV1) { scope = value; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('host run reads and polling', () => {
  it('uses exact scoped GET requests and preserves pending settlement alongside worker success', async () => {
    const f = fixture(); const result = await f.service.list(query);
    expect(result).toMatchObject({ status: 'available', value: { items: [{ status: 'succeeded', sourceSettlement: { state: 'pending' } }] } });
    expect(Object.fromEntries(f.response.mock.calls[0]![0].searchParams)).toEqual({ kind: 'all', limit: '10', repo });
    expect(await f.service.load(detail)).toMatchObject({ status: 'available', value: { run: { id: 'run-1' } } });
    expect(await f.service.log({ ...detail, limit: 10, cursor: null })).toMatchObject({ status: 'available', value: { workerStatus: 'succeeded' } });
  });
  it('rejects widening a concrete panel scope before any fetch', async () => {
    const f = fixture();
    expect(await f.service.list({ ...query, repo: null })).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(await f.service.load({ ...detail, repo: other })).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.context.mockResolvedValue(Response.json({ repos: [other] }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.response).not.toHaveBeenCalled();
  });
  it('permits all-scope reads only for configured galleons and rejects wrong-scope response data', async () => {
    const f = fixture(); f.scope = { ...f.scope, repo: null };
    expect(await f.service.list({ ...query, repo: null })).toMatchObject({ status: 'available' });
    f.response.mockResolvedValue(Response.json({ version: 1, repo: null, items: [{ ...run, repo: 'private/project' }], nextCursor: null }));
    expect(await f.service.list({ ...query, repo: null })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it.each([[401, 'forbidden'], [403, 'forbidden'], [404, 'not-found'], [409, 'selection-changed'], [503, 'service-unavailable']])('maps HTTP%s without exposing internal diagnostics', async (status, reason) => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ error: '/private/path' }, { status: Number(status) }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason });
  });
  it('distinguishes a missing run from failed reads', async () => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ version: 1, repo, runId: 'run-1', run: null }));
    expect(await f.service.load(detail)).toMatchObject({ status: 'available', value: { run: null } });
    f.response.mockRejectedValue(new Error('offline')); expect(await f.service.load(detail)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  });
  it.each(['lifetime', 'activity', 'caller'] as const)('cancels %s even when the transport ignores abort', async owner => {
    const f = fixture(); const caller = new AbortController(); f.context.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.list(query, caller.signal); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    (owner === 'caller' ? caller : f[owner]).abort(); await rejected;
  });
  it('fences a late response after the effective epoch changes without an abort event', async () => {
    const f = fixture(); let resolve!: (value: Response) => void;
    f.response.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = f.service.list(query); await vi.waitFor(() => expect(f.response).toHaveBeenCalled());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    f.scope = { ...f.scope, epoch: 2, repo: other }; resolve(Response.json({ version: 1, repo, items: [run], nextCursor: null })); await rejected;
  });
  it('cancels unread oversized responses and bodies arriving after cancellation', async () => {
    const f = fixture(); const discard = vi.fn();
    f.response.mockResolvedValue(new Response(new ReadableStream({ cancel: discard }), { headers: { 'content-length': String(RUN_READ_LIMITS.responseBytes + 1) } }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(discard).toHaveBeenCalledOnce();
    let resolve!: (value: Response) => void; const late = vi.fn();
    f.context.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = f.service.list(query); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.lifetime.abort(); await rejected;
    resolve(new Response(new ReadableStream({ cancel: late }))); await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());
  });
  it('bounds streamed response bytes even without Content-Length', async () => {
    const f = fixture(); const cancel = vi.fn();
    f.response.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(RUN_READ_LIMITS.responseBytes + 1)); }, cancel })));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('delivers the initial snapshot, never overlaps polls, and keeps polling after a listener error', async () => {
    vi.useFakeTimers(); const f = fixture(); let resolve!: (value: Response) => void;
    f.context.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const listener = vi.fn(() => { throw new Error('Subscriber failed'); }); const stop = f.service.watchList(query, listener);
    await vi.advanceTimersByTimeAsync(1000); expect(f.context).toHaveBeenCalledOnce(); expect(listener).not.toHaveBeenCalled();
    resolve(Response.json({ repos: [repo] })); await vi.advanceTimersByTimeAsync(0); expect(listener).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); expect(listener).toHaveBeenCalledTimes(2);
    stop(); stop(); const calls = f.fetcher.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it('stops polling on activity loss and never delivers a stale callback', async () => {
    vi.useFakeTimers(); const f = fixture(); const listener = vi.fn();
    const stop = f.service.watchLoad(detail, listener); await vi.advanceTimersByTimeAsync(0); expect(listener).toHaveBeenCalledOnce();
    f.scope = { ...f.scope, epoch: 2, active: false }; await vi.advanceTimersByTimeAsync(1000); expect(listener).toHaveBeenCalledOnce();
    stop();
  });
  it('advances log cursors for immediate catch-up and rejects duplicate sequences across polls', async () => {
    vi.useFakeTimers(); const f = fixture();
    const page = { version: 1, repo, runId: 'run-1', nextCursor: 'next', hasMore: true, earlierTruncated: false, workerStatus: 'succeeded',
      events: [{ sequence: 1, at: run.startedAt, kind: 'log', text: 'first', truncated: false }] };
    f.response.mockResolvedValueOnce(Response.json(page)).mockResolvedValueOnce(Response.json({ ...page, hasMore: false }));
    const listener = vi.fn(); const stop = f.service.watchLog({ ...detail, cursor: null, limit: 10 }, listener);
    await vi.advanceTimersByTimeAsync(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ status: 'available' });
    expect(listener.mock.calls[1]?.[0]).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(f.response.mock.calls[1]?.[0].searchParams.get('cursor')).toBe('next'); stop();
  });
  it.each([404, 503])('recovers when the first log page is HTTP %s without losing the cursor or replaying events', async status => {
    vi.useFakeTimers(); const f = fixture();
    const page = { version: 1, repo, runId: 'run-1', nextCursor: 'first-page', hasMore: false, earlierTruncated: false, workerStatus: 'running',
      events: [{ sequence: 1, at: run.startedAt, kind: 'log', text: 'first visible event', truncated: false }] };
    f.response.mockResolvedValueOnce(Response.json({}, { status }))
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json({ ...page, events: [], nextCursor: 'second-page' }));
    const listener = vi.fn(); const stop = f.service.watchLog({ ...detail, cursor: null, limit: 10 }, listener);
    await vi.advanceTimersByTimeAsync(200); stop();
    expect(listener.mock.calls.map(([result]) => result.status)).toEqual(['unavailable', 'available', 'available']);
    expect(f.response.mock.calls.map(([url]) => url.searchParams.get('cursor'))).toEqual([null, null, 'first-page']);
    expect(listener.mock.calls.flatMap(([result]) => result.status === 'available' ? result.value.events : [])).toEqual(page.events);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});
