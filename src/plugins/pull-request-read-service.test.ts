import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostPullRequestReadService, type PullRequestReadScopeV1 } from './pull-request-read-service';
import { PULL_REQUEST_READ_LIMITS } from './pull-request-read';
const repo = 'org/project';
const query = { version: 1 as const, repo, kind: 'repo-open' as const, limit: 25 };
const item = { repo, number: 42, title: 'Work', url: 'https://provider.test/pr/42', status: 'open', createdAt: '2026-09-20T12:00:00Z', mergedAt: null, draft: false, ticketId: null, reviewDecision: null, comments: null, reviews: null };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: PullRequestReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const context = vi.fn(async () => Response.json({ repos: [repo, 'org/other'] }));
  const response = vi.fn(async (url: URL): Promise<Response> => Response.json({ version: 1, repo: url.searchParams.get('repo'), kind: url.searchParams.get('kind'), items: [item], quality: 'complete', truncated: false, browseUrl: null }));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' }); const url = new URL(String(input), 'http://localhost'); return url.pathname === '/api/context' ? context() : response(url); });
  const service = createHostPullRequestReadService(lifetime.signal, { scope: () => scope, fetch: fetcher, pollIntervalMs: 100 });
  return { lifetime, activity, service, fetcher, response, context, get scope() { return scope; }, set scope(value: PullRequestReadScopeV1) { scope = value; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('scoped pull request host reads', () => {
  it('fetches typed bounded results without leaking provider or endpoint internals', async () => {
    const f = fixture(); expect(await f.service.list(query)).toMatchObject({ status: 'available', value: { items: [{ comments: null }] } });
    expect(f.response.mock.calls[0]?.[0].pathname).toBe('/api/pull-request-read');
    expect(Object.fromEntries(f.response.mock.calls[0]![0].searchParams)).toEqual({ repo, kind: 'repo-open', limit: '25' });
  });
  it('rejects a widened scope and unconfigured repos before reading provider data', async () => {
    const f = fixture(); expect(await f.service.list({ ...query, repo: 'org/other' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.context.mockResolvedValue(Response.json({ repos: ['org/other'] })); expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.response).not.toHaveBeenCalled();
  });
  it('requires repository selection for repo-open while allowing configured-only authored scope', async () => {
    const f = fixture(); f.scope = { ...f.scope, repo: null };
    expect(await f.service.list({ ...query, repo: null })).toEqual({ status: 'unavailable', reason: 'selection-required' }); expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.service.list({ ...query, repo: null, kind: 'authored-recent' })).toMatchObject({ status: 'available' });
    f.response.mockResolvedValue(Response.json({ version: 1, repo: null, kind: 'authored-recent', items: [{ ...item, repo: 'private/project' }], quality: 'complete', truncated: false, browseUrl: null }));
    expect(await f.service.list({ ...query, repo: null, kind: 'authored-recent' })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it.each([[403, 'forbidden'], [409, 'selection-changed'], [422, 'selection-required'], [503, 'service-unavailable']])('maps HTTP%s into typed unavailability', async (code, reason) => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ error: '/private/token' }, { status: Number(code) })); expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason });
  });
  it.each(['lifetime', 'activity', 'caller'] as const)('cancels %s without waiting for an uncooperative transport', async owner => {
    const f = fixture(); const caller = new AbortController(); f.context.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.list(query, caller.signal); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); (owner === 'caller' ? caller : f[owner]).abort(); await rejected;
  });
  it('rejects a response from a changed activity epoch without an explicit abort', async () => {
    const f = fixture(); let finish!: (value: Response) => void; f.response.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.list(query); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.response).toHaveBeenCalled()); f.scope = { ...f.scope, epoch: 2 }; finish(Response.json({})); await rejected;
  });
  it('bounds response bytes and rejects unsafe provider links', async () => {
    const f = fixture(); f.response.mockResolvedValue(new Response('x'.repeat(PULL_REQUEST_READ_LIMITS.responseBytes + 1))); expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    f.response.mockResolvedValue(Response.json({ version: 1, repo, kind: 'repo-open', items: [item], quality: 'complete', truncated: false, browseUrl: 'javascript:alert(1)' })); expect(await f.service.list(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it('polls immediately without overlaps, tolerates subscriber exceptions, and stops on cleanup', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (value: Response) => void;
    f.response.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const listener = vi.fn(() => { throw new Error('UI callback'); });
    const unsubscribe = f.service.watchList(query, listener); await vi.advanceTimersByTimeAsync(500); expect(f.response).toHaveBeenCalledTimes(1);
    finish(Response.json({ version: 1, repo, kind: 'repo-open', items: [item], quality: 'complete', truncated: false, browseUrl: null }));
    await vi.advanceTimersByTimeAsync(0); expect(listener).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(100); expect(f.response).toHaveBeenCalledTimes(2);
    unsubscribe(); await vi.advanceTimersByTimeAsync(1000); expect(f.response).toHaveBeenCalledTimes(2);
  });
  it('never invokes a hidden scope or delivers late data after disposal', async () => {
    const f = fixture(); f.scope = { ...f.scope, active: false }; await expect(f.service.list(query)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.scope = { ...f.scope, active: true }; let finish!: (value: Response) => void; f.response.mockImplementation(() => new Promise(resolve => { finish = resolve; })); const listener = vi.fn();
    f.service.watchList(query, listener); await vi.waitFor(() => expect(f.response).toHaveBeenCalled()); f.lifetime.abort(); finish(Response.json({})); await Promise.resolve(); await Promise.resolve(); expect(listener).not.toHaveBeenCalled();
  });
});
