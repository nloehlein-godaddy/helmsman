import { describe, expect, it, vi } from 'vitest';
import { createPullRequestProviderHttp } from './pull-request-provider-http';

const connection = { id: 'github-connection', credentialHandle: 'github-primary', origin: 'https://api.github.com', subject: 'reviewer' };
const response = (body: unknown, status = 200) => Response.json(body, { status });
function fixture(overrides: Partial<Parameters<typeof createPullRequestProviderHttp>[0]> = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => response({ ok: true }));
  const authorize = vi.fn();
  const http = createPullRequestProviderHttp({ connection, signal: new AbortController().signal, mutation: false, fetcher, authorize,
    resolve: async () => ({ ...connection, headers: { Authorization: 'Bearer private-token' } }), ...overrides });
  return { http, fetcher, authorize };
}

describe('pull request provider HTTP', () => {
  it('permits paginated authenticated team reads without opening membership writes or other team APIs', async () => {
    const f = fixture({ mutation: true });
    await expect(f.http.request({ method: 'GET', path: '/user/teams', query: { page: '2', per_page: '100' }, body: null })).resolves.toMatchObject({ status: 200 });
    for (const path of ['/user/teams', '/user/teams/123', '/orgs/owner/teams', '/teams/123/members', '/user/memberships/teams/123']) {
      await expect(f.http.request({ method: 'POST', path, query: {}, body: {} })).rejects.toThrow('not permitted');
      if (path !== '/user/teams') await expect(f.http.request({ method: 'GET', path, query: {}, body: null })).rejects.toThrow('not permitted');
    }
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it('allows scoped repository identity, creator-filtered issues and immutable commit details without opening writes or mutable refs',async()=>{
    const f=fixture({mutation:true});
    for(const path of ['/repos/owner/repo','/repos/owner/repo/issues',`/repos/owner/repo/commits/${'a'.repeat(40)}`,`/repos/owner/repo/commits/${'b'.repeat(64)}`]) {
      await expect(f.http.request({method:'GET',path,query:{},body:null})).resolves.toMatchObject({status:200});
      await expect(f.http.request({method:'POST',path,query:{},body:{}})).rejects.toThrow('not permitted');
    }
    for(const path of ['/repos/owner/repo/commits/master',`/repos/owner/repo/commits/${'a'.repeat(41)}`,'/repositories/123/issues','/repos/owner/repo/issues/12']) await expect(f.http.request({method:'GET',path,query:{},body:null})).rejects.toThrow('not permitted');
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it('permits paginated comment reads without permitting comment writes or unrelated issue APIs', async () => {
    const f = fixture({ mutation: true });
    for (const path of ['/repos/owner/repo/issues/12/comments', '/repos/owner/repo/pulls/12/comments']) {
      await expect(f.http.request({ method: 'GET', path, query: { page: '2', per_page: '100' }, body: null })).resolves.toMatchObject({ status: 200 });
      await expect(f.http.request({ method: 'POST', path, query: {}, body: { body: 'unauthorized' } })).rejects.toThrow('not permitted');
    }
    for (const path of ['/repos/owner/repo/issues/12', '/repos/owner/repo/issues/comments', '/repos/owner/repo/pulls/comments',
      '/repos/owner/repo/issues/12/comments/7', '/repos/owner/repo/issues/../comments', '/repos/owner/repo/pulls/12/comments?token=secret']) {
      await expect(f.http.request({ method: 'GET', path, query: {}, body: null })).rejects.toThrow();
    }
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('pins the HTTPS origin and permits only bounded read paths during preparation or reconciliation', async () => {
    const f = fixture();
    await expect(f.http.request({ method: 'GET', path: '/repos/owner/repo/pulls/12', query: {}, body: null })).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(f.http.request({ method: 'GET', path: `/repos/owner/repo/commits/${'a'.repeat(40)}/check-runs`, query: {}, body: null })).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(f.http.request({ method: 'GET', path: `/repos/owner/repo/commits/${'a'.repeat(40)}/status`, query: {}, body: null })).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(f.fetcher).toHaveBeenCalledWith(new URL('https://api.github.com/repos/owner/repo/pulls/12'), expect.objectContaining({ method: 'GET', redirect: 'error' }));
    await expect(f.http.request({ method: 'GET', path: 'https://other.example/secret', query: {}, body: null })).rejects.toThrow('Invalid');
    await expect(f.http.request({ method: 'POST', path: '/repos/owner/repo/pulls/12/reviews', query: {}, body: {} })).rejects.toThrow('Invalid');
    expect(f.authorize).toHaveBeenCalledTimes(6);
  });

  it('requires the exact credential-backed identity before sending credentials', async () => {
    const f = fixture({ resolve: async () => ({ ...connection, subject: 'replaced', headers: { Authorization: 'Bearer private-token' } }) });
    await expect(f.http.request({ method: 'GET', path: '/user', query: {}, body: null })).rejects.toThrow('Pinned');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('accepts a contract-sized review body when JSON escaping expands it beyond 128 KiB', async () => {
    const f = fixture({ mutation: true });
    const body = '"'.repeat(64_000);
    await expect(f.http.request({ method: 'POST', path: '/repos/owner/repo/pulls/12/reviews', query: {}, body: { body } })).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('cancels an oversized response stream without exposing a partial body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; } });
    const f = fixture({ maxResponseBytes: 16, fetcher: vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 })) });
    await expect(f.http.request({ method: 'GET', path: '/user', query: {}, body: null })).rejects.toThrow('exceeds');
    expect(cancelled).toBe(true);
  });

  it('bounds aggregate provider transport after individually bounded reads', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ padding: 'x'.repeat(32) }));
    const f = fixture({ fetcher, maxResponseBytes: 64, maxTransportBytes: 64 });
    await expect(f.http.request({ method: 'GET', path: '/user', query: {}, body: null })).resolves.toEqual({ status: 200, body: { padding: 'x'.repeat(32) } });
    await expect(f.http.request({ method: 'GET', path: '/user', query: {}, body: null })).rejects.toThrow('transport');
    await expect(f.http.request({ method: 'GET', path: '/user', query: {}, body: null })).rejects.toThrow('budget');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
