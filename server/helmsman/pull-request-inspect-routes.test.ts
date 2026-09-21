import { describe, expect, it, vi } from 'vitest';
import { handlePullRequestInspectApi } from './pull-request-inspect-routes';
import { createPullRequestInspectService, PullRequestInspectError } from './pull-request-inspect-service';
import { inspectDetail as detail, inspectDiff as diff, inspectQuery as query, inspectTarget as target } from '../../src/plugins/pull-request-inspect.test-fixture';

describe('PR inspection public routes', () => {
  const provider = { detail: vi.fn(async () => detail), diff: vi.fn(async () => diff) };
  const service = createPullRequestInspectService({ repos: () => [query.repo], provider });
  const input = { method: 'GET', path: '/api/pull-request-inspect/detail', query: new URLSearchParams({ repo: query.repo, number: String(query.number) }), service };
  it('serves bounded detail and immutable comparison reads only through GET', async () => {
    expect(await handlePullRequestInspectApi(input)).toEqual({ status: 200, json: detail });
    expect(await handlePullRequestInspectApi({ ...input, path: '/api/pull-request-inspect/diff', query: new URLSearchParams({ repo: target.repo, number: String(target.number), headSha: target.headSha, baseSha: target.baseSha }) })).toEqual({ status: 200, json: diff });
    expect(await handlePullRequestInspectApi({ ...input, method: 'POST' })).toMatchObject({ status: 405 });
    expect(await handlePullRequestInspectApi({ ...input, path: '/api/pr' })).toBeNull();
  });
  it('rejects malformed input and reports missing services without provider details', async () => {
    for (const number of ['0', '1.5', 'Infinity', '9007199254740992']) expect(await handlePullRequestInspectApi({ ...input, query: new URLSearchParams({ repo: query.repo, number }) })).toMatchObject({ status: 400 });
    expect(await handlePullRequestInspectApi({ ...input, service: undefined })).toEqual({ status: 503, json: { reason: 'service-unavailable' } });
    expect(await handlePullRequestInspectApi({ ...input, query: new URLSearchParams('repo=org/project&number=42&number=43') })).toMatchObject({ status: 400 });
    expect(await handlePullRequestInspectApi({ ...input, query: new URLSearchParams('repo=org/project&number=42&token=private') })).toMatchObject({ status: 400 });
  });
  it('retains known typed failure reasons and sanitizes unexpected provider errors', async () => {
    provider.detail.mockRejectedValueOnce(new PullRequestInspectError(409, 'head-changed')); expect(await handlePullRequestInspectApi(input)).toEqual({ status: 409, json: { reason: 'head-changed' } });
    provider.detail.mockRejectedValueOnce(new Error('credential=/private')); expect(await handlePullRequestInspectApi(input)).toEqual({ status: 503, json: { reason: 'service-unavailable' } });
  });
});
