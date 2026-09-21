import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostActivityReadService } from './activity-read-service';
import type { TaskReadScopeV1 } from './task-read-service';
import { ACTIVITY_READ_LIMITS } from './activity-read';
const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/repo';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo };
const history = { version: 1, repo, from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z', historyQuality: 'partial', throughputQuality: 'complete', events: [], days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${14 + index}`, completed: index })) };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const sources = vi.fn(async () => Response.json({ instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [repo], readViews: ['history'] }] }));
  const read = vi.fn(async () => Response.json({ selection, history }));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET'); const url = new URL(String(input), 'http://host');
    if (url.pathname === '/api/context') return Response.json({ repos: [repo, 'owner/other'] });
    if (url.pathname === '/api/task-sources') return sources();
    return read();
  });
  const service = createHostActivityReadService(lifetime.signal, { scope: () => scope, fetch: fetcher });
  return { service, lifetime, activity, fetcher, sources, read, get scope() { return scope; }, set scope(value: TaskReadScopeV1) { scope = value; } };
}
afterEach(() => vi.restoreAllMocks());
describe('scoped browser activity reads', () => {
  it('reads only declared exact-repository history with source revision and immutable public data', async () => {
    const f = fixture(); const result = await f.service.query(selection);
    expect(result).toMatchObject({ status: 'available', value: { history: { throughputQuality: 'complete' } } });
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/context', '/api/task-sources?repo=owner%2Frepo', `/api/activity-read/tasks?repo=owner%2Frepo&revision=2&sourceId=${sourceId}`]);
    if (result.status === 'available') expect(Object.isFrozen(result.value.history.days)).toBe(true);
  });
  it('does not widen concrete scope and keeps all-repository reads constrained to the requested repository', async () => {
    const f = fixture(); expect(await f.service.query({ ...selection, repo: 'owner/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.scope = { ...f.scope, repo: null }; expect((await f.service.query(selection)).status).toBe('available'); expect(f.sources).toHaveBeenCalledTimes(1);
  });
  it('does not invent history for older providers or stale source selections', async () => {
    const f = fixture(); f.sources.mockImplementation(async () => Response.json({ instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [repo] }] }));
    expect(await f.service.query(selection)).toEqual({ status: 'unavailable', reason: 'view-unavailable' }); expect(f.read).not.toHaveBeenCalled();
    expect(await f.service.query({ ...selection, instanceRevision: 1 })).toEqual({ status: 'unavailable', reason: 'selection-changed' });
  });
  it.each([[403, 'forbidden'], [409, 'selection-changed'], [501, 'view-unavailable'], [503, 'service-unavailable']])('maps response %s without private server errors', async (status, reason) => {
    const f = fixture(); f.read.mockResolvedValue(Response.json({ error: 'Private detail' }, { status: Number(status) })); expect(await f.service.query(selection)).toEqual({ status: 'unavailable', reason });
  });
  it.each(['activity', 'lifetime', 'caller'] as const)('cancels %s waits even with an uncooperative transport', async owner => {
    const f = fixture(); const caller = new AbortController(); f.read.mockImplementation(() => new Promise(() => {}));
    const result = f.service.query(selection, caller.signal); const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1)); (owner === 'caller' ? caller : f[owner]).abort(); await rejection;
  });
  it('rejects source-mismatched and oversized streamed responses', async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(Response.json({ selection: { ...selection, repo: 'owner/other' }, history }));
    expect(await f.service.query(selection)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    const cancel = vi.fn(); f.read.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ACTIVITY_READ_LIMITS.responseBytes + 1)); }, cancel })));
    expect(await f.service.query(selection)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(cancel).toHaveBeenCalled();
  });
  it('fences late data after a scope epoch changes without widening its selection', async () => {
    const f = fixture(); let finish!: (response: Response) => void; f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = f.service.query(selection); const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' }); await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.scope = { ...f.scope, epoch: 2 }; finish(Response.json({ selection, history })); await rejection;
  });
});
