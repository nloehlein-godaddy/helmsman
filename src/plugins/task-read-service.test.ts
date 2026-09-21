import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostTaskReadService } from './task-read-service';
import type { TaskReadScopeV1 } from './task-read-service';
import { TASK_READ_LIMITS } from './task-read';
import type { TaskReadListQueryV1 } from './task-read';
import type { TaskSnapshotV1 } from './tasks';

const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/project';
const query: TaskReadListQueryV1 = { version: 1, sourceId, instanceId: 'source-instance', instanceRevision: 3, repo, state: 'ready', cursor: null, limit: 10 };
const task: TaskSnapshotV1 = { version: 1, ref: { sourceId, externalId: '10001' }, repo, revision: 'r1', displayKey: 'TASK-2', title: 'Task', state: 'ready', priority: null, url: null, requirements: { description: 'Implement', acceptanceCriteria: [], links: [] }, providerData: { version: 1, internal: true } };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const context = vi.fn(async () => Response.json({ repos: [repo, 'owner/other'], jiraBaseUrl: 'private-unused' }));
  const sources = vi.fn(async (url: URL) => Response.json({ instances: [{ id: query.instanceId, sourceId, revision: 3, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [url.searchParams.get('repo')], settings: { ignored: 'private' } }] }));
  const lookup = vi.fn(async (_url: URL) => Response.json({ ref: task.ref }));
  const tasks = vi.fn(async (_url: URL) => Response.json({ items: [task], nextCursor: null }));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/context') return context();
    if (url.pathname === '/api/task-sources') return sources(url);
    if (url.pathname === `/api/task-sources/${query.instanceId}/tasks`) return tasks(url);
    if (url.pathname === `/api/task-sources/${query.instanceId}/lookup`) return lookup(url);
    throw new Error('Unexpected endpoint');
  });
  const service = createHostTaskReadService(lifetime.signal, { scope: () => scope, fetch: fetcher });
  return { service, lifetime, activity, context, sources, tasks, lookup, fetcher, get scope() { return scope; }, set scope(value: TaskReadScopeV1) { scope = value; } };
}
afterEach(() => vi.restoreAllMocks());

describe('host browser task read adapter', () => {
  it('requires the declared Underway view and never falls back to state-filtered task listing', async () => {
    const f = fixture(); const { state: _state, ...underway } = query;
    expect(await f.service.underway!(underway)).toEqual({ status: 'unavailable', reason: 'view-unavailable' }); expect(f.tasks).not.toHaveBeenCalled();
    f.sources.mockImplementation(async () => Response.json({ instances: [{ id: query.instanceId, sourceId, revision: 3, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [repo], readViews: ['underway'] }] }));
    f.tasks.mockResolvedValue(Response.json({ items: [task], nextCursor: null }));
    expect(await f.service.underway!(underway)).toMatchObject({ status: 'available', value: { items: [{ state: 'ready' }] } });
    expect(Object.fromEntries(f.tasks.mock.calls[0]![0].searchParams)).toEqual({ repo, revision: '3', limit: '10', view: 'underway' });
    f.tasks.mockResolvedValue(Response.json({ items: [{ ...task, state: 'done' }], nextCursor: null }));
    expect(await f.service.underway!(underway)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    f.tasks.mockResolvedValue(new Response(null, { status: 501 }));
    expect(await f.service.underway!(underway)).toEqual({ status: 'unavailable', reason: 'view-unavailable' });
  });
  it('discovers only the effective galleon and never reads automatic scheduling selections', async () => {
    const f = fixture(); const result = await f.service.discover();
    expect(result).toMatchObject({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [{ instanceId: query.instanceId, sourceId }] } }] } });
    expect(f.sources).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/context', '/api/task-sources?repo=owner%2Fproject']);
  });
  it('enumerates permitted galleons explicitly and preserves partial source outages', async () => {
    const f = fixture(); f.scope = { ...f.scope, repo: null };
    f.sources.mockImplementation(async url => url.searchParams.get('repo') === repo ? Response.json({ instances: [] }) : Response.json({}, { status: 503 }));
    expect(await f.service.discover()).toEqual({ status: 'available', value: { version: 1, repo: null, galleons: [
      { repo, sources: { status: 'available', value: [] } }, { repo: 'owner/other', sources: { status: 'unavailable', reason: 'service-unavailable' } },
    ] } });
    expect(f.sources.mock.calls.every(([url]) => Boolean(url.searchParams.get('repo')))).toBe(true);
  });
  it('sends exact instance revision, effective scope and bounded page query without leaking provider metadata', async () => {
    const f = fixture(); const result = await f.service.list({ ...query, cursor: 'opaque/+cursor' });
    expect(result).toMatchObject({ status: 'available', value: { selection: { instanceRevision: 3, sourceId, repo }, items: [{ ref: task.ref, priority: null, url: null }] } });
    if (result.status === 'available') expect(result.value.items[0]).not.toHaveProperty('providerData');
    expect(Object.fromEntries(f.tasks.mock.calls[0]![0].searchParams)).toEqual({ repo, revision: '3', limit: '10', state: 'ready', cursor: 'opaque/+cursor' });
  });
  it('rejects a task source mismatch even when the task endpoint would return an empty page', async () => {
    const f = fixture(); f.tasks.mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    expect(await f.service.list({ ...query, sourceId: '22222222-2222-4222-8222-222222222222' })).toEqual({ status: 'unavailable', reason: 'selection-changed' });
    expect(f.tasks).not.toHaveBeenCalled();
    expect(await f.service.list({ ...query, instanceRevision: 2 })).toEqual({ status: 'unavailable', reason: 'selection-changed' });
  });
  it('rejects unauthorized and out-of-scope galleons before task discovery', async () => {
    const f = fixture();
    expect(await f.service.list({ ...query, repo: 'owner/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.context.mockResolvedValue(Response.json({ repos: ['owner/other'] }));
    expect(await f.service.discover()).toEqual({ status: 'unavailable', reason: 'forbidden' });
    expect(f.sources).not.toHaveBeenCalled();
  });
  it('preserves missing task separately from source transport failures', async () => {
    const f = fixture();
    f.tasks.mockResolvedValueOnce(Response.json({ task })).mockResolvedValueOnce(Response.json({}, { status: 404 })).mockResolvedValueOnce(Response.json({}, { status: 503 }));
    expect(await f.service.load({ ...query, ref: task.ref })).toMatchObject({ status: 'available', value: { task: { ref: task.ref } } });
    expect(Object.fromEntries(f.tasks.mock.calls[0]![0].searchParams)).toEqual({ repo, revision: '3', sourceId, externalId: '10001' });
    expect(await f.service.load({ ...query, ref: task.ref })).toMatchObject({ status: 'available', value: { ref: task.ref, task: null } });
    expect(await f.service.load({ ...query, ref: task.ref })).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
  });
  it.each([[false, false, 'disabled'], [true, false, 'source-unavailable']])('keeps declared source availability explicit', async (enabled, available, reason) => {
    const f = fixture(); f.sources.mockResolvedValue(Response.json({ instances: [{ id: query.instanceId, sourceId, revision: 3, label: 'Tasks', desiredEnabled: enabled, available, allowedRepos: [repo] }] }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason });
    expect(f.tasks).not.toHaveBeenCalled();
  });
  it.each([[401, 'forbidden'], [403, 'forbidden'], [409, 'selection-changed'], [404, 'not-found'], [500, 'service-unavailable']])('maps status %s without exposing host error details', async (status, reason) => {
    const f = fixture(); f.tasks.mockResolvedValue(Response.json({ error: 'private server detail' }, { status: Number(status) }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason });
  });
  it('rejects malformed and wrong-galleon task results atomically', async () => {
    const f = fixture();
    f.tasks.mockResolvedValueOnce(new Response('{broken')).mockResolvedValueOnce(Response.json({ items: [{ ...task, repo: 'owner/other' }], nextCursor: null }));
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it.each(['lifetime', 'activity', 'caller'] as const)('cancels %s reads even when the transport ignores its abort signal', async owner => {
    const f = fixture(); const caller = new AbortController();
    f.context.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.discover(caller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    (owner === 'caller' ? caller : f[owner]).abort();
    await rejection;
    expect(f.sources).not.toHaveBeenCalled();
  });
  it('fences late results after a scope epoch changes without mutating header scope', async () => {
    const f = fixture(); let finish!: (value: Response) => void;
    f.context.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.discover();
    f.scope = { ...f.scope, epoch: 2, repo: 'owner/other' };
    finish(Response.json({ repos: [repo, 'owner/other'] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.scope.repo).toBe('owner/other'); expect(f.sources).not.toHaveBeenCalled();
  });
  it('suspends inactive instances before requesting context', async () => {
    const f = fixture(); f.scope = { ...f.scope, active: false };
    await expect(f.service.discover()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('cancels oversized response streams before consuming the remainder', async () => {
    const f = fixture(); const cancel = vi.fn();
    f.context.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(TASK_READ_LIMITS.responseBytes + 1)); }, cancel })));
    expect(await f.service.discover()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(cancel).toHaveBeenCalled(); expect(f.sources).not.toHaveBeenCalled();
  });
  it('reports a transport timeout separately from lifetime cancellation', async () => {
    const f = fixture(); const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    f.context.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.discover(); timeout.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(await pending).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
  it('bounds concurrent all-galleon discovery without inventing provider-wide queries', async () => {
    const f = fixture(); f.scope = { ...f.scope, repo: null };
    const repos = Array.from({ length: 9 }, (_, index) => `owner/project-${index}`);
    f.context.mockResolvedValue(Response.json({ repos }));
    let active = 0; let maximum = 0;
    f.sources.mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 0)); active--;
      return Response.json({ instances: [] });
    });
    const result = await f.service.discover();
    expect(maximum).toBe(TASK_READ_LIMITS.discoveryConcurrency);
    expect(f.sources).toHaveBeenCalledTimes(9);
    if (result.status !== 'available') throw new Error('Discovery unavailable');
    expect(result.value.galleons.map(value => value.repo)).toEqual(repos);
  });
  it('bounds the combined source discovery result across galleons', async () => {
    const f = fixture(); f.scope = { ...f.scope, repo: null };
    f.sources.mockImplementation(async url => Response.json({ instances: Array.from({ length: TASK_READ_LIMITS.instances }, (_, index) => ({ id: `instance-${index}`, sourceId, revision: 1, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [url.searchParams.get('repo')] })) }));
    expect(await f.service.discover()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it('does not deliver data after an instance is hidden during response decoding', async () => {
    const f = fixture();
    f.context.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ repos: [repo] })));
      f.scope = { ...f.scope, active: false };
      controller.close();
    } })));
    await expect(f.service.discover()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.sources).not.toHaveBeenCalled();
  });
});

it.each(['oversized-header', 'forbidden'])('cancels unread response bodies rejected for %s', async cause => {
  const f = fixture(); const cancel = vi.fn();
  f.context.mockResolvedValue(new Response(new ReadableStream({ cancel }), cause === 'forbidden' ? { status: 403 }
    : { headers: { 'Content-Length': String(TASK_READ_LIMITS.responseBytes + 1) } }));
  expect(await f.service.discover()).toEqual({ status: 'unavailable', reason: cause === 'forbidden' ? 'forbidden' : 'invalid-response' });
  expect(cancel).toHaveBeenCalledOnce(); expect(f.sources).not.toHaveBeenCalled();
});
it('disposes a late response stream when its transport ignored lifetime cancellation', async () => {
  const f = fixture(); let finish!: (response: Response) => void; const cancel = vi.fn();
  f.context.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.service.discover(); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  f.lifetime.abort(); await rejected;
  finish(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(f.sources).not.toHaveBeenCalled();
});


describe('public browser display-key lookup', () => {
  it('loads canonical identity after scoped lookup and strips provider metadata', async () => {
    const f = fixture(); f.tasks.mockImplementation(async () => Response.json({ task: { ...task, displayKey: 'TASK-RENAMED' } }));
    const result = await f.service.lookup!({ ...query, displayKey: 'TASK-2' });
    expect(result).toMatchObject({ status: 'available', value: { ref: task.ref, task: { displayKey: 'TASK-RENAMED' } } });
    if (result.status === 'available') expect(result.value?.task).not.toHaveProperty('providerData');
    expect(Object.fromEntries(f.lookup.mock.calls[0]![0].searchParams)).toEqual({ repo, revision: '3', key: 'TASK-2' });
    expect(Object.fromEntries(f.tasks.mock.calls[0]![0].searchParams)).toEqual({ repo, revision: '3', sourceId, externalId: task.ref.externalId });
  });
  it('distinguishes unknown keys and tasks removed after lookup', async () => {
    const f = fixture(); f.lookup.mockResolvedValueOnce(Response.json({ ref: null }));
    expect(await f.service.lookup!({ ...query, displayKey: 'MISSING' })).toEqual({ status: 'available', value: null }); expect(f.tasks).not.toHaveBeenCalled();
    f.tasks.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await f.service.lookup!({ ...query, displayKey: 'TASK-2' })).toMatchObject({ status: 'available', value: { ref: task.ref, task: null } });
  });
  it('rejects foreign canonical identity and changed source revision without loading a task', async () => {
    const f = fixture(); f.lookup.mockResolvedValueOnce(Response.json({ ref: { ...task.ref, sourceId: '22222222-2222-4222-8222-222222222222' } }));
    expect(await f.service.lookup!({ ...query, displayKey: 'TASK-2' })).toEqual({ status: 'unavailable', reason: 'invalid-response' }); expect(f.tasks).not.toHaveBeenCalled();
    expect(await f.service.lookup!({ ...query, instanceRevision: 1, displayKey: 'TASK-2' })).toEqual({ status: 'unavailable', reason: 'selection-changed' }); expect(f.lookup).toHaveBeenCalledTimes(1);
  });
  it('fences canonical followup reads after scope cancellation during lookup', async () => {
    const f = fixture(); let finish!: (response: Response) => void;
    f.lookup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.lookup!({ ...query, displayKey: 'TASK-2' }); const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledTimes(1)); f.activity.abort(); finish(Response.json({ ref: task.ref })); await rejection; expect(f.tasks).not.toHaveBeenCalled();
  });
});
