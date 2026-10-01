// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { githubPullRequestProvider } from './provider';
import { fingerprintPullRequestFeedbackSnapshotV1, PULL_REQUEST_FEEDBACK_LIMITS, type PullRequestHttpV1 } from '@helmsman/plugin-sdk';

const query = { version: 1 as const, repo: 'org/project', number: 42 };
const url = 'https://github.com/org/project/pull/42';
const date = '2026-09-30T10:00:00Z';
const metadata = { number: 42, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: query.repo } },
  head: { sha: 'a'.repeat(40), ref: 'fix/feedback' }, state: 'open', merged: false, body: 'Description', html_url: url, updated_at: date };
const review = { id: 20, html_url: `${url}#pullrequestreview-20`, body: 'Review findings', state: 'CHANGES_REQUESTED', submitted_at: date };
const comment = { id: 30, html_url: `${url}#issuecomment-30`, body: 'Edited summary', updated_at: date };
const inline = { id: 40, html_url: `${url}#discussion_r40`, body: 'Resolved/outdated findings', updated_at: date };
type Request = Parameters<PullRequestHttpV1['request']>[0];
type Response = Awaited<ReturnType<PullRequestHttpV1['request']>>;
function fixture(options: { before?: unknown; after?: unknown; reviews?: unknown[][]; comments?: unknown[][]; inline?: unknown[][];
  alter?: (request: Request, response: Response) => Response } = {}) {
  let metadataCalls = 0;
  const request = vi.fn<PullRequestHttpV1['request']>(async input => {
    expect(input.method).toBe('GET'); expect(input.body).toBeNull();
    let response: Response;
    if (input.path === '/repos/org/project/pulls/42') {
      metadataCalls++;
      response = { status: 200, body: metadataCalls === 1 ? options.before ?? metadata : options.after ?? options.before ?? metadata };
    } else {
      const pages = input.path.endsWith('/reviews') ? options.reviews ?? [[review]]
        : input.path === '/repos/org/project/issues/42/comments' ? options.comments ?? [[comment]]
          : input.path === '/repos/org/project/pulls/42/comments' ? options.inline ?? [[inline]] : null;
      if (!pages) throw new Error(`Unexpected provider request ${input.path}`);
      const page = Number(input.query.page);
      expect(input.query.per_page).toBe('100');
      response = { status: 200, body: pages[page - 1] ?? [], ...(page < pages.length
        ? { link: `<https://api.github.com${input.path}?per_page=100&page=${page + 1}>; rel="next"` } : {}) };
    }
    return options.alter?.(input, response) ?? response;
  });
  const controller = new AbortController();
  const context = { signal: controller.signal, http: { request } };
  return { request, controller, collect: () => githubPullRequestProvider.feedbackSnapshot!(query, context) };
}

describe('GitHub full feedback snapshots', () => {
  it('captures every discussion page, pending reviews, full bodies and inline reply relationships without global identity', async () => {
    const body = `${'unchanged full body\n'.repeat(5000)}END`;
    const f = fixture({ comments: [[comment], [{ ...comment, id: 31, html_url: `${url}#issuecomment-31`, body }]],
      reviews: [[review], [{ ...review, id: 21, html_url: `${url}#pullrequestreview-21`, state: 'PENDING', submitted_at: null, body: '' }]],
      inline: [[inline], [{ ...inline, id: 41, html_url: `${url}/files#discussion_r41`, in_reply_to_id: 40 }]] });
    const snapshot = await f.collect();
    expect(snapshot).toMatchObject({ version: 1, quality: 'complete', repo: query.repo, prNumber: 42, headBranch: 'fix/feedback', baseBranch: 'main', state: 'OPEN' });
    expect(snapshot.sources.map(source => source.id)).toEqual(['comment:30', 'comment:31', 'description:42', 'inline:40', 'inline:41', 'review:20', 'review:21']);
    expect(snapshot.sources.find(source => source.id === 'comment:31')?.body).toBe(body);
    expect(snapshot.sources.find(source => source.id === 'inline:41')?.replyTo).toBe('inline:40');
    expect(snapshot.sources.find(source => source.id === 'review:21')).toMatchObject({ state: 'PENDING', submittedAt: null, updatedAt: date });
    expect(snapshot.fingerprint).toBe(await fingerprintPullRequestFeedbackSnapshotV1(snapshot));
    expect(f.request).toHaveBeenCalledTimes(8);
  });

  it('reads beyond preview limits and conservatively follows full pages without next links', async () => {
    const comments = Array.from({ length: 4 }, (_, page) => Array.from({ length: page === 3 ? 1 : 100 }, (_, index) => {
      const id = page * 100 + index + 1; return { ...comment, id, html_url: `${url}#issuecomment-${id}` };
    }));
    const f = fixture({ comments, alter: (_input, response) => ({ status: response.status, body: response.body }) });
    expect((await f.collect()).sources.filter(source => source.kind === 'comment')).toHaveLength(301);
    expect(f.request.mock.calls.filter(([input]) => input.path.includes('/issues/')).map(([input]) => input.query.page)).toEqual(['1', '2', '3', '4']);
  });

  it('keeps fingerprints stable across page order and changes them for edited summaries, review edits and dismissals', async () => {
    const second = { ...comment, id: 31, html_url: `${url}#issuecomment-31` };
    expect((await fixture({ comments: [[comment], [second]] }).collect()).fingerprint)
      .toBe((await fixture({ comments: [[second, comment]] }).collect()).fingerprint);
    const original = await fixture().collect();
    for (const options of [{ comments: [[{ ...comment, body: 'New finding inside old summary' }]] },
      { reviews: [[{ ...review, body: 'Edited review' }]] }, { reviews: [[{ ...review, state: 'DISMISSED' }]] }]) {
      expect((await fixture(options).collect()).fingerprint).not.toBe(original.fingerprint);
    }
  });

  it('keeps the description for a PR with no body or discussion', async () => {
    const snapshot = await fixture({ before: { ...metadata, body: null }, comments: [[]], reviews: [[]], inline: [[]] }).collect();
    expect(snapshot.sources).toHaveLength(1); expect(snapshot.sources[0]?.body).toBe('');
  });

  it.each([{ head: { ...metadata.head, sha: 'c'.repeat(40) } }, { base: { ...metadata.base, sha: 'd'.repeat(40) } },
    { head: { ...metadata.head, ref: 'other' } }, { base: { ...metadata.base, ref: 'release' } },
    { body: 'Changed description' }, { state: 'closed', merged: true }, { updated_at: '2026-09-30T11:00:00Z' }])(
    'rejects metadata changes during collection: %j', async patch => {
      await expect(fixture({ after: { ...metadata, ...patch } }).collect()).rejects.toMatchObject({ reason: 'head-changed' });
    });

  it.each(['foreign-link', 'malformed-link', 'repeated-page', 'duplicate-id', 'malformed-page', 'failed-page'] as const)('rejects %s rather than returning partial evidence', async failure => {
    const f = fixture({ comments: [[comment], [comment]], alter: (input, response) => {
      if (!input.path.includes('/issues/')) return response;
      if (failure === 'foreign-link') return { ...response, link: '<https://other.test/comments?page=2>; rel="next"' };
      if (failure === 'malformed-link') return { ...response, link: 'malformed pagination' };
      if (failure === 'repeated-page') return { ...response, link: `<https://api.github.com${input.path}?per_page=100&page=1>; rel="next"` };
      if (input.query.page === '2' && failure === 'malformed-page') return { status: 200, body: null };
      if (input.query.page === '2' && failure === 'failed-page') return { status: 403, body: {} };
      return response;
    } });
    await expect(f.collect()).rejects.toThrow();
  });

  it('fails closed when discussion exceeds its pagination bound', async () => {
    const f = fixture({ alter: (input, response) => input.path.includes('/issues/') ? { status: 200,
      body: [{ ...comment, id: Number(input.query.page), html_url: `${url}#issuecomment-${input.query.page}` }],
      link: `<https://api.github.com${input.path}?per_page=100&page=${Number(input.query.page) + 1}>; rel="next"` } : response });
    await expect(f.collect()).rejects.toThrow('pagination is incomplete');
    expect(f.request.mock.calls.filter(([input]) => input.path.includes('/issues/'))).toHaveLength(PULL_REQUEST_FEEDBACK_LIMITS.pages);
  });

  it.each([{ body: null }, { id: -1 }, { updated_at: null }, { html_url: 'https://github.com/other/project/pull/42' },
    { html_url: `${url}0#issuecomment-30` }, { html_url: `https://secret@github.com/org/project/pull/42` }])('rejects malformed discussion fields: %j', async patch => {
    await expect(fixture({ comments: [[{ ...comment, ...patch }]] }).collect()).rejects.toThrow();
  });

  it('propagates provider transport failures and aborts without a snapshot', async () => {
    const failure = fixture(); failure.request.mockRejectedValueOnce(new Error('connection changed'));
    await expect(failure.collect()).rejects.toThrow('connection changed');
    const stopped = fixture(); stopped.controller.abort();
    await expect(stopped.collect()).rejects.toMatchObject({ name: 'AbortError' });
    expect(stopped.request).not.toHaveBeenCalled();
  });
});
