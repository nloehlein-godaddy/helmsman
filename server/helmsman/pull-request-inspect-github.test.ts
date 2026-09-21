import { describe, expect, it, vi } from 'vitest';
import { createGithubPullRequestInspectProvider } from './pull-request-inspect-github';
import { PULL_REQUEST_INSPECT_LIMITS } from '../../src/plugins/pull-request-inspect';
import { inspectDetail as detail, inspectQuery as query, inspectTarget as target } from '../../src/plugins/pull-request-inspect.test-fixture';

const metadata = () => ({ number: target.number, title: detail.title, html_url: detail.url, state: 'open', merged: false, draft: false,
  user: { login: 'author' }, head: { sha: target.headSha, ref: detail.headRefName }, base: { sha: target.baseSha, repo: { full_name: target.repo } },
  updated_at: detail.updatedAt, comments: 3, requested_reviewers: [{ login: 'reviewer' }], requested_teams: [] });
const review = (id = 1) => ({ id, user: { login: 'author' }, state: 'APPROVED', submitted_at: detail.reviews.viewerReviewedAt, commit_id: target.headSha });
const check = (id = 1) => ({ id, head_sha: target.headSha, status: 'completed', conclusion: 'success' });
const file = (filename = 'source.ts') => ({ filename, status: 'modified', additions: 1, deletions: 0, patch: '+new' });
const comparison = () => ({ url: `https://api.github.com/repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`,
  base_commit: { sha: target.baseSha }, merge_base_commit: { sha: 'c'.repeat(40) }, total_commits: 4, files: [file()], commits: [{ sha: 'd'.repeat(40) }] });
function fixture() {
  let github = { token: 'private-token', author: 'author', repo: query.repo };
  const pull = vi.fn(async () => Response.json(metadata()));
  const reviews = vi.fn(async (_url: URL) => Response.json([review()]));
  const checks = vi.fn(async (_url: URL) => Response.json({ total_count: 1, check_runs: [check()] }));
  const statuses = vi.fn(async (_url: URL) => Response.json({ sha: target.headSha, total_count: 0, statuses: [] }));
  const compare = vi.fn(async () => Response.json(comparison()));
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer private-token' } });
    const url = new URL(String(input)); expect(url.origin).toBe('https://api.github.com');
    if (url.pathname.endsWith('/reviews')) return reviews(url);
    if (url.pathname.endsWith('/check-runs')) return checks(url);
    if (url.pathname.endsWith('/status')) return statuses(url);
    if (url.pathname.includes('/compare/')) return compare();
    return pull();
  });
  const provider = createGithubPullRequestInspectProvider({ github: () => github, fetch: fetcher, now: () => detail.observedAt });
  return { provider, fetcher, pull, reviews, checks, statuses, compare, set github(value: typeof github) { github = value; } };
}
describe('bounded GitHub PR inspection provider', () => {
  it('checks head and configured actor binding around detail subreads without publishing private fields', async () => {
    const f = fixture(); const value = await f.provider.detail(query, new AbortController().signal);
    expect(value).toMatchObject({ target, comments: 3, checks: { quality: 'complete', passed: 1, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 1, requested: 1, viewerReviewedCommitId: target.headSha } });
    expect(f.pull).toHaveBeenCalledTimes(2); expect(JSON.stringify(value)).not.toContain('private-token');
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes(`/commits/${target.headSha}/check-runs`))).toBe(true);
  });
  it('labels immutable comparison files complete independently of preview patch text and does not assume last commit is head', async () => {
    const f = fixture(); const value = await f.provider.diff({ version: 1, target }, new AbortController().signal);
    expect(value).toMatchObject({ target, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [{ patchStatus: 'preview' }] });
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/compare/${target.baseSha}...${target.headSha}?per_page=1&page=1`))).toBe(true);
  });
  it.each(['head', 'base'] as const)('rejects %s drift before or after diff delivery', async kind => {
    const f = fixture(); f.pull.mockImplementation(async () => Response.json({ ...metadata(), [kind]: { ...metadata()[kind], sha: 'e'.repeat(40) } }));
    await expect(f.provider.diff({ version: 1, target }, new AbortController().signal)).rejects.toMatchObject({ reason: 'head-changed' }); expect(f.compare).not.toHaveBeenCalled();
    f.pull.mockResolvedValueOnce(Response.json(metadata()));
    await expect(f.provider.diff({ version: 1, target }, new AbortController().signal)).rejects.toMatchObject({ reason: 'head-changed' });
  });
  it('rejects detail head drift and configured author/credential changes across awaits', async () => {
    const f = fixture(); f.pull.mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json({ ...metadata(), head: { ...metadata().head, sha: 'e'.repeat(40) } }));
    await expect(f.provider.detail(query, new AbortController().signal)).rejects.toMatchObject({ reason: 'head-changed' });
    const g = fixture(); g.checks.mockImplementation(async () => { g.github = { token: 'replaced', author: 'other', repo: query.repo }; return Response.json({ total_count: 0, check_runs: [] }); });
    await expect(g.provider.detail(query, new AbortController().signal)).rejects.toMatchObject({ reason: 'selection-changed' });
  });
  it.each([{ ...comparison(), url: 'https://api.github.com/repos/private/project/compare/main...work' },
    { ...comparison(), base_commit: { sha: 'e'.repeat(40) } }, { ...comparison(), files: null }])('rejects invalid comparison identity or enumeration', async value => {
    const f = fixture(); f.compare.mockResolvedValue(Response.json(value)); await expect(f.provider.diff({ version: 1, target }, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid-response' });
  });
  it('rejects cross-galleon metadata before any supplementary read', async () => {
    const f = fixture(); f.pull.mockResolvedValue(Response.json({ ...metadata(), base: { ...metadata().base, repo: { full_name: 'private/project' } } }));
    await expect(f.provider.detail(query, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid-response' }); expect(f.checks).not.toHaveBeenCalled(); expect(f.reviews).not.toHaveBeenCalled();
  });
  it('keeps failed subreads unknown rather than reporting successful zero counts', async () => {
    const f = fixture(); f.checks.mockResolvedValue(new Response(null, { status: 503 })); f.reviews.mockResolvedValue(new Response(null, { status: 403 }));
    const value = await f.provider.detail(query, new AbortController().signal);
    expect(value.checks).toEqual({ quality: 'unavailable', passed: null, failed: null, pending: null }); expect(value.reviews).toMatchObject({ quality: 'unavailable', approved: null, viewerReview: null, requested: null });
  });
  it('includes failing classic contexts alongside successful check runs', async () => {
    const f = fixture(); f.statuses.mockResolvedValue(Response.json({ sha: target.headSha, total_count: 2, statuses: [
      { id: 1, context: 'external-ci', state: 'failure', updated_at: detail.updatedAt }, { id: 2, context: 'deploy', state: 'pending', updated_at: detail.updatedAt }] }));
    expect((await f.provider.detail(query, new AbortController().signal)).checks).toEqual({ quality: 'complete', passed: 1, failed: 1, pending: 1 });
  });
  it('does not claim complete CI when classic status pagination is incomplete or response head mismatches', async () => {
    const f = fixture(); f.statuses.mockResolvedValue(Response.json({ sha: target.headSha, total_count: 2, statuses: [{ id: 1, context: 'ci', state: 'success', updated_at: detail.updatedAt }] }));
    expect((await f.provider.detail(query, new AbortController().signal)).checks).toEqual({ quality: 'partial', passed: null, failed: null, pending: null });
    f.statuses.mockResolvedValue(Response.json({ sha: 'e'.repeat(40), total_count: 0, statuses: [] }));
    expect((await f.provider.detail(query, new AbortController().signal)).checks.quality).toBe('unavailable');
  });
  it('does not double count context revisions when a paginated status observation shifts', async () => {
    const f = fixture(); f.statuses.mockResolvedValue(Response.json({ sha: target.headSha, total_count: 2, statuses: [
      { id: 1, context: 'ci', state: 'success', updated_at: detail.updatedAt }, { id: 2, context: 'ci', state: 'failure', updated_at: detail.observedAt }] }));
    expect((await f.provider.detail(query, new AbortController().signal)).checks).toEqual({ quality: 'partial', passed: null, failed: null, pending: null });
  });
  it('keeps cap-limited reviews and incomplete check enumerations partial with null counts', async () => {
    const f = fixture(); f.reviews.mockImplementation(async url => Response.json([review(Number(url.searchParams.get('page')))], { headers: { link: `<${url.origin}${url.pathname}?per_page=100&page=${Number(url.searchParams.get('page')) + 1}>; rel="next"` } }));
    f.checks.mockResolvedValue(Response.json({ total_count: 3, check_runs: [check()] }));
    const value = await f.provider.detail(query, new AbortController().signal);
    expect(f.reviews).toHaveBeenCalledTimes(3); expect(value.reviews).toMatchObject({ quality: 'partial', approved: null, viewerReview: null }); expect(value.checks).toMatchObject({ quality: 'partial', passed: null });
  });
  it('does not follow foreign pagination links or leak wrong-head check counts', async () => {
    const f = fixture(); f.reviews.mockResolvedValue(Response.json([review()], { headers: { link: '<https://private.test/token?page=2>; rel="next"' } }));
    f.checks.mockResolvedValue(Response.json({ total_count: 1, check_runs: [{ ...check(), head_sha: 'e'.repeat(40) }] }));
    const value = await f.provider.detail(query, new AbortController().signal); expect(value.reviews.quality).toBe('unavailable'); expect(value.checks.quality).toBe('unavailable'); expect(f.reviews).toHaveBeenCalledOnce();
  });
  it('invalidates review totals if metadata changes during the observation window', async () => {
    const f = fixture(); f.pull.mockResolvedValueOnce(Response.json(metadata())).mockResolvedValueOnce(Response.json({ ...metadata(), updated_at: detail.observedAt }));
    expect((await f.provider.detail(query, new AbortController().signal)).reviews).toMatchObject({ quality: 'partial', approved: null, requested: null });
  });
  it('preserves effective approvals when later comments exist while retaining latest viewer timestamp', async () => {
    const f = fixture(); f.reviews.mockResolvedValue(Response.json([review(), { ...review(2), state: 'COMMENTED', submitted_at: detail.updatedAt }]));
    expect((await f.provider.detail(query, new AbortController().signal)).reviews).toMatchObject({ quality: 'complete', approved: 1, commented: 0, viewerReview: 'APPROVED', viewerReviewedAt: detail.updatedAt });
  });
  it('discloses file caps and patch caps independently, preserving missing patches', async () => {
    const f = fixture(); const files = Array.from({ length: 300 }, (_, index) => ({ ...file(String(index)), patch: index === 0 ? undefined : 'x'.repeat(5000) }));
    f.compare.mockResolvedValue(Response.json({ ...comparison(), files })); const value = await f.provider.diff({ version: 1, target }, new AbortController().signal);
    expect(value).toMatchObject({ quality: 'partial', truncated: true }); expect(value.files).toHaveLength(100); expect(value.files[0]?.patchStatus).toBe('unavailable');
    expect(value.files.some(file => file.patchStatus === 'truncated')).toBe(true); expect(value.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0)).toBe(PULL_REQUEST_INSPECT_LIMITS.patches);
  });
  it('marks local patch clipping without falsely marking file enumeration partial', async () => {
    const f = fixture(); f.compare.mockResolvedValue(Response.json({ ...comparison(), files: [{ ...file(), patch: 'x'.repeat(PULL_REQUEST_INSPECT_LIMITS.patch + 1) }] }));
    expect(await f.provider.diff({ version: 1, target }, new AbortController().signal)).toMatchObject({ quality: 'complete', truncated: false, files: [{ patchStatus: 'truncated' }] });
  });
  it('cancels an uncooperative request and disposes late response bytes', async () => {
    const f = fixture(); const controller = new AbortController(); let finish!: (value: Response) => void; f.pull.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.provider.detail(query, controller.signal); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.pull).toHaveBeenCalled()); controller.abort(); await rejected;
    const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel }))); await vi.waitFor(() => expect(cancel).toHaveBeenCalled()); expect(f.checks).not.toHaveBeenCalled();
  });
  it('bounds provider bytes using UTF8 rather than character length', async () => {
    const f = fixture(); f.compare.mockResolvedValue(Response.json({ ...comparison(), extra: '😀'.repeat(600_000) }));
    await expect(f.provider.diff({ version: 1, target }, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid-response' });
  });
  it('bounds aggregate transport even when each independent response fits its byte limit', async () => {
    const f = fixture(); const padding = 'x'.repeat(1600 * 1024);
    const header = (url: URL): Record<string, string> => Number(url.searchParams.get('page')) < 3 ? { link: `<${url.origin}${url.pathname}?per_page=100&page=${Number(url.searchParams.get('page')) + 1}>; rel="next"` } : {};
    f.pull.mockImplementation(async () => Response.json({ ...metadata(), padding }));
    f.reviews.mockImplementation(async url => Response.json([{ ...review(Number(url.searchParams.get('page'))), padding }], { headers: header(url) }));
    f.checks.mockImplementation(async url => Response.json({ total_count: 3, check_runs: [{ ...check(Number(url.searchParams.get('page'))), padding }] }, { headers: header(url) }));
    f.statuses.mockImplementation(async () => Response.json({ sha: target.headSha, total_count: 0, statuses: [], padding }));
    await expect(f.provider.detail(query, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid-response' });
  });
});
