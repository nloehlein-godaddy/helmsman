import { expect, it } from 'vitest';
import type { PullRequestInspectDetailV1, PullRequestInspectDiffV1, PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { parseLookup, renderDetail, renderList, renderRuns } from './render';
const detail: PullRequestInspectDetailV1 = { version: 1, target: { repo: 'org/b', number: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, observedAt: '2026-09-20T12:00:00Z', title: 'Review current work', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: '2026-09-20T12:00:00Z', comments: 3, checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 1, changesRequested: 0, commented: 2, requested: 0, viewerReview: 'APPROVED', viewerReviewedAt: '2026-09-19T12:00:00Z', viewerReviewedCommitId: 'c'.repeat(40) } };
const draft = { body: '', feedback: '', model: '', effort: '' };
function mount(html: string) { const node = document.createElement('div'); node.innerHTML = html; return node; }
it('preserves header and explicit PR target in the connected Slack link without redundant setup navigation', () => {
  const node = mount(renderDetail(detail, draft, 'org/header', false, true));
  const link = node.querySelector<HTMLAnchorElement>('a.pr-slack-review'); expect(link).not.toBeNull();
  const url = new URL(link!.href, 'http://localhost'); expect(url.searchParams.get('repo')).toBe('org/header'); expect(url.searchParams.get('prRepo')).toBe('org/b'); expect(url.searchParams.get('pr')).toBe('42');
  expect(node.querySelector('a[href^="/runs"]')).toBeNull(); expect(node.textContent).not.toContain('Open review setup'); expect(node.textContent).not.toContain('Open branch update setup');
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
it.each(['', 'Saved review draft'])('keeps PR context collapsed and opens manual review only for a saved draft %s', body => {
  const node = mount(renderDetail(detail, { ...draft, body }, null, false));
  const context = node.querySelector<HTMLDetailsElement>('.pr-provenance'); const manual = node.querySelector<HTMLDetailsElement>('.pr-manual-review');
  expect(context?.open).toBe(false); expect(context?.dataset.prDisclosure).toBe('org/b#42:context');
  expect(manual?.open).toBe(Boolean(body)); expect(manual?.dataset.prDisclosure).toBe('org/b#42:manual-review');
  expect(manual?.querySelector<HTMLTextAreaElement>('[data-draft="body"]')?.value).toBe(body);
  const other = mount(renderDetail({ ...detail, target: { ...detail.target, repo: 'org/other' } }, draft, null, false));
  expect(other.querySelector('.pr-manual-review')?.getAttribute('data-pr-disclosure')).toBe('org/other#42:manual-review');
  expect(node.textContent).not.toContain('signed-in'); expect(node.textContent).not.toContain('Configured author');
});
it('contains selected PR sections in a shared panel with manual review below the immutable diff', () => {
  const diff: PullRequestInspectDiffV1 = { version: 1, target: detail.target, observedAt: detail.observedAt, coverage: 'immutable-comparison-preview', quality: 'partial', truncated: true, files: [{ filename: 'src/view.ts', previousFilename: null, status: 'modified', additions: 2, deletions: 1, patch: null, patchStatus: 'unavailable' }] };
  const node = mount(renderDetail(detail, draft, null, false, false, diff));
  const panel = node.querySelector('.pr-panel');
  expect([...panel!.children].map(child => child.className)).toEqual(['pr-panel-head', 'pr-summary pr-subpanel', 'pr-crew-controls pr-agent-section pr-subpanel', 'pr-diff-panel pr-subpanel', 'pr-review pr-manual-review pr-subpanel']);
  expect(panel?.querySelector('.pr-summary-body > .pr-provenance')).not.toBeNull();
  expect(panel?.querySelector('.pr-diff-panel > summary')?.textContent).toBe('Diff'); expect(panel?.querySelector('.pr-diff-panel h3')).toBeNull();
  expect(panel?.querySelector('.pr-diff-panel')?.textContent).toContain('partial file enumeration');
  expect(panel?.querySelector('.pr-diff-panel')?.textContent).toContain('Inline patch unavailable.');
  expect(panel?.querySelector('.pr-diff-panel')?.nextElementSibling).toBe(panel?.querySelector('.pr-manual-review'));
  const disclosures = [...node.querySelectorAll<HTMLDetailsElement>('.pr-panel > details')];
  expect(disclosures.map(section => section.dataset.prDisclosure)).toEqual(['org/b#42:metadata', 'org/b#42:agent-work', 'org/b#42:diff', 'org/b#42:manual-review']);
  expect(disclosures.map(section => section.open)).toEqual([true, true, true, false]);
  expect(disclosures.slice(0, 3).every(section => section.firstElementChild?.tagName === 'SUMMARY')).toBe(true);
  expect(node.querySelector('.pr-agent-body [data-launch="review"]')).not.toBeNull();
  expect(node.querySelector('.pr-diff-body .diff-file')).not.toBeNull();
});
it.each([true, false])('names the collapsible agent section appropriately in pirate mode %s', pirate => {
  const node = mount(renderDetail(detail, draft, null, pirate));
  expect(node.querySelector('.pr-summary > summary')?.textContent).toBe('Metadata');
  expect(node.querySelector('.pr-agent-section > summary')?.textContent).toBe(pirate ? 'Crew work' : 'Agent work');
  expect(node.querySelector('.pr-agent-section > summary [data-icon="agent"]')?.getAttribute('aria-hidden')).toBe('true');
  const other = mount(renderDetail({ ...detail, target: { ...detail.target, repo: 'org/other' } }, draft, null, pirate));
  expect(other.querySelector('.pr-summary')?.getAttribute('data-pr-disclosure')).toBe('org/other#42:metadata');
  expect(other.querySelector('.pr-agent-section')?.getAttribute('data-pr-disclosure')).toBe('org/other#42:agent-work');
});
it('does not invent diff completeness when the diff has not loaded', () => {
  const node = mount(renderDetail(detail, draft, null, false)); expect(node.querySelector('.pr-diff-panel')).toBeNull();
  expect(node.querySelector('.pr-manual-review')).not.toBeNull();
});
it('groups exact evidence counts and preserves semantic tones without treating zero as unavailable', () => {
  const node = mount(renderDetail(detail, draft, null, false));
  const checks = [...node.querySelectorAll('.pr-checks .pr-evidence-count')];
  expect(checks.map(item => item.querySelector(':scope > details > summary')?.textContent ?? item.textContent)).toEqual(['2 passed', '0 failed', '0 pending']);
  expect(checks.map(item => item.getAttribute('data-tone'))).toEqual(['good', 'neutral', 'neutral']);
  expect([...node.querySelectorAll('.pr-panel-status .pr-evidence-count')].map(item => item.querySelector(':scope > details > summary')?.textContent ?? item.textContent)).toEqual(['1 approved', '0 changes requested', '0 awaiting review', '3 discussion comments']);
  expect(node.querySelector('.pr-evidence-quality')).toBeNull();
});
it('shows unavailable evidence as unknown independently of partial checks and unavailable reviews', () => {
  const node = mount(renderDetail({ ...detail, comments: null, checks: { quality: 'partial', passed: 2, failed: null, pending: null }, reviews: { ...detail.reviews, quality: 'unavailable', approved: null, changesRequested: null, requested: null } }, draft, null, false));
  expect(node.querySelector('.pr-checks .pr-evidence-quality')?.textContent).toBe('Partial');
  expect(node.querySelector('.pr-panel-status .pr-evidence-quality')?.textContent).toBe('Unavailable');
  expect(node.querySelector('.pr-checks')?.textContent).toContain('2 passed'); expect(node.querySelector('.pr-checks')?.textContent).toContain('Unknown failed');
  expect(node.querySelector('.pr-panel-status')?.textContent).toContain('Unknown discussion comments');
  expect([...node.querySelectorAll('.pr-evidence-count')].filter(item => item.textContent?.startsWith('Unknown')).every(item => item.getAttribute('data-tone') === 'neutral')).toBe(true);
});
it.each([true, false, null])('retains manual GitHub decisions independently of configured-author ownership %s', isOwnPr => {
  const node = mount(renderDetail({ ...detail, isOwnPr }, draft, null, false));
  const decisions = [...node.querySelectorAll<HTMLButtonElement>('[data-review]')];
  expect(decisions.map(button => button.dataset.review)).toEqual(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
  expect(decisions.every(button => !button.disabled)).toBe(true);
});
it.each(['closed', 'merged'] as const)('omits agent work and your review while retaining inspection content for a %s PR', status => {
  const diff: PullRequestInspectDiffV1 = { version: 1, target: detail.target, observedAt: detail.observedAt, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] };
  for (const pirate of [false, true]) {
    const node = mount(renderDetail({ ...detail, status }, { ...draft, body: 'Retained review draft', feedback: 'Retained feedback draft' }, null, pirate, true, diff));
    expect(node.querySelector('.pr-agent-section')).toBeNull(); expect(node.querySelector('.pr-manual-review')).toBeNull();
    expect(node.querySelectorAll('[data-review],[data-launch],[data-draft]')).toHaveLength(0);
    expect(node.querySelector('.pr-slack-review')).toBeNull();
    expect(node.querySelector('.pr-summary')).not.toBeNull(); expect(node.querySelector('.pr-diff-panel')).not.toBeNull();
    expect(node.querySelector('.pr-panel-head')?.textContent).toContain(detail.title);
    expect(node.textContent).not.toContain('Your GitHub review'); expect(node.textContent).not.toContain(pirate ? 'Crew work' : 'Agent work');
  }
});
it.each([false, undefined])('hides Slack when its connection is disconnected or unknown %s', slackConnected => {
  const node = mount(renderDetail(detail, draft, null, false, slackConnected)); expect(node.querySelector('.pr-slack-review')).toBeNull();
});
it.each([false, null])('hides Slack despite a connection without known configured-author ownership %s', isOwnPr => {
  const node = mount(renderDetail({ ...detail, isOwnPr }, draft, null, false, true)); expect(node.querySelector('.pr-slack-review')).toBeNull();
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
  expect(node.querySelector('.pr-list-status')?.textContent).toBe('open');
  expect(node.querySelector('.pr-list-status')?.getAttribute('aria-label')).toBe('Status: open');
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

const feedbackPage: PullRequestReadPageV1 = { version: 1, repo: 'org/b', kind: 'authored-recent', quality: 'complete', truncated: false, browseUrl: null,
  items: [{ repo: 'org/b', number: 42, title: 'Customer evidence retained', url: null, status: 'open', createdAt: detail.observedAt, mergedAt: null, draft: false, ticketId: null, reviewDecision: null, comments: 7, reviews: { approved: 0, changesRequested: 1, commented: 2, requested: 0 } }] };
it('highlights both feedback states with labels, icons, semantic roles and an accessible selection name', () => {
  const item = { ...feedbackPage.items[0]!, feedback: { changesRequested: true, newComments: true, latestCommitAt: detail.observedAt } };
  const node = mount(renderList('authored-recent', { ...feedbackPage, items: [item] }, '', true));
  expect(node.querySelector('.pr-list-row')?.getAttribute('data-feedback')).toBe('changes');
  const badges = [...node.querySelectorAll('.pr-feedback-badge')]; expect(badges.map(badge => badge.textContent)).toEqual(['Changes requested', 'New comments']);
  expect(badges.map(badge => badge.getAttribute('data-tone'))).toEqual(['bad', 'review']);
  expect(badges[1]?.getAttribute('title')).toContain('after the latest commit');
  expect(node.querySelector('.pr-list-select')?.getAttribute('aria-label')).toContain('Changes requested · New comments');
  expect(badges.every(badge => badge.querySelector('.pr-phosphor')?.getAttribute('aria-hidden') === 'true')).toBe(true);
});
it.each([false, null])('keeps explicit %s feedback authoritative over historical counts and unknown timestamps', value => {
  const item = { ...feedbackPage.items[0]!, reviewDecision: 'CHANGES_REQUESTED' as const, feedback: { changesRequested: value, newComments: value, latestCommitAt: null } };
  const node = mount(renderList('authored-recent', { ...feedbackPage, items: [item] }, '', false));
  expect(node.querySelector('.pr-feedback-badge')).toBeNull(); expect(node.querySelector('[data-feedback]')).toBeNull(); expect(node.textContent).not.toContain('No feedback'); expect(node.textContent).toContain('7 discussion comments'); expect(node.querySelector('.pr-list-stats')?.textContent).not.toContain('changes requested');
});
it.each(['closed', 'merged'] as const)('does not highlight resolved %s pull requests even with stale feedback', status => {
  const item = { ...feedbackPage.items[0]!, status, feedback: { changesRequested: true, newComments: true, latestCommitAt: detail.observedAt } };
  const node = mount(renderList('authored-recent', { ...feedbackPage, items: [item] }, '', false)); expect(node.querySelector('.pr-feedback-badge')).toBeNull(); expect(node.querySelector('[data-feedback]')).toBeNull();
});
it('uses legacy current review evidence only for requested changes and never infers new comments from totals', () => {
  const node = mount(renderList('authored-recent', feedbackPage, '', false)); expect(node.querySelectorAll('.pr-feedback-badge')).toHaveLength(1); expect(node.querySelector('.pr-feedback-badge')?.textContent).toBe('Changes requested');
  const item = { ...feedbackPage.items[0]!, reviews: null, reviewDecision: 'CHANGES_REQUESTED' as const };
  const decision = mount(renderList('authored-recent', { ...feedbackPage, items: [item] }, '', false)); expect(decision.querySelector('.pr-feedback-badge')?.textContent).toBe('Changes requested');
});
it('uses the review row treatment for new comments alone', () => {
  const item = { ...feedbackPage.items[0]!, feedback: { changesRequested: false, newComments: true, latestCommitAt: detail.observedAt } };
  const node = mount(renderList('authored-recent', { ...feedbackPage, items: [item] }, '', false)); expect(node.querySelector('[data-feedback]')?.getAttribute('data-feedback')).toBe('comments'); expect(node.querySelector('.pr-feedback-badge')?.textContent).toBe('New comments');
});

const evidence = {
  checksPassed: { quality: 'complete' as const, truncated: false, items: Array.from({ length: 8 }, (_, index) => ({ id: `check:${index}`, name: `Build ${index + 1}`, url: 'https://github.com/org/b/actions/runs/42' })) },
  checksFailed: { quality: 'partial' as const, truncated: true, items: [{ id: 'check:failed', name: 'Integration', url: null }] },
  checksPending: { quality: 'unavailable' as const, truncated: false, items: [] },
  approved: { quality: 'complete' as const, truncated: false, items: [{ id: 'user:alice', label: 'alice', url: 'https://github.com/alice' }] },
  requested: { quality: 'complete' as const, truncated: false, items: [{ id: 'user:bob', label: 'bob', url: 'https://github.com/bob' }, { id: 'team:web', label: 'team:web', url: null }] },
  comments: { quality: 'complete' as const, truncated: false, items: [{ id: 'comment:1', author: 'writer', body: 'Please retain the original behavior.\nThanks.', bodyTruncated: false, url: 'https://github.com/org/b/pull/42#issuecomment-1', createdAt: detail.observedAt }] },
  changesRequested: { quality: 'partial' as const, truncated: true, items: [{ id: 'review:1', author: 'reviewer', body: 'Fix the error path.', bodyTruncated: true, url: 'https://github.com/org/b/pull/42#pullrequestreview-1', createdAt: detail.observedAt }] },
};
it('shows only five initial check names and retains the remaining names in a keyed Show more disclosure', () => {
  const node = mount(renderDetail({ ...detail, evidence }, draft, null, false));
  const passed = node.querySelector('.pr-checks .pr-stat-preview')!;
  expect(passed.querySelectorAll(':scope > .pr-stat-popup > ul > li')).toHaveLength(5);
  const more = passed.querySelector<HTMLDetailsElement>('.pr-evidence-more'); expect(more?.open).toBe(false); expect(more?.querySelector('summary')?.textContent).toBe('Show 3 more'); expect(more?.querySelectorAll('li')).toHaveLength(3);
  expect(more?.dataset.prDisclosure).toBe(`org/b#42@${detail.target.headSha}:checks-passed:more`);
  expect(passed.querySelector('summary')?.getAttribute('aria-label')).toContain('show details');
});
it('retains approved and awaiting user/team names without converting names into application terminology', () => {
  const node = mount(renderDetail({ ...detail, evidence }, draft, null, true));
  const previews = node.querySelectorAll('.pr-panel-status .pr-stat-preview');
  expect(previews[0]?.querySelectorAll('li')).toHaveLength(1); expect(previews[0]?.textContent).toContain('alice');
  expect(previews[1]?.textContent).toContain('bob'); expect(previews[1]?.textContent).toContain('team:web'); expect(previews[1]?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
});
it('renders collapsed, immutable-PR-keyed discussions with literal body text, dates and truncation notes', () => {
  const node = mount(renderDetail({ ...detail, evidence }, draft, null, false));
  const sections = [...node.querySelectorAll<HTMLDetailsElement>('.pr-discussion')]; expect(sections.map(section => section.open)).toEqual([false, false]);
  expect(sections.map(section => section.dataset.prDisclosure)).toEqual([`org/b#42@${detail.target.headSha}:changes-requested`, `org/b#42@${detail.target.headSha}:comments`]);
  expect(sections[0]?.textContent).toContain('Fix the error path.'); expect(sections[0]?.textContent).toContain('Text shortened.'); expect(sections[0]?.textContent).toContain('Some details are unavailable.');
  expect(sections[1]?.querySelector('.pr-discussion-text')?.textContent).toBe(evidence.comments.items[0]!.body); expect(sections[1]?.querySelector('time')?.getAttribute('datetime')).toBe(detail.observedAt);
  const newHead = mount(renderDetail({ ...detail, evidence, target: { ...detail.target, headSha: 'd'.repeat(40) } }, draft, null, false)); expect(newHead.querySelector('.pr-discussion')?.getAttribute('data-pr-disclosure')).not.toBe(sections[0]?.dataset.prDisclosure);
});
it('distinguishes missing evidence, partial evidence and a complete empty list', () => {
  const absent = mount(renderDetail(detail, draft, null, false)); expect(absent.querySelector('.pr-stat-popup')?.textContent).toContain('Details unavailable.'); expect(absent.querySelector('.pr-discussion-body')?.textContent).toContain('Details unavailable.');
  const node = mount(renderDetail({ ...detail, evidence: { ...evidence, comments: { quality: 'complete', truncated: false, items: [] } } }, draft, null, false));
  expect(node.querySelectorAll('.pr-checks .pr-stat-popup')[1]?.textContent).toContain('Some details are unavailable.'); expect(node.querySelectorAll('.pr-checks .pr-stat-popup')[2]?.textContent).toContain('Details unavailable.');
  expect(node.querySelectorAll('.pr-discussion-body')[1]?.textContent).toBe('None.');
});
it('escapes check and discussion content and rejects active-content evidence links', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const node = mount(renderDetail({ ...detail, evidence: { ...evidence, approved: { ...evidence.approved, items: [{ id: 'user:x', label: payload, url: 'javascript:alert(1)' }] }, comments: { ...evidence.comments, items: [{ ...evidence.comments.items[0]!, body: payload, author: payload, url: 'javascript:alert(1)' }] } } }, draft, null, false));
  expect(node.querySelector('img')).toBeNull(); expect(node.querySelector('.pr-discussion-text')?.textContent).toBe('Fix the error path.'); expect(node.querySelectorAll('.pr-discussion-text')[1]?.textContent).toBe(payload);
  expect([...node.querySelectorAll('a')].some(link => link.getAttribute('href')?.startsWith('javascript:'))).toBe(false);
});
