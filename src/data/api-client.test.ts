import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createApiClient } from './api-client';
import { apiCachePolicy } from './api-cache-policy';

const origin = 'http://localhost';
const path = '/api/run-read?repo=org%2Fproject&kind=all';
const json = (value: unknown) => Response.json(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.unstubAllGlobals());

describe('API read cache policy', () => {
  it.each(['/api/context', '/api/task-sources', '/api/config', '/api/profile', '/api/run-read/run/log', '/api/run-read/run', '/api/pull-request-inspect/detail', '/api/terminal/tabs', '/api/run-commands/receipts/id', '/api/task-sources/source/tasks?externalId=key', '/api/task-sources/source/tasks?key=ABC', '/api/task-sources/source/tasks?claim=true'])('leaves permission, action, live, and individual reads uncached: %s', value => {
    expect(apiCachePolicy(new URL(value, origin))).toBeNull();
  });
  it.each(['/api/pull-request-read', '/api/run-read', '/api/task-sources/source/tasks?repo=org%2Fproject&revision=1&limit=50', '/api/task-views-read/source/triage', '/api/task-views-read/source/bugs', '/api/activity-read/source', '/api/campaign-service/list', '/api/clarification-read', '/api/usage/v1', '/api/reports/outcomes/v1', '/api/pricing/v1'])('opts safe list reads into bounded retention: %s', value => {
    expect(apiCachePolicy(new URL(value, origin))).not.toBeNull();
  });
});

describe('shared API client', () => {
  it('keeps native HTTP response bodies readable after the shared flight settles', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"value":');
      setTimeout(() => response.end('1}'), 5);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP test address');
      const serverOrigin = `http://127.0.0.1:${address.port}`;
      const client = createApiClient({ origin: serverOrigin });
      const response = await client.fetch(`${serverOrigin}${path}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await response.json()).toEqual({ value: 1 });
      expect(await (await client.fetch(`${serverOrigin}${path}`)).json()).toEqual({ value: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('retains an authentication revocation update when an older generation update is already queued', async () => {
    let now = 0; let reads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/context' ? new Response(null, { status: 403 }) : json({ value: ++reads }));
    const queued: VoidFunction[] = [];
    const client = createApiClient({ fetch: fetcher, now: () => now, origin, schedule: callback => { queued.push(callback); } }); const changed = vi.fn();
    const scope = client.createReadScope(new AbortController().signal, changed);
    await scope.fetch(path);
    now = 6000; await scope.fetch(path);
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    await client.fetch('/api/context');
    expect(queued).toHaveLength(1);
    queued[0]?.();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes query order, retains separate contribution headers, and returns independent bodies', async () => {
    const fetcher = vi.fn(async () => json({ value: 1 }));
    const client = createApiClient({ fetch: fetcher, origin });
    expect(await (await client.fetch(path)).json()).toEqual({ value: 1 });
    expect(await (await client.fetch('/api/run-read?kind=all&repo=org%2Fproject')).json()).toEqual({ value: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.fetch(path, { headers: { 'X-Helmsman-Contribution': 'other/panel' } });
    await client.fetch(path, { credentials: 'omit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('never caches cross-origin or no-store reads', async () => {
    const fetcher = vi.fn(async () => json({ value: 1 })); const client = createApiClient({ fetch: fetcher, origin });
    for (let index = 0; index < 2; index++) {
      await client.fetch(`https://other.example${path}`); await client.fetch(path, { cache: 'no-store' }); await client.fetch('/api/context');
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('serves stale data immediately then refreshes only observing scopes with changed data', async () => {
    let now = 0; const next = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: 1 })).mockImplementationOnce(() => next.promise);
    const client = createApiClient({ fetch: fetcher, now: () => now, origin });
    const lifetime = new AbortController(); const changed = vi.fn(); const unrelated = vi.fn();
    const scope = client.createReadScope(lifetime.signal, changed); client.createReadScope(new AbortController().signal, unrelated);
    await scope.fetch(path); now = 5000;
    expect(await (await scope.fetch(path)).json()).toEqual({ value: 1 });
    expect(changed).not.toHaveBeenCalled();
    next.resolve(json({ value: 2 }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(unrelated).not.toHaveBeenCalled();
    expect(await (await scope.fetch(path)).json()).toEqual({ value: 2 });
  });

  it('does not notify for identical background data or force-refresh operations', async () => {
    let now = 0; const fetcher = vi.fn(async () => json({ value: 1 }));
    const client = createApiClient({ fetch: fetcher, now: () => now, origin }); const changed = vi.fn();
    const scope = client.createReadScope(new AbortController().signal, changed);
    await scope.fetch(path); now = 6000; await scope.fetch(path);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await scope.fresh(() => scope.fetch(path));
    expect(fetcher).toHaveBeenCalledTimes(3); expect(changed).not.toHaveBeenCalled();
  });

  it('aborts one subscriber independently while deduplicating a shared request', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn(() => pending.promise);
    const client = createApiClient({ fetch: fetcher, origin }); const abort = new AbortController();
    const first = client.fetch(path, { signal: abort.signal }); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.fetch(path); abort.abort(); await rejected;
    pending.resolve(json({ value: 1 }));
    expect(await (await second).json()).toEqual({ value: 1 }); expect(fetcher).toHaveBeenCalledTimes(1);
    await client.fetch(path); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retain a response after every subscriber has aborted', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(json({ value: 2 }));
    const client = createApiClient({ fetch: fetcher, origin }); const abort = new AbortController();
    const read = client.fetch(path, { signal: abort.signal }); const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort(); await rejected; pending.resolve(json({ value: 1 }));
    expect(await (await client.fetch(path)).json()).toEqual({ value: 2 }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fences late cache fills after invalidation while allowing active callers to finish', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(json({ value: 2 }));
    const client = createApiClient({ fetch: fetcher, origin });
    const first = client.fetch(path); client.invalidate(); pending.resolve(json({ value: 1 }));
    expect(await (await first).json()).toEqual({ value: 1 });
    expect(await (await client.fetch(path)).json()).toEqual({ value: 2 }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidates before and after real mutations but leaves read-only POST discovery uncached without invalidating lists', async () => {
    const fetcher = vi.fn(async () => json({ value: 1 })); const client = createApiClient({ fetch: fetcher, origin });
    await client.fetch(path);
    for (const read of ['/api/task-action/discover', '/api/task-edit/load', '/api/task-edit/create', '/api/task-edit/list', '/api/source-admin/validate', '/api/local-git/preview', '/api/terminal/screen', '/api/todo-legacy-recovery/receipt']) await client.fetch(read, { method: 'POST', body: '{}' });
    await client.fetch(path); expect(fetcher).toHaveBeenCalledTimes(9);
    await client.fetch('/api/run-commands', { method: 'POST', body: '{}' });
    await client.fetch(path); expect(fetcher).toHaveBeenCalledTimes(11);
  });

  it.each([401, 403, 404, 409])('evicts rejected stale data and notifies its consumer once for HTTP %s', async status => {
    let now = 0; const fetcher = vi.fn().mockResolvedValueOnce(json({ value: 1 })).mockImplementation(async () => new Response(null, { status }));
    const client = createApiClient({ fetch: fetcher, now: () => now, origin }); const changed = vi.fn();
    const scope = client.createReadScope(new AbortController().signal, changed);
    await scope.fetch(path); now = 6000; await scope.fetch(path);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect((await scope.fetch(path)).status).toBe(status); expect(changed).toHaveBeenCalledTimes(1);
  });

  it('skips malformed and oversized JSON without changing the returned response body', async () => {
    const oversized = JSON.stringify({ value: 'x'.repeat(4 * 1024 * 1024) });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(new Response('{')).mockImplementation(async () => new Response(oversized));
    const client = createApiClient({ fetch: fetcher, origin });
    expect(await (await client.fetch(path)).text()).toBe('{'); await client.fetch(path);
    expect(await (await client.fetch(path)).text()).toBe(oversized); await client.fetch(path);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('limits cache entry count and reclaims byte accounting on eviction and invalidation', async () => {
    const fetcher = vi.fn(async () => json({ value: 1 })); const client = createApiClient({ fetch: fetcher, origin });
    for (let index = 0; index < 65; index++) await client.fetch(`${path}&page=${index}`);
    await client.fetch(`${path}&page=64`); expect(fetcher).toHaveBeenCalledTimes(65);
    await client.fetch(`${path}&page=0`); expect(fetcher).toHaveBeenCalledTimes(66);
    client.reject(path); await client.fetch(`${path}&page=64`); expect(fetcher).toHaveBeenCalledTimes(67);
  });

  it('bounds retained response bytes to sixteen MiB independently of the entry count', async () => {
    const value = { payload: 'x'.repeat(1024 * 1024) };
    const fetcher = vi.fn(async () => json(value)); const client = createApiClient({ fetch: fetcher, origin });
    for (let index = 0; index < 16; index++) await client.fetch(`${path}&page=${index}`);
    await client.fetch(`${path}&page=15`); expect(fetcher).toHaveBeenCalledTimes(16);
    await client.fetch(`${path}&page=0`); expect(fetcher).toHaveBeenCalledTimes(17);
    client.invalidate();
    await client.fetch(`${path}&page=15`); expect(fetcher).toHaveBeenCalledTimes(18);
  });

  it('times out a stalled eligible read even when its transport ignores cancellation', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const client = createApiClient({ fetch: fetcher, origin, timeoutMs: 10 });
    await expect(client.fetch(path)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('uses the network after the maximum stale age instead of returning expired data', async () => {
    let now = 0; const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: 1 })).mockImplementationOnce(() => pending.promise);
    const client = createApiClient({ fetch: fetcher, now: () => now, origin });
    await client.fetch(path); now = 60_000;
    const next = client.fetch(path); pending.resolve(json({ value: 2 }));
    expect(await (await next).json()).toEqual({ value: 2 });
  });

  it('prevents callbacks after scope disposal and preserves a Request subscriber signal', async () => {
    let now = 0; const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: 1 })).mockImplementationOnce(() => pending.promise);
    const client = createApiClient({ fetch: fetcher, now: () => now, origin }); const changed = vi.fn(); const lifetime = new AbortController();
    const scope = client.createReadScope(lifetime.signal, changed); await scope.fetch(path); now = 6000; await scope.fetch(path); lifetime.abort(); pending.resolve(json({ value: 2 }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(changed).not.toHaveBeenCalled();
    const subscriber = new AbortController(); subscriber.abort();
    await expect(client.createReadScope(new AbortController().signal, vi.fn()).fetch(new Request(`${origin}${path}`, { signal: subscriber.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isolates snapshots when the default global fetch implementation changes', async () => {
    const first = vi.fn(async () => json({ value: 1 })); vi.stubGlobal('fetch', first);
    const client = createApiClient({ origin }); await client.fetch(path);
    const second = vi.fn(async () => json({ value: 2 })); vi.stubGlobal('fetch', second);
    expect(await (await client.fetch(path)).json()).toEqual({ value: 2 }); expect(second).toHaveBeenCalledTimes(1);
  });
});
