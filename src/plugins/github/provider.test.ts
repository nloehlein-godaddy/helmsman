import { describe, expect, it, vi } from 'vitest';
import { inspectQuery as query, inspectTarget as target } from '../pull-request-inspect.test-fixture';
import { githubPullRequestProvider } from './provider';

const review = (id: number, state: string, submittedAt = '2025-01-02T03:04:05.000Z') => ({ id, state, user: { login: 'reviewer' }, submitted_at: submittedAt, commit_id: target.headSha });
const metadata = (overrides: Record<string, unknown> = {}) => ({ number: target.number, base: { sha: target.baseSha, repo: { full_name: target.repo } }, head: { sha: target.headSha, ref: 'work' }, state: 'open', draft: false, merged: false,
  user: { login: 'author' }, html_url: `https://github.com/${target.repo}/pull/${target.number}`, title: 'Pull request', updated_at: '2025-01-02T03:04:05.000Z', comments: 3,
  requested_reviewers: [{ login: 'reviewer' }], requested_teams: [], ...overrides });
const check = (id = 1) => ({ id, head_sha: target.headSha, status: 'completed', conclusion: 'success' });
const file = (name = 'a.ts') => ({ filename: name, status: 'modified', additions: 1, deletions: 1, patch: '+change' });
const comparison = (overrides: Record<string, unknown> = {}) => ({ url: `https://api.github.com/repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`,
  base_commit: { sha: target.baseSha }, merge_base_commit: { sha: target.baseSha }, total_commits: 1, files: [file()], ...overrides });

function context(request: (input: { method: 'GET' | 'POST'; path: string; query: Readonly<Record<string, string>>; body: unknown | null }) => Promise<{ status: number; body: unknown; link?: string }>) {
  return { signal: new AbortController().signal, configuredAuthor: 'reviewer', http: { request: vi.fn(request) } };
}

describe('GitHub pull request provider', () => {
  it('projects bounded profile names using the public authenticated HTTP service', async () => {
    const ctx = context(async () => ({ status: 200, body: { name: ' Person ', login: ' person ', token: 'private' } }));
    expect(await githubPullRequestProvider.profile!(ctx)).toEqual({ displayName: 'Person', login: 'person' });
    expect(ctx.http.request).toHaveBeenCalledWith({ method: 'GET', path: '/user', query: {}, body: null });
    for (const body of [null, {}, [], { name: null, login: 123 }, { name: '\nbad', login: 'x'.repeat(129) }]) expect(await githubPullRequestProvider.profile!(context(async () => ({ status: 200, body })))).toEqual({ displayName: null, login: null });
    for (const name of [null, '', '   ', 42]) expect(await githubPullRequestProvider.profile!({ ...context(async () => ({ status: 200, body: { name, login: 'person' } })), configuredAuthor: undefined })).toEqual({ displayName: 'person', login: 'person' });
    expect(await githubPullRequestProvider.profile!(context(async () => ({ status: 403, body: null })))).toEqual({ displayName: null, login: null });
    expect(await githubPullRequestProvider.profile!(context(async () => { throw new Error('private'); }))).toEqual({ displayName: null, login: null });
  });
  it('does not replace profile cancellation with a fallback identity', async () => {
    const controller = new AbortController(); const ctx = context(async () => { controller.abort(); return { status: 200, body: { name: 'Person', login: 'person' } }; });
    await expect(githubPullRequestProvider.profile!({ ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses the configured author for lists without authenticating as that author', async () => {
    const call = vi.fn(async (input: { path: string; query: Readonly<Record<string, string>> }) => {
      expect(input.path).toBe('/search/issues');
      expect(input.query.q).toBe('is:pr author:reviewer');
      return { status: 200, body: { total_count: 0, incomplete_results: false, items: [] } };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 100 }, repos: [target.repo] }, context(call));
    expect(result).toMatchObject({ quality: 'complete', items: [] });
    expect(call).toHaveBeenCalledOnce();
  });

  it.each(['search', 'local'] as const)('handles concurrent review reads when %s fails first', async first => {
    let rejectSearch!: (reason: Error) => void;
    let rejectLocal!: (reason: Error) => void;
    const search = new Promise<{ status: number; body: unknown }>((_, reject) => { rejectSearch = reject; });
    const local = new Promise<{ status: number; body: unknown }>((_, reject) => { rejectLocal = reject; });
    const ctx = context(input => input.path === '/search/issues' ? search : local);
    const result = githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'review-requested', limit: 100 }, repos: [target.repo] }, ctx);
    const failures = first === 'search' ? [rejectSearch, rejectLocal] : [rejectLocal, rejectSearch];
    failures[0]!(new TypeError('fetch failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    failures[1]!(new TypeError('fetch failed'));
    await expect(result).resolves.toMatchObject({ quality: 'degraded', items: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ctx.http.request).toHaveBeenCalledTimes(2);
  });

  it('projects checks and effective viewer approval from the immutable PR observation', async () => {
    const result = await githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 1, check_runs: [check()] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [review(1, 'APPROVED'), review(2, 'COMMENTED', '2025-01-03T03:04:05.000Z')] };
      return { status: 200, body: metadata() };
    }));
    expect(result).toMatchObject({ target, isOwnPr: false, checks: { quality: 'complete', passed: 1, failed: 0, pending: 0 },
      reviews: { quality: 'complete', approved: 1, commented: 0, requested: 1, viewerReview: 'APPROVED', viewerReviewedAt: '2025-01-03T03:04:05.000Z' } });
  });

  it('rejects detail and diff when the observed revision or comparison identity changes', async () => {
    let metadataReads = 0;
    await expect(githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 0, check_runs: [] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [] };
      metadataReads++;
      return { status: 200, body: metadata(metadataReads === 2 ? { head: { sha: 'e'.repeat(40), ref: 'work' } } : {}) };
    }))).rejects.toMatchObject({ reason: 'head-changed' });
    await expect(githubPullRequestProvider.diff({ version: 1, target }, context(async input => input.path.includes('/compare/')
      ? { status: 200, body: comparison({ url: 'https://api.github.com/repos/other/repo/compare/a...b' }) }
      : { status: 200, body: metadata() }))).rejects.toThrow('Invalid GitHub comparison response');
  });

  it('does not claim complete quality for incomplete totals or unsafe pagination links', async () => {
    const partial = await githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 2, check_runs: [check()] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [], link: '<https://other.test/token?page=2>; rel="next"' };
      return { status: 200, body: metadata() };
    }));
    expect(partial.checks).toMatchObject({ quality: 'partial', passed: null });
    expect(partial.reviews).toMatchObject({ quality: 'unavailable', approved: null });
  });

  it('reports provider file caps independently from patch preview clipping', async () => {
    const files = Array.from({ length: 300 }, (_, index) => file(String(index)));
    files[1]!.patch = 'x'.repeat(40 * 1024);
    const result = await githubPullRequestProvider.diff({ version: 1, target }, context(async input => input.path.includes('/compare/')
      ? { status: 200, body: comparison({ files }) }
      : { status: 200, body: metadata() }));
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.files).toHaveLength(100);
    expect(result.files[1]).toMatchObject({ patchStatus: 'truncated' });
  });
});
