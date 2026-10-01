import { expect, it, vi } from 'vitest';
import { createGithubFeedbackTracker } from './provider';
import type { FeedbackHttpV1, FeedbackSubmissionV1 } from '../feedback-tracker';
const provider = createGithubFeedbackTracker({ enabled: true, repository: 'org/app', labels: '' });
const input: FeedbackSubmissionV1 = { id: 'operation', contentHash: 'a'.repeat(64), input: { version: 1, draftId: '12345678-1234-4123-8123-123456789abc', title: 'Bug', body: 'Body', context: { version: '1', repo: null, page: 'feedback' }, expectedDestination: { id: 'github-issues:org/app', label: 'org/app issues', url: 'https://github.com/org/app/issues', revision: 'b'.repeat(64) } },
  plan: { destination: { id: 'github-issues:org/app', label: 'org/app issues', url: 'https://github.com/org/app/issues' }, target: { repo: 'org/app', actor: 'tester' }, request: { method: 'POST', path: '/repos/org/app/issues', query: {}, body: null } }, request: { method: 'POST', path: '/repos/org/app/issues', query: {}, body: { title: 'Bug', body: 'Body <!-- helmsman-feedback:operation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->' } } };
const issue = { ...(input.request.body as object), number: 4, user: { login: 'tester' }, html_url: 'https://github.com/org/app/issues/4' };
it.each([{ body: 'wrong marker' }, { title: 'wrong title' }, { user: { login: null } }, { user: { login: 'other' } }, { html_url: 'https://github.com/other/app/issues/4' }, { pull_request: {} }])('requires exact issue content, author and target during reconciliation: %j', async changed => {
  const request = vi.fn<FeedbackHttpV1['request']>(async value => value.path === '/user' ? { status: 200, body: { login: 'tester' } } : value.path === '/search/issues' ? { status: 200, body: { incomplete_results: false, total_count: 1, items: [{ number: 4 }] } } : { status: 200, body: { ...issue, ...changed } });
  expect(await provider.reconcileSubmission(input, { signal: new AbortController().signal, http: { request } })).toMatchObject({ status: 'unknown' }); expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
});
it('acknowledges only a complete exact match and never treats empty search as proof of non-creation', async () => {
  const request = vi.fn<FeedbackHttpV1['request']>(async value => value.path === '/user' ? { status: 200, body: { login: 'tester' } } : value.path === '/search/issues' ? { status: 200, body: { incomplete_results: false, total_count: 1, items: [{ number: 4 }] } } : { status: 200, body: issue });
  expect(await provider.reconcileSubmission(input, { signal: new AbortController().signal, http: { request } })).toMatchObject({ status: 'acknowledged', receipt: { id: '4' } });
  request.mockImplementation(async value => value.path === '/user' ? { status: 200, body: { login: 'tester' } } : { status: 200, body: { incomplete_results: false, total_count: 0, items: [] } });
  expect(await provider.reconcileSubmission(input, { signal: new AbortController().signal, http: { request } })).toMatchObject({ status: 'unknown' });
});

it.each(['../repo', 'org/..', 'org/.', 'org/repo/extra', 'org/repo?query'])('does not expose an invalid configured destination: %s', async repository => {
  const value = createGithubFeedbackTracker({ enabled: true, repository, labels: '' }); expect(await value.destination({ signal: new AbortController().signal, http: { request: async () => { throw new Error('unused'); } } })).toBeNull();
});
