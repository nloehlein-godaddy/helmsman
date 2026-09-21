import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostPullRequestInspectService } from './pull-request-inspect-service';
import type { PullRequestInspectScopeV1 } from './pull-request-inspect-service';
import { PULL_REQUEST_INSPECT_LIMITS } from './pull-request-inspect';
import { inspectDetail as detail, inspectDiff as diff, inspectQuery as query, inspectTarget as target } from './pull-request-inspect.test-fixture';

function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: PullRequestInspectScopeV1 = { repo: query.repo, epoch: 1, active: true, signal: activity.signal };
  const context = vi.fn(async () => Response.json({ repos: [query.repo] }));
  const response = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith('/diff') ? diff : detail));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' }); const url = new URL(String(input), 'http://localhost'); return url.pathname === '/api/context' ? context() : response(url); });
  const service = createHostPullRequestInspectService(lifetime.signal, { scope: () => scope, fetch: fetcher });
  return { lifetime, activity, context, response, fetcher, service, get scope() { return scope; }, set scope(value: PullRequestInspectScopeV1) { scope = value; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('scoped PR inspection host', () => {
  it('reads canonical detail and exact base/head diff through public GET routes', async () => {
    const f = fixture(); expect(await f.service.detail(query)).toEqual({ status: 'available', value: detail });
    expect(await f.service.diff({ version: 1, target })).toEqual({ status: 'available', value: diff });
    expect(Object.fromEntries(f.response.mock.calls[1]![0].searchParams)).toEqual({ repo: target.repo, number: String(target.number), headSha: target.headSha, baseSha: target.baseSha });
  });
  it('rejects widened and unconfigured galleons before provider transport', async () => {
    const f = fixture(); expect(await f.service.detail({ ...query, repo: 'other/project' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
    f.scope = { ...f.scope, repo: null }; f.context.mockResolvedValue(Response.json({ repos: [] })); expect(await f.service.detail(query)).toMatchObject({ reason: 'forbidden' }); expect(f.response).not.toHaveBeenCalled();
  });
  it.each(['caller', 'activity', 'lifetime'] as const)('cancels %s while transport ignores cancellation', async owner => {
    const f = fixture(); const caller = new AbortController(); f.response.mockImplementation(() => new Promise(() => {}));
    const pending = f.service.detail(query, caller.signal); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.response).toHaveBeenCalled()); (owner === 'caller' ? caller : f[owner]).abort(); await rejected;
  });
  it('fences activity changes and cancels a late response body', async () => {
    const f = fixture(); let finish!: (value: Response) => void; f.response.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.detail(query); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.response).toHaveBeenCalled()); f.scope = { ...f.scope, epoch: 2 }; const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel })));
    await rejected; expect(cancel).toHaveBeenCalled();
  });
  it.each([[403, 'forbidden'], [404, 'not-found'], [409, 'head-changed'], [409, 'selection-changed'], [502, 'invalid-response'], [503, 'service-unavailable'], [504, 'timeout']])('maps HTTP %s to %s without private errors', async (status, reason) => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ reason, error: 'token=private' }, { status: Number(status) }));
    expect(await f.service.detail(query)).toEqual({ status: 'unavailable', reason });
  });
  it('rejects mismatched identities, stream byte overflow and invalid UTF8', async () => {
    const f = fixture(); f.response.mockResolvedValue(Response.json({ ...diff, target: { ...target, headSha: 'c'.repeat(40) } }));
    expect(await f.service.diff({ version: 1, target })).toMatchObject({ reason: 'invalid-response' });
    f.response.mockResolvedValue(new Response('x'.repeat(PULL_REQUEST_INSPECT_LIMITS.responseBytes + 1))); expect(await f.service.detail(query)).toMatchObject({ reason: 'invalid-response' });
    f.response.mockResolvedValue(new Response(new Uint8Array([255]))); expect(await f.service.detail(query)).toMatchObject({ reason: 'invalid-response' });
  });
});
