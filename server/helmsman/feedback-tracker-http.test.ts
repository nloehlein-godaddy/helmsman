// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createFeedbackTrackerProviderHttp, type ResolvedFeedbackTrackerProviderConnection } from './feedback-tracker-http';
const pinned = { id: 'account-one', credentialHandle: 'github-primary', origin: 'https://api.github.com', subject: 'tester' };
const get = { method: 'GET' as const, path: '/user', query: {}, body: null };
function fixture(mutation = false) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ login: 'tester' }));
  const resolve = vi.fn<() => Promise<ResolvedFeedbackTrackerProviderConnection>>(async () => ({ ...pinned, headers: { Authorization: 'Bearer fixture-only' } }));
  const authorize = vi.fn(); const signal = new AbortController().signal;
  return { fetcher, resolve, authorize, http: createFeedbackTrackerProviderHttp({ connection: pinned, signal, mutation, resolve, authorize, fetcher, maxResponseBytes: 128, maxTransportBytes: 256 }) };
}
it.each(['https://evil.test/user', '//evil.test/user', '/repos/../user', '/repos/%2e%2e/user', '/user?token=secret', '/user#fragment', '/user\\other', '/user\n'])('rejects escaped or ambiguous paths before credentials reach HTTP: %s', async path => {
  const f = fixture(); await expect(f.http.request({ ...get, path })).rejects.toThrow(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('pins the origin, rejects redirects, and keeps authentication outside provider requests', async () => {
  const f = fixture(); await f.http.request(get);
  const [url, init] = f.fetcher.mock.calls[0]!; expect(String(url)).toBe('https://api.github.com/user'); expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-only'); expect(f.authorize).toHaveBeenCalledTimes(2);
  f.fetcher.mockRejectedValueOnce(new TypeError('redirect rejected')); await expect(f.http.request(get)).rejects.toThrow('redirect rejected'); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each(['id', 'credentialHandle', 'origin', 'subject'] as const)('rejects changed pinned connection %s before fetch', async key => {
  const f = fixture(); f.resolve.mockResolvedValueOnce({ ...pinned, [key]: 'changed', headers: {} }); await expect(f.http.request(get)).rejects.toThrow('Pinned'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('rejects mutation during preparation/reconciliation and rechecks authorization before HTTP', async () => {
  const f = fixture(); await expect(f.http.request({ ...get, method: 'POST', body: {} })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  const write = fixture(true); write.authorize.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('lease expired'); }); await expect(write.http.request({ ...get, method: 'POST', body: {} })).rejects.toThrow('lease expired'); expect(write.fetcher).not.toHaveBeenCalled();
});
it('bounds response bytes and rejects invalid JSON', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(129))); await expect(f.http.request(get)).rejects.toThrow('exceeds');
  const other = fixture(); other.fetcher.mockResolvedValueOnce(new Response('not-json')); await expect(other.http.request(get)).rejects.toThrow('invalid JSON');
});
