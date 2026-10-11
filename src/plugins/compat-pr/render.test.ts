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
  expect(node.querySelectorAll('.pr-list-stat')).toHaveLength(3);
  expect(node.textContent).toContain('2 approvals'); expect(node.textContent).toContain('1 changes requested'); expect(node.textContent).toContain('7 discussion comments'); expect(node.textContent).not.toContain('unknown pending reviews'); expect(node.textContent).toContain('More may be available in the full list');
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


it.each(['complete', 'partial', 'degraded'] as const)('distinguishes an empty %s result from a failed or limited read', quality => {
  const page: PullRequestReadPageV1 = { version: 1, repo: 'org/b', kind: 'authored-recent', quality, truncated: false, browseUrl: null, items: [] };
  const node = mount(renderList('authored-recent', page, '', true));
  expect(node.textContent).not.toContain('Results unavailable or incomplete');
  expect(node.textContent).toContain(quality === 'complete' ? 'No matching pull requests.' : quality === 'partial' ? 'Only some results were returned.' : 'Refresh page to try again.');
  expect(node.textContent?.includes('No matching')).toBe(quality === 'complete');
});

it('makes the title the selection control and keeps scoped galleon metadata quiet', () => {
  const item = { repo: 'org/b', number: 42, title: 'Clear title', url: null, status: 'open' as const, createdAt: detail.observedAt, mergedAt: null, draft: false, ticketId: null, reviewDecision: null, comments: 0, reviews: null };
  const page: PullRequestReadPageV1 = { version: 1, repo: 'org/b', kind: 'authored-recent', quality: 'complete', truncated: false, browseUrl: null, items: Array.from({ length: 10 }, (_, index) => ({ ...item, number: index + 1 })) };
  const node = mount(renderList('authored-recent', page, '', false));
  expect(node.querySelector('.pr-list-select .pr-list-title')?.textContent).toBe('Clear title');
  expect(node.querySelectorAll('.pr-list-stat')).toHaveLength(0);
  expect(node.querySelector('.pr-list-meta')?.textContent).not.toContain('org/b');
  expect(node.querySelector(':scope > details > .pr-list')?.children).toHaveLength(8);
  const more = node.querySelector<HTMLDetailsElement>('[data-pr-disclosure="authored-more"]'); expect(more?.open).toBe(false); expect(more?.querySelectorAll('.pr-list-row')).toHaveLength(2);
  const all = mount(renderList('authored-recent', { ...page, repo: null }, '', false)); expect(all.querySelector('.pr-list-meta')?.textContent).toContain('org/b');
});
it('keeps recent run history collapsed until requested', () => {
  const node = mount(renderRuns([], false, '', false));
  expect(node.querySelector<HTMLDetailsElement>('[data-pr-disclosure="recent-runs"]')?.open).toBe(false);
});

it('keeps labels explicit alongside decorative status and action icons', () => {
  const node = mount(renderDetail({ ...detail, draft: true }, draft, null, false));
  expect(node.querySelector('.pr-list-status')?.textContent).toBe('Status: open');
  expect(node.querySelector('.pr-list-status')?.getAttribute('data-tone')).toBe('review');
  expect(node.querySelector('.pr-draft')?.textContent).toBe('Draft');
  expect(node.querySelector('.pr-request-changes [data-icon="bad"]')).not.toBeNull();
  expect(node.querySelectorAll('.pr-phosphor').length).toBeGreaterThan(0);
  for (const icon of node.querySelectorAll('.pr-phosphor')) { expect(icon.getAttribute('aria-hidden')).toBe('true'); expect(icon.textContent).toBe(''); }
});
it.each([['running', 'review', 'running'], ['succeeded', 'good', 'good'], ['failed', 'bad', 'bad']] as const)('renders %s run status with its semantic role and meaningful icon', (status, tone, icon) => {
  const run: RunReadSummaryV1 = { version: 1, id: 'review-agent', repo: 'org/agent-review', displayKey: 'Review current work', status, attempt: 1, startedAt: detail.observedAt, endedAt: null, prNumber: 42, costUsd: null, review: null, sourceSettlement: null };
  const node = mount(renderRuns([run], false, '', false));
  const statusNode = node.querySelector('.pr-list-status'); expect(statusNode?.textContent).toBe(`Status: ${status}`); expect(statusNode?.getAttribute('data-tone')).toBe(tone); expect(statusNode?.querySelector('.pr-phosphor')?.getAttribute('data-icon')).toBe(icon);
});

it.each(['review-requested', 'authored-recent'])('exposes %s as a default-open native disclosure with a stable section key and visible zero count', kind => {
  const page: PullRequestReadPageV1 = { version: 1, repo: 'org/b', kind: kind as PullRequestReadPageV1['kind'], quality: 'complete', truncated: false, browseUrl: null, items: [] };
  const node = mount(renderList(kind, page, '', true)); const section = node.querySelector<HTMLDetailsElement>('details.pr-list-section');
  expect(section?.open).toBe(true); expect(section?.dataset.prDisclosure).toBe(kind === 'review-requested' ? 'review-requests-list' : 'authored-list');
  expect(section?.querySelector('summary h3')?.textContent).toContain(kind === 'review-requested' ? 'Review requests' : 'My recent bounties');
  expect(section?.querySelector('summary .pr-list-count')?.textContent).toBe('0'); expect(section?.querySelector('summary .pr-phosphor')?.getAttribute('aria-hidden')).toBe('true');
});
