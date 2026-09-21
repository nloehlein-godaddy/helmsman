import { describe, expect, it, vi } from 'vitest';
import type { SourceMutationHttpV1 } from '../../src/plugins/tasks';
import { createSourceHttp, type ResolvedSourceHttpConnection } from './task-source-http';

const connection = { id: 'connection', credentialHandle: 'credential', origin: 'https://tenant.example', subject: 'account-1', authorityId: 'tenant-1' };
function setup(overrides: Partial<Parameters<typeof createSourceHttp>[0]> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"100"}', { status: 200 }));
  const resolve = vi.fn(async (): Promise<ResolvedSourceHttpConnection> => ({ ...connection, headers: { Authorization: 'Bearer private' } }));
  const authorize = vi.fn();
  const controller = new AbortController();
  const http = createSourceHttp({ connection, signal: controller.signal, resolve, authorize, fetcher, ...overrides });
  return { http, fetcher, resolve, authorize, controller };
}

describe('source connection HTTP capabilities', () => {
  it('exposes only the allowlisted semantic count query without arbitrary POST or mutation access', async () => {
    const { http, fetcher, authorize } = setup({ readQueries: ['jira.approximate-count/v1'] });
    expect('send' in http).toBe(false);
    await http.query!({ id: 'jira.approximate-count/v1', input: { jql: 'project = TASK' } });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://tenant.example/rest/api/3/search/approximate-count');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', body: '{"jql":"project = TASK"}' });
    expect(authorize).toHaveBeenCalledTimes(2);
    for (const value of [{ id: 'jira.transition/v1', input: { jql: 'project = TASK' } },
      { id: 'jira.approximate-count/v1', input: { jql: 'project = TASK', path: '/issue/1' } },
      { id: 'jira.approximate-count/v1', input: { jql: '' } },
      { id: 'jira.approximate-count/v1', input: { jql: 'x\nmutation' } }]) {
      await expect(http.query!(value as Parameters<NonNullable<typeof http.query>>[0])).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledOnce(); expect(setup().http.query).toBeUndefined();
  });
  it('scopes read requests and keeps credentials outside returned data', async () => {
    const { http, fetcher, authorize } = setup();
    expect('send' in http).toBe(false);
    expect(await http.get({ path: '/rest/api/3/issue/100', query: { fields: 'status,assignee' } })).toEqual({ status: 200, body: { id: '100' } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://tenant.example/rest/api/3/issue/100?fields=status%2Cassignee');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private');
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it.each(['https://other.example', '//other.example/x', '/a/../x', '/%2e%2e/x', '/x?secret=y', '/x#fragment', '/x\\y', '/x%2fy', '/x%5cy', '/x%00'])('rejects escaping or ambiguous path %s before credentials resolve', async path => {
    const { http, resolve, fetcher } = setup();
    await expect(http.get({ path, query: {} })).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['id', 'credentialHandle', 'origin', 'subject', 'authorityId'] as const)('rejects changed pinned %s even with working credentials', async key => {
    const { http, fetcher } = setup({ resolve: async () => ({ ...connection, [key]: 'changed', headers: { Authorization: 'Bearer rotated' } }) });
    await expect(http.get({ path: '/issue/100', query: {} })).rejects.toThrow('Pinned');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks operation authorization after asynchronous credential preparation', async () => {
    let allowed = true;
    const { http, fetcher } = setup({ mutation: true,
      resolve: async () => { allowed = false; return { ...connection, headers: { Authorization: 'Bearer private' } }; },
      authorize: () => { if (!allowed) throw new Error('Operation no longer authorized'); },
    });
    await expect((http as SourceMutationHttpV1).send({ method: 'PUT', path: '/issue/100/assignee', body: { accountId: 'account-1' } })).rejects.toThrow('no longer authorized');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not deliver a write after cancellation while credentials resolve', async () => {
    const controller = new AbortController();
    const { http, fetcher } = setup({ signal: controller.signal, mutation: true,
      resolve: async () => { controller.abort(); return { ...connection, headers: {} }; },
    });
    await expect((http as SourceMutationHttpV1).send({ method: 'POST', path: '/issue/100/transitions', body: { transition: { id: '1' } } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds streaming responses and cancels the reader', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(30))); }, cancel });
    const { http } = setup({ maxResponseBytes: 20, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)) });
    await expect(http.get({ path: '/issue/100', query: {} })).rejects.toThrow('exceeds');
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts empty mutation acknowledgments and keeps non-2xx status observable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response('{"error":"denied"}', { status: 403 }));
    const { http } = setup({ mutation: true, fetcher });
    expect(await (http as SourceMutationHttpV1).send({ method: 'PUT', path: '/issue/100/assignee', body: { accountId: 'account-1' } })).toEqual({ status: 204, body: null });
    expect(await http.get({ path: '/issue/100', query: {} })).toEqual({ status: 403, body: { error: 'denied' } });
  });
});
