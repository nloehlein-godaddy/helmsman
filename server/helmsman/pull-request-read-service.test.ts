import { describe, expect, it, vi } from 'vitest';
import { createPullRequestReadService } from './pull-request-read-service';
import { handlePullRequestReadApi } from './pull-request-read-routes';
import type { PullRequestProviderBatch } from './pull-request-read-service';
import { parsePullRequestReadPageV1, type PullRequestReadItemV1, type PullRequestReadQueryV1 } from '../../src/plugins/pull-request-read';

const repo = 'org/project';
const query: PullRequestReadQueryV1 = { version: 1, repo, kind: 'repo-open', limit: 25 };
const item: PullRequestReadItemV1 = { repo, number: 42, title: 'TASK-7 Work', url: 'https://provider.test/review/42', status: 'open', createdAt: '2026-09-20T12:00:00Z', mergedAt: null, draft: false, ticketId: 'TASK-7', reviewDecision: null, comments: null, reviews: null };
const batch: PullRequestProviderBatch = { items: [item], quality: 'complete', truncated: false, browseUrl: null };
function fixture() {
  let repos = [repo, 'org/other'];
  const read = vi.fn(async () => batch);
  const service = createPullRequestReadService({ repos: () => repos, read });
  return { service, read, set repos(value: string[]) { repos = value; } };
}

describe('pull request read provider boundary', () => {
  it('preserves SSO notices through sanitization, caching and caller limits', async () => {
    const read = vi.fn(async () => ({ ...batch, quality: 'partial' as const, notice: 'github-sso-required' as const }));
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => 'first' });
    expect((await service.list({ ...query, limit: 1 })).notice).toBe('github-sso-required');
    expect((await service.list(query)).notice).toBe('github-sso-required');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('preserves sanitized request origins through caching and caller limits', async () => {
    const reviewRequest = { direct: true, teams: [{ name: 'Builder developers', slug: 'builder-devs', secret: 'credential' }] };
    const read = vi.fn(async () => ({ ...batch, items: [{ ...item, reviewRequest }] }));
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => 'first' });
    const expected = { direct: true, teams: [{ name: 'Builder developers', slug: 'builder-devs' }] };
    expect((await service.list({ ...query, kind: 'review-requested', limit: 1 })).items[0]?.reviewRequest).toEqual(expected);
    expect((await service.list({ ...query, kind: 'review-requested' })).items[0]?.reviewRequest).toEqual(expected);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('invalidates completed and pending feedback after an acknowledged review', async () => {
    const read = vi.fn(async () => batch);
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => 'first' });
    await service.list(query); service.invalidate();
    let finish!: (value: PullRequestProviderBatch) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.list(query);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    service.invalidate(); finish(batch);
    await expect(pending).rejects.toMatchObject({ status: 409 });
    await service.list(query); expect(read).toHaveBeenCalledTimes(3);
  });
  it('reuses sanitized completed windows across caller limits and expires cached feedback', async () => {
    let now = 0;
    const read = vi.fn(async () => ({ ...batch, items: [item, { ...item, number: 43, secret: 'credential' }] }));
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => 'credential-and-provider-1', now: () => now });
    expect((await service.list({ ...query, limit: 1 })).items).toEqual([item]);
    expect((await service.list({ ...query, limit: 100 })).items).toEqual([item, { ...item, number: 43 }]);
    expect(read).toHaveBeenCalledTimes(1);
    now = 300_000;
    await service.list(query);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('separates credentials and providers and fences a connection changed during a shared read', async () => {
    let identity = 'first';
    const read = vi.fn(async () => batch);
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => identity });
    await service.list(query);
    identity = 'second';
    await service.list(query);
    expect(read).toHaveBeenCalledTimes(2);
    let finish!: (value: PullRequestProviderBatch) => void;
    identity = 'third';
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.list(query);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    identity = 'fourth'; finish(batch);
    await expect(pending).rejects.toMatchObject({ status: 409 });
    await service.list(query);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('retries degraded results quickly and never caches failed reads', async () => {
    let now = 0;
    const read = vi.fn<() => Promise<PullRequestProviderBatch>>().mockResolvedValue({ ...batch, quality: 'degraded' });
    const service = createPullRequestReadService({ repos: () => [repo], read, cacheIdentity: () => 'first', now: () => now });
    await service.list(query); await service.list(query); expect(read).toHaveBeenCalledTimes(1);
    now = 15_000;
    read.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(service.list(query)).rejects.toMatchObject({ status: 503 });
    await service.list(query); expect(read).toHaveBeenCalledTimes(3);
  });
  it('allowlists provider records, scopes before limits, and preserves unknown counts without exposing extra fields', async () => {
    const f = fixture(); f.read.mockResolvedValue({ ...batch, items: [{ ...item, repo: 'org/other' }, { ...item, secret: 'credential' } as PullRequestReadItemV1] });
    const result = await f.service.list({ ...query, limit: 1 });
    expect(result.items).toEqual([item]); expect(result.quality).toBe('complete'); expect(result.items[0]).not.toHaveProperty('secret');
  });
  it('requires concrete repo-open scope and rejects unconfigured scopes before providers', async () => {
    const f = fixture(); await expect(f.service.list({ ...query, repo: null })).rejects.toMatchObject({ status: 422 });
    await expect(f.service.list({ ...query, repo: 'private/project' })).rejects.toMatchObject({ status: 403 }); expect(f.read).not.toHaveBeenCalled();
  });
  it('supports configured-only authored history and preserves closed/merged states', async () => {
    const f = fixture(); f.read.mockResolvedValue({ ...batch, quality: 'partial', truncated: true, items: [{ ...item, status: 'merged', mergedAt: item.createdAt }, { ...item, number: 43, repo: 'org/other', status: 'closed' }, { ...item, number: 44, repo: 'private/project' }] });
    expect(await f.service.list({ ...query, repo: null, kind: 'authored-recent' })).toMatchObject({ quality: 'partial', items: [{ status: 'merged' }, { status: 'closed' }] });
  });
  it('normalizes shared provider reads to full windows while respecting each concurrent caller limit', async () => {
    const f = fixture(); let finish!: (batch: PullRequestProviderBatch) => void; f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = f.service.list({ ...query, limit: 1 }); const second = f.service.list({ ...query, limit: 100 });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    expect(f.read).toHaveBeenCalledWith({ ...query, limit: 100 }, [repo], expect.any(AbortSignal));
    finish({ ...batch, items: [item, { ...item, number: 43 }] });
    expect(await first).toMatchObject({ quality: 'partial', truncated: true, items: [item] }); expect((await second).items).toHaveLength(2);
  });
  it('cancels one subscriber without overlapping or aborting a shared provider operation', async () => {
    const f = fixture(); let finish!: (batch: PullRequestProviderBatch) => void; f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const caller = new AbortController(); const first = f.service.list(query, caller.signal); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1)); caller.abort(); await rejected;
    const second = f.service.list(query); finish(batch); expect(await second).toMatchObject({ items: [item] }); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('does not overlap abandoned provider reads after timeout', async () => {
    const read = vi.fn(() => new Promise<PullRequestProviderBatch>(() => {})); const service = createPullRequestReadService({ repos: () => [repo], read, timeoutMs: 2 });
    await expect(service.list(query)).rejects.toMatchObject({ status: 503 }); await expect(service.list(query)).rejects.toMatchObject({ status: 503 }); expect(read).toHaveBeenCalledTimes(1);
  });
  it('fences provider data after configured all-repository scope changes', async () => {
    const f = fixture(); let finish!: (batch: PullRequestProviderBatch) => void; f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.list({ ...query, repo: null, kind: 'authored-recent' }); await vi.waitFor(() => expect(f.read).toHaveBeenCalled()); f.repos = [repo]; finish(batch);
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });

});

describe('public pull request response validation and routes', () => {
  const page = { version: 1, repo, kind: 'repo-open', ...batch };
  it.each([{ ...item, url: 'javascript:alert(1)' }, { ...item, url: 'https://token@provider.test/pr/42' }, { ...item, number: 0 }, { ...item, comments: -1 }, { ...item, status: 'merged', mergedAt: null }, { ...item, repo: 'private/project' }])('rejects malformed or unsafe response records', value => {
    expect(() => parsePullRequestReadPageV1({ ...page, items: [value] }, query, [repo])).toThrow();
  });
  it('rejects duplicate PR identities, mismatched request bindings and contradictory completeness', () => {
    expect(() => parsePullRequestReadPageV1({ ...page, items: [item, item] }, query, [repo])).toThrow();
    expect(() => parsePullRequestReadPageV1({ ...page, kind: 'authored-recent' }, query, [repo])).toThrow();
    expect(() => parsePullRequestReadPageV1({ ...page, truncated: true }, query, [repo])).toThrow();
  });
  it('does not invoke accessor properties in protocol values', () => {
    const getter = vi.fn(() => 'secret'); const value = { ...item }; Object.defineProperty(value, 'title', { get: getter });
    expect(() => parsePullRequestReadPageV1({ ...page, items: [value] }, query, [repo])).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('serves only bounded GET reads and sanitizes provider failure details', async () => {
    const f = fixture(); const input = { method: 'GET', path: '/api/pull-request-read', query: new URLSearchParams({ repo }), service: f.service };
    expect(await handlePullRequestReadApi(input)).toMatchObject({ status: 200, json: { items: [item] } });
    expect(await handlePullRequestReadApi({ ...input, method: 'POST' })).toMatchObject({ status: 405 });
    expect(await handlePullRequestReadApi({ ...input, query: new URLSearchParams({ repo, limit: '101' }) })).toMatchObject({ status: 400 });
    f.read.mockRejectedValue(new Error('token=private')); expect(await handlePullRequestReadApi(input)).toEqual({ status: 503, json: { error: 'Pull request provider unavailable' } });
    expect(await handlePullRequestReadApi({ ...input, path: '/another-api' })).toBeNull();
  });
});

it('keeps cached open and all authored windows separate and forwards route selection',async()=>{
  const read=vi.fn(async(query:PullRequestReadQueryV1)=>({...batch,items:query.state==='open'?[item]:[{...item,status:'closed' as const}]}));
  const service=createPullRequestReadService({repos:()=>[repo],read,cacheIdentity:()=> 'same'});
  const input={method:'GET',path:'/api/pull-request-read',query:new URLSearchParams({repo,kind:'authored-recent',state:'open'}),service};
  expect(await handlePullRequestReadApi(input)).toMatchObject({status:200,json:{items:[{status:'open'}]}});
  expect(read.mock.calls[0]?.[0]).toMatchObject({state:'open'});
  expect(await handlePullRequestReadApi({...input,query:new URLSearchParams({repo,kind:'authored-recent',state:'all'})})).toMatchObject({status:200,json:{items:[{status:'closed'}]}});
  await handlePullRequestReadApi(input); expect(read).toHaveBeenCalledTimes(2);
  expect(await handlePullRequestReadApi({...input,query:new URLSearchParams({repo,kind:'authored-recent',state:'closed'})})).toMatchObject({status:400});
});
