import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubConnectionCheck, createIntegrationStatusService, handleIntegrationStatusApi } from './integration-status';

function fixture() {
  let revision = 'first';
  let now = Date.parse('2026-10-09T00:00:00Z');
  const jira = vi.fn(async () => 'available' as const);
  const github = vi.fn(async () => 'not-configured' as const);
  const service = createIntegrationStatusService({ repos: () => ['org/a', 'org/b'], revision: () => revision, jira, github, now: () => now });
  return { service, jira, github, change: () => { revision = 'next'; }, advance: () => { now += 30_001; } };
}
afterEach(() => vi.useRealTimers());

describe('integration status snapshots', () => {
  it('reports checks separately without exposing credentials or upstream errors', async () => {
    const f = fixture();
    f.jira.mockRejectedValue(new Error('secret-token; private upstream response'));
    expect(await f.service.snapshot('org/a')).toEqual({ version: 1, repo: 'org/a', jira: 'unavailable', github: 'not-configured', checkedAt: '2026-10-09T00:00:00.000Z' });
  });

  it('deduplicates concurrent checks, reuses short-lived results, and invalidates by scope and revision', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.service.snapshot('org/a'), f.service.snapshot('org/a')]);
    expect(second).toEqual(first);
    expect(f.jira).toHaveBeenCalledTimes(1);
    await f.service.snapshot('org/a');
    expect(f.jira).toHaveBeenCalledTimes(1);
    await f.service.snapshot('org/b');
    expect(f.jira).toHaveBeenCalledTimes(2);
    f.change();
    await f.service.snapshot('org/a');
    expect(f.jira).toHaveBeenCalledTimes(3);
    f.advance();
    await f.service.snapshot('org/a');
    expect(f.jira).toHaveBeenCalledTimes(4);
  });

  it('fails closed if credentials change while a check is pending', async () => {
    const f = fixture();
    let resolve: ((value: 'available') => void) | undefined;
    f.jira.mockImplementation(() => new Promise(done => { resolve = done; }));
    const request = f.service.snapshot('org/a');
    await Promise.resolve();
    f.change();
    resolve?.('available');
    expect(await request).toMatchObject({ jira: 'unknown', github: 'unknown' });
  });

  it('bounds checks even when a provider ignores cancellation', async () => {
    vi.useFakeTimers();
    const service = createIntegrationStatusService({ repos: () => ['org/a'], revision: () => 'stable', timeoutMs: 100,
      jira: () => new Promise(() => {}), github: async () => 'available' });
    const request = service.snapshot('org/a');
    await vi.advanceTimersByTimeAsync(101);
    expect(await request).toMatchObject({ jira: 'unavailable', github: 'available' });
  });

  it('rejects unknown, malformed, duplicated, and unexpected scopes before making remote requests', async () => {
    const f = fixture();
    for (const query of ['repo=other/repo', 'repo=invalid', 'repo=org/a&repo=org/b', 'token=secret']) {
      expect(await handleIntegrationStatusApi({ service: f.service, method: 'GET', path: '/api/integration-status', query: new URLSearchParams(query) })).toMatchObject({ status: 400 });
    }
    expect(f.jira).not.toHaveBeenCalled();
    expect(await handleIntegrationStatusApi({ service: f.service, method: 'POST', path: '/api/integration-status', query: new URLSearchParams() })).toMatchObject({ status: 405 });
  });
});

describe('GitHub connection checks', () => {
  function github(responses: readonly { status: number; body: unknown }[], token: string | null = 'fake-token') {
    const fetcher = vi.fn<typeof fetch>();
    for (const item of responses) fetcher.mockResolvedValueOnce(Response.json(item.body, { status: item.status }));
    return { fetcher, check: createGithubConnectionCheck({ token: () => token, fetcher }) };
  }
  it('requires successful authentication and scoped pull request access, even when the list is empty', async () => {
    const f = github([{ status: 200, body: { login: 'person' } }, { status: 200, body: [] }]);
    expect(await f.check('org/a', AbortSignal.timeout(1000))).toBe('available');
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://api.github.com/user', 'https://api.github.com/repos/org/a/pulls?per_page=1&state=open']);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each([401, 403, 404])('does not claim healthy scoped access after HTTP %s', async status => {
    const f = github([{ status: 200, body: { login: 'person' } }, { status, body: { message: 'Private upstream error' } }]);
    expect(await f.check('org/a', AbortSignal.timeout(1000))).toBe('unavailable');
  });
  it('does not interpret configured tokens as authenticated or fetch without credentials', async () => {
    const missing = github([], null);
    expect(await missing.check(null, AbortSignal.timeout(1000))).toBe('not-configured');
    expect(missing.fetcher).not.toHaveBeenCalled();
    const rejected = github([{ status: 401, body: { message: 'Bad credentials' } }]);
    expect(await rejected.check(null, AbortSignal.timeout(1000))).toBe('unavailable');
    const invalid = github([{ status: 200, body: {} }]);
    expect(await invalid.check(null, AbortSignal.timeout(1000))).toBe('unavailable');
  });
});
