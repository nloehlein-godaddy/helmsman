import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostTaskViewsReadService } from './task-views-read-service';
import { TASK_VIEW_LIMITS, type TaskTriageReadQueryV1 } from './task-views';
import type { TaskReadScopeV1 } from './task-read-service';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/repo'; const asOf = '2026-09-20T12:00:00.000Z';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo };
const query: TaskTriageReadQueryV1 = { ...selection, group: 'mine-open', priorities: [1], updatedSince: null, until: asOf, cursor: null, limit: 10 };
const page = { version: 1, repo, group: query.group, items: [], nextCursor: null, quality: 'partial' };
const count = { value: null, quality: 'unavailable' };
const report = { version: 1, repo, asOf, open: count, createdLast7d: count, completedLast7d: count, pastSla: count,
  rows: [], rowsQuality: 'unavailable', oldest: null, oldestQuality: 'unavailable', resolutionP75: { days: null, sampleSize: 0, population: count, quality: 'unavailable', capped: false } };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const sources = vi.fn(async () => Response.json({ instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [repo], readViews: ['triage', 'bugs'] }] }));
  const read = vi.fn(async (url: URL): Promise<Response> => Response.json(url.pathname.endsWith('/bugs') ? { selection, report } : { selection, query, page }));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET'); const url = new URL(String(input), 'http://host');
    if (url.pathname === '/api/context') return Response.json({ repos: [repo, 'owner/other'] });
    if (url.pathname === '/api/task-sources') return sources(); return read(url);
  });
  return { service: createHostTaskViewsReadService(lifetime.signal, { scope: () => scope, fetch: fetcher }), lifetime, activity, read, sources, fetcher,
    get scope() { return scope; }, set scope(value: TaskReadScopeV1) { scope = value; } };
}
afterEach(() => vi.restoreAllMocks());
describe('scoped browser task views', () => {
  it('rejects malformed queries through the promised async API', async () => {
    const f = fixture(); await expect(f.service.triage({ ...query, limit: 0 })).rejects.toThrow();
    await expect(f.service.bugs({ ...selection, sourceId: '' })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('preserves partial group quality and unavailable bug metrics without substitution', async () => {
    const f = fixture(); expect(await f.service.triage(query)).toMatchObject({ status: 'available', value: { page: { quality: 'partial' } } });
    expect(await f.service.bugs(selection)).toMatchObject({ status: 'available', value: { report: { open: count } } });
    const request = f.read.mock.calls[0]?.[0]; expect(request?.searchParams.get('priorities')).toBe('1'); expect(request?.searchParams.get('until')).toBe(asOf);
  });
  it('never widens concrete scope and keeps All reads in the chosen galleon', async () => {
    const f = fixture(); expect(await f.service.bugs({ ...selection, repo: 'owner/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.scope = { ...f.scope, repo: null }; expect((await f.service.bugs(selection)).status).toBe('available'); expect(f.sources).toHaveBeenCalledOnce();
  });
  it('fails independently for stale selections, disabled and unsupported views', async () => {
    const f = fixture(); expect(await f.service.triage({ ...query, instanceRevision: 1 })).toEqual({ status: 'unavailable', reason: 'selection-changed' });
    f.sources.mockResolvedValueOnce(Response.json({ instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Tasks', desiredEnabled: false, available: false, allowedRepos: [repo], readViews: [] }] }));
    expect(await f.service.bugs(selection)).toEqual({ status: 'unavailable', reason: 'disabled' });
    f.sources.mockResolvedValueOnce(Response.json({ instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [repo] }] }));
    expect(await f.service.bugs(selection)).toEqual({ status: 'unavailable', reason: 'view-unavailable' }); expect(f.read).not.toHaveBeenCalled();
  });
  it.each([[403, 'forbidden'], [409, 'selection-changed'], [501, 'view-unavailable'], [503, 'service-unavailable']])('maps response %s without private details', async (status, reason) => {
    const f = fixture(); f.read.mockResolvedValue(Response.json({ error: 'private' }, { status: Number(status) })); expect(await f.service.triage(query)).toEqual({ status: 'unavailable', reason });
  });
  it.each(['lifetime', 'activity', 'caller'] as const)('cancels uncooperative %s transport', async kind => {
    const f = fixture(); const caller = new AbortController(); f.read.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.bugs(selection, caller.signal); const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce()); (kind === 'caller' ? caller : f[kind]).abort(); await rejection;
  });
  it('rejects altered source/filter envelopes and cancels oversized streams', async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(Response.json({ selection, query: { ...query, priorities: [2] }, page }));
    expect(await f.service.triage(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    f.read.mockResolvedValueOnce(Response.json({ selection: { ...selection, sourceId: '22222222-2222-4222-8222-222222222222' }, report }));
    expect(await f.service.bugs(selection)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    const cancel = vi.fn(); f.read.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(TASK_VIEW_LIMITS.responseBytes + 1)); }, cancel })));
    expect(await f.service.bugs(selection)).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(cancel).toHaveBeenCalled();
  });
  it('fences a late response after a scope epoch changes', async () => {
    const f = fixture(); let finish!: (response: Response) => void; f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.triage(query); const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.scope = { ...f.scope, epoch: 2 }; finish(Response.json({ selection, query, page })); await rejection;
  });
});
