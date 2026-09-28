import { expect, it } from 'vitest';
import type { PullRequestInspectDetailV1, PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { parseLookup, renderDetail, renderList, renderRuns } from './render';
const detail: PullRequestInspectDetailV1 = { version: 1, target: { repo: 'org/b', number: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, observedAt: '2026-09-20T12:00:00Z', title: 'Review current work', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: '2026-09-20T12:00:00Z', comments: 3, checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 1, changesRequested: 0, commented: 2, requested: 0, viewerReview: 'APPROVED', viewerReviewedAt: '2026-09-19T12:00:00Z', viewerReviewedCommitId: 'c'.repeat(40) } };
const draft = { body: '', feedback: '', model: '', effort: '' };
function mount(html: string) { const node = document.createElement('div'); node.innerHTML = html; return node; }
it('preserves header and explicit PR target in review, rerun and Slack request links', () => {
  const node = mount(renderDetail(detail, draft, 'org/header', false));
  for (const link of node.querySelectorAll<HTMLAnchorElement>('a.app-link')) { const url = new URL(link.href, 'http://localhost'); expect(url.searchParams.get('repo')).toBe('org/header'); expect(url.searchParams.get('prRepo')).toBe('org/b'); expect(url.searchParams.get('pr')).toBe('42'); }
  expect(node.textContent).toContain('New commits since review'); expect(node.querySelector('[data-launch="rerun"]')).not.toBeNull();
});
it.each([false, null])('does not expose branch-update or Slack publication setup without known ownership %s', isOwnPr => {
  const node = mount(renderDetail({ ...detail, isOwnPr }, draft, null, false)); expect(node.querySelector('[data-launch="rerun"]')).toBeNull(); expect([...node.querySelectorAll('a')].some(link => link.textContent?.includes('Slack'))).toBe(false); expect(node.querySelector('[data-launch="review"]')).not.toBeNull();
});
it('escapes provider and draft text and refuses active-content URLs', () => {
  const payload = '"><img src=x onerror=alert(1)>';
  const node = mount(renderDetail({ ...detail, title: payload, authorLogin: payload, url: 'javascript:alert(1)', headRefName: payload }, { ...draft, body: payload, feedback: payload }, null, false));
  expect(node.querySelector('img')).toBeNull(); expect(node.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value).toBe(payload); expect(node.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('#');
});
it('retains an explicitly saved custom model instead of silently displaying automatic selection', () => {
  const node = mount(renderDetail(detail, { ...draft, model: 'provider-custom-model' }, null, false)); expect(node.querySelector<HTMLSelectElement>('.pr-model')?.value).toBe('provider-custom-model');
});
it('keeps approvals, requested changes, and discussion comments distinct from unavailable review counts', () => {
  const page: PullRequestReadPageV1 = { version: 1, repo: 'org/b', kind: 'review-requested', quality: 'partial', truncated: true, browseUrl: null,
    items: [{ repo: 'org/b', number: 42, title: 'Review', url: null, status: 'open', createdAt: detail.observedAt, mergedAt: null, draft: null, ticketId: null, reviewDecision: null, comments: 7, reviews: { approved: 2, changesRequested: 1, commented: null, requested: null } }] };
  const node = mount(renderList('review-requested', page, '', false));
  expect(node.querySelectorAll('.pr-list-stat')).toHaveLength(4);
  expect(node.textContent).toContain('2 approvals'); expect(node.textContent).toContain('1 changes requested'); expect(node.textContent).toContain('7 discussion comments'); expect(node.textContent).toContain('unknown pending reviews'); expect(node.textContent).toContain('partial · More results available');
});
it.each([true, false])('keeps recent run identity and user text literal in pirate mode %s', pirate => {
  const run: RunReadSummaryV1 = { version: 1, id: 'review-agent', repo: 'org/agent-review', displayKey: 'Review PR tokens voyage', status: 'failed', attempt: 1, startedAt: detail.observedAt, endedAt: null, prNumber: 42, costUsd: null, review: null, sourceSettlement: null };
  const node = mount(renderRuns([run], true, '', pirate)); expect(node.querySelector('button')?.dataset.run).toBe('review-agent'); expect(node.querySelector('button')?.dataset.repo).toBe('org/agent-review'); expect(node.querySelector('button')?.textContent).toContain(run.displayKey); expect(node.textContent).toContain('bounded history sample');
});

it.each(['0', '#0', '9007199254740993', '-12', '#12x'])('rejects invalid bare PR lookup %s', input => {
  expect(parseLookup(input, 'org/current')).toBeNull();
});
it.each(['org/other#12', 'https://github.com/org/other/pull/12'])('preserves explicit lookup scope %s', input => {
  expect(parseLookup(input, 'org/current')).toEqual({ repo: 'org/other', number: 12 });
});
