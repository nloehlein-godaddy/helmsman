import { describe, expect, it, vi } from 'vitest';
import { inspectQuery as query, inspectTarget as target } from '../pull-request-inspect.test-fixture';
import { githubPullRequestProvider } from './provider';
import { formatPullRequestReviewBody } from '@helmsman/plugin-sdk';

const review = (id: number, state: string, submittedAt = '2025-01-02T03:04:05.000Z', login = 'reviewer') => ({ id, state, user: { login }, submitted_at: submittedAt, commit_id: target.headSha });
const metadata = (overrides: Record<string, unknown> = {}) => ({ number: target.number, base: { sha: target.baseSha, repo: { full_name: target.repo } }, head: { sha: target.headSha, ref: 'work' }, state: 'open', draft: false, merged: false,
  user: { login: 'author' }, html_url: `https://github.com/${target.repo}/pull/${target.number}`, title: 'Pull request', updated_at: '2025-01-02T03:04:05.000Z', comments: 3,
  requested_reviewers: [{ login: 'reviewer' }], requested_teams: [], ...overrides });
const check = (id = 1) => ({ id, head_sha: target.headSha, status: 'completed', conclusion: 'success' });
const file = (name = 'a.ts') => ({ filename: name, status: 'modified', additions: 1, deletions: 1, patch: '+change' });
const comparison = (overrides: Record<string, unknown> = {}) => ({ url: `https://api.github.com/repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`,
  base_commit: { sha: target.baseSha }, merge_base_commit: { sha: target.baseSha }, total_commits: 1, files: [file()], ...overrides });
const listed = (number: number, overrides: Record<string, unknown> = {}) => ({ repository_url: `https://api.github.com/repos/${target.repo}`, number, title: `Pull request ${number}`,
  state: 'open', created_at: '2025-01-02T03:04:05.000Z', draft: false, comments: 3, requested_reviewers: [], requested_teams: [], ...overrides });

function context(request: (input: { method: 'GET' | 'POST'; path: string; query: Readonly<Record<string, string>>; body: unknown | null }) => Promise<{ status: number; body: unknown; link?: string }>) {
  return { signal: new AbortController().signal, configuredAuthor: 'reviewer', http: { request: vi.fn(request) } };
}

describe('exact review receipt reconciliation', () => {
  const input = { id: 'operation-1', contentHash: 'a'.repeat(64), repo: target.repo, number: target.number, headSha: target.headSha, actor: 'reviewer', event: 'COMMENT' as const, body: 'Reviewed' };
  const receipt = (id: number, body = formatPullRequestReviewBody(input)) => ({ ...review(id, 'COMMENTED'), body });
  const unrelated = () => Array.from({ length: 100 }, (_, i) => receipt(i + 1, 'Unrelated'));
  const path = `/repos/${target.repo}/pulls/${target.number}/reviews`;
  const link = (page: number) => `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next"`;
  function fixture(history: (page: number) => { status: number; body: unknown; link?: string }, actor = () => 'reviewer', head = () => target.headSha) {
    return context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === '/user') return { status: 200, body: { login: actor() } };
      if (request.path === path) return history(Number(request.query.page));
      return { status: 200, body: metadata({ head: { sha: head(), ref: 'work' } }) };
    });
  }

  it.each([true, false])('finds an exact receipt beyond the first 100 reviews with next link=%s', async hasLink => {
    const ctx = fixture(page => page === 1 ? { status: 200, body: unrelated(), ...(hasLink ? { link: link(2) } : {}) } : { status: 200, body: [receipt(101)] });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'acknowledged', receipt: { reviewId: 101, headSha: target.headSha } });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path).map(([request]) => request.query.page)).toEqual(['1', '2']);
  });

  it.each(['duplicate-marker', 'duplicate-id', 'malformed-page', 'failed-page', 'foreign-next-link', 'repeated-page'] as const)('preserves uncertainty for %s', async failure => {
    const first = [receipt(1), ...unrelated().slice(1)];
    const ctx = fixture(page => page === 1 ? { status: 200, body: first, link: failure === 'foreign-next-link' ? '<https://attacker.example/reviews?page=2>; rel="next"' : failure === 'repeated-page' ? link(1) : link(2) }
      : failure === 'failed-page' ? { status: 503, body: null } : { status: 200, body: failure === 'malformed-page' ? null : [receipt(failure === 'duplicate-id' ? 1 : 101)] });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'unknown' });
  });

  it('never acknowledges a partial bounded history even when it contains a matching marker', async () => {
    const ctx = fixture(page => ({ status: 200, body: [receipt(page * 100), ...Array.from({ length: 99 }, (_, index) => receipt(page * 100 + index + 1, 'Unrelated'))], link: link(page + 1) }));
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path)).toHaveLength(20);
  });

  it.each(['head-moved', 'merged', 'closed', 'actor-changed'] as const)('reconciles the original receipt after %s', async changed => {
    const ctx = context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === path) return { status: 200, body: [receipt(1)] };
      if (request.path === '/user') return { status: 200, body: { login: changed === 'actor-changed' ? 'replacement' : 'reviewer' } };
      return { status: 200, body: metadata(changed === 'head-moved' ? { head: { sha: 'b'.repeat(40), ref: 'work' } }
        : changed === 'merged' ? { state: 'closed', merged: true } : changed === 'closed' ? { state: 'closed' } : {}) };
    });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'acknowledged', receipt: { reviewId: 1, headSha: input.headSha, actor: input.actor } });
    expect(ctx.http.request.mock.calls.map(([request]) => request.path)).toEqual([path]);
  });

  it.each(['actor', 'head', 'body'] as const)('rejects a historical receipt with a mismatched %s', async changed => {
    const mismatched = { ...receipt(1), ...(changed === 'actor' ? { user: { login: 'replacement' } }
      : changed === 'head' ? { commit_id: 'b'.repeat(40) } : { body: 'Unrelated' }) };
    expect(await githubPullRequestProvider.reconcileReview!(input, fixture(() => ({ status: 200, body: [mismatched] })))).toMatchObject({ status: 'unknown' });
  });

  it.each(['head-moved', 'merged', 'actor-changed'] as const)('still refuses a new review after %s', async changed => {
    const ctx = context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === '/user') return { status: 200, body: { login: changed === 'actor-changed' ? 'replacement' : 'reviewer' } };
      return { status: 200, body: metadata(changed === 'head-moved' ? { head: { sha: 'b'.repeat(40), ref: 'work' } }
        : changed === 'merged' ? { state: 'closed', merged: true } : {}) };
    });
    expect(await githubPullRequestProvider.invokeReview!(input, ctx)).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('stops pagination when cancellation arrives without acknowledging or sending a review', async () => {
    const controller = new AbortController();
    const ctx = fixture(() => { controller.abort(); return { status: 200, body: [receipt(1)], link: link(2) }; });
    expect(await githubPullRequestProvider.reconcileReview!(input, { ...ctx, signal: controller.signal })).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path)).toHaveLength(1);
  });
});

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
      expect(input.query.q).toBe(`is:pr author:reviewer repo:${target.repo}`);
      return { status: 200, body: { total_count: 0, incomplete_results: false, items: [] } };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 100 }, repos: [target.repo] }, context(call));
    expect(result).toMatchObject({ quality: 'complete', items: [] });
    expect(call).toHaveBeenCalledOnce();
  });

  it('retains the recent authored window when search has more than three pages of history', async () => {
    const records = Array.from({ length: 100 }, (_, index) => listed(index + 1, { state: 'closed' }));
    const ctx = context(async input => {
      expect(input.path).toBe('/search/issues');
      expect(input.query.page).toBe('1');
      return { status: 200, body: { total_count: 395, incomplete_results: false, items: records },
        link: `<https://api.github.com/search/issues?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(50);
    expect(ctx.http.request).toHaveBeenCalledOnce();
  });

  it('falls back to scoped recent PRs when search rejects a readable private repository', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: { message: 'Validation failed' } };
      expect(input.path).toBe(`/repos/${target.repo}/pulls`);
      expect(input.query).toMatchObject({ state: 'all', sort: 'created', direction: 'desc' });
      return { status: 200, body: [listed(42, { user: { login: 'ReViewer' }, state: 'closed', merged_at: '2025-01-03T00:00:00.000Z' }),
        listed(43, { user: { login: 'someone-else' } }), listed(44, { user: null, state: 'closed' })] };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'complete', truncated: false, items: [{ number: 42, status: 'merged' }] });
    expect(result.items).toHaveLength(1);
    expect(result.browseUrl).toContain(`https://github.com/${target.repo}/pulls?q=`);
    expect(ctx.http.request).toHaveBeenCalledTimes(2);
  });

  it('preserves received authored matches when later fallback pages fail', async () => {
    const records = Array.from({ length: 25 }, (_, index) => listed(index + 1, { state: 'closed', user: { login: index < 3 ? 'reviewer' : 'other' } }));
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      if (input.query.page === '1') return { status: 200, body: records,
        link: `<https://api.github.com${input.path}?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
      return { status: 503, body: {} };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(3);
    expect(ctx.http.request).toHaveBeenCalledTimes(3);
  });

  it('bounds fallback payloads to25 rows and keeps matches after its six-page window', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      expect(input.query.per_page).toBe('25');
      const page = Number(input.query.page);
      expect(page).toBeLessThanOrEqual(6);
      return { status: 200, body: Array.from({ length: 25 }, (_, index) => listed(page * 25 + index, { state: 'closed', user: { login: index === 0 ? 'reviewer' : 'other' } })),
        link: `<https://api.github.com${input.path}?${new URLSearchParams({ ...input.query, page: String(page + 1) })}>; rel="next"` };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(6);
    expect(ctx.http.request).toHaveBeenCalledTimes(7);
  });

  it.each([true, false])('validates canonical repository pagination before continuing when identity matches=%s', matching => {
    const records = Array.from({ length: 25 }, (_, index) => listed(index + 1, { state: 'closed', user: { login: 'other' }, base: { repo: { id: 123, full_name: target.repo } } }));
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      expect(input.path).toBe(`/repos/${target.repo}/pulls`);
      if (input.query.page === '1') return { status: 200, body: records,
        link: `<https://api.github.com/repositories/${matching ? 123 : 999}/pulls?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
      return { status: 200, body: [listed(42, { state: 'closed', user: { login: 'reviewer' } })] };
    });
    return githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx).then(result => {
      expect(result.items).toHaveLength(matching ? 1 : 0);
      expect(ctx.http.request).toHaveBeenCalledTimes(matching ? 3 : 2);
    });
  });

  it('retains matches from an incomplete search without requesting unsafe pagination', async () => {
    const ctx = context(async input => {
      expect(input.path).toBe('/search/issues');
      return { status: 200, body: { total_count: 395, incomplete_results: true, items: [listed(42, { state: 'closed' })] } };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true, items: [{ number: 42 }] });
    expect(ctx.http.request).toHaveBeenCalledOnce();
  });

  it('bounds global fallback scans and keeps accessible galleons when another one fails', async () => {
    const repos = Array.from({ length: 10 }, (_, index) => `org/repo-${index}`);
    const ctx = context(async input => {
      if (input.path === '/search/issues') {
        expect(input.query.q).not.toContain('repo:org/repo-8');
        return { status: 422, body: {} };
      }
      if (input.path === '/repos/org/repo-1/pulls') return { status: 404, body: {} };
      const repo = input.path.slice('/repos/'.length, -'/pulls'.length);
      return { status: 200, body: [listed(42, { repository_url: `https://api.github.com/repos/${repo}`, state: 'closed', user: { login: 'reviewer' } })] };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 50 }, repos }, ctx);
    expect(result.quality).not.toBe('complete');
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(7);
    expect(ctx.http.request).toHaveBeenCalledTimes(16);
  });

  it('projects effective counts only for final visible authored open pull requests', async () => {
    const first = listed(42, { requested_reviewers: [{ login: 'alice' }, { login: 'ALICE' }], requested_teams: [{ slug: 'alice' }] }); const skipped = listed(43);
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 2, incomplete_results: false, items: [first, skipped] } };
      if (input.path === `/repos/${target.repo}/pulls/42/reviews`) return { status: 200, body: [
        review(1, 'APPROVED', '2025-01-01T00:00:00.000Z', 'alice'), review(2, 'COMMENTED', '2025-01-02T00:00:00.000Z', 'alice'),
        review(3, 'CHANGES_REQUESTED', '2025-01-03T00:00:00.000Z', 'bob'), review(4, 'COMMENTED', '2025-01-04T00:00:00.000Z', 'carol'),
        review(5, 'DISMISSED', '2025-01-05T00:00:00.000Z', 'dan'), review(6, 'APPROVED', '2025-01-06T00:00:00.000Z', 'dan'),
      ] };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 1 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ items: [{ number: 42, comments: 3, reviews: { approved: 2, changesRequested: 1, commented: 1, requested: 2 } }], quality: 'partial', truncated: true });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path.endsWith('/reviews')).map(([request]) => request.path)).toEqual([`/repos/${target.repo}/pulls/42/reviews`]);
  });

  it('reports zeros only for a complete empty authored open review history', async () => {
    const open = listed(42); const closed = listed(43, { state: 'closed' });
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 2, incomplete_results: false, items: [open, closed] } };
      if (input.path === `/repos/${target.repo}/pulls/42/reviews`) return { status: 200, body: [] };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 2 }, repos: [target.repo] }, ctx);
    expect(result.items).toMatchObject([{ number: 42, reviews: { approved: 0, changesRequested: 0, commented: 0, requested: 0 } }, { number: 43, reviews: null }]);
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path.endsWith('/reviews')).map(([request]) => request.path)).toEqual([`/repos/${target.repo}/pulls/42/reviews`]);
  });

  it('keeps authored pull requests when review histories are unavailable, malformed, or unsafe', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 3, incomplete_results: false, items: [listed(42), listed(43), listed(44)] } };
      if (input.path.endsWith('/42/reviews')) return { status: 503, body: null };
      if (input.path.endsWith('/43/reviews')) return { status: 200, body: [review(1, 'APPROVED'), review(1, 'CHANGES_REQUESTED')] };
      if (input.path.endsWith('/44/reviews')) return { status: 200, body: [review(2, 'APPROVED')], link: '<https://other.test/reviews?page=2>; rel="next"' };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 3 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'complete', items: [{ number: 42, comments: 3, reviews: null }, { number: 43, comments: 3, reviews: null }, { number: 44, comments: 3, reviews: null }] });
  });

  it('stops before scheduling queued authored review histories after cancellation', async () => {
    const controller = new AbortController(); let reviewCalls = 0;
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 5, incomplete_results: false, items: [42, 43, 44, 45, 46].map(number => listed(number)) } };
      if (input.path.endsWith('/reviews')) { reviewCalls++; if (reviewCalls === 4) controller.abort(); return { status: 200, body: [] }; }
      throw new Error(`Unexpected request: ${input.path}`);
    });
    await expect(githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 5 }, repos: [target.repo] }, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(reviewCalls).toBe(4);
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
