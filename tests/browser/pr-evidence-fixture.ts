import type { PullRequestInspectEvidenceV1 } from '../../src/plugins/pull-request-inspect';

export function richPrEvidence(at: string): PullRequestInspectEvidenceV1 {
  return {
    comments: { quality: 'complete', truncated: false, items: [{ id: 'comment:1', author: 'reviewer-a', body: 'Keep customer evidence attached to the latest commit.\nLiteral <img src=x> and **Markdown** remain user content.', bodyTruncated: false, url: 'https://github.com/org/b/pull/42#issuecomment-1', createdAt: at }, { id: 'comment:2', author: null, body: 'Follow-up discussion is retained.', bodyTruncated: false, url: null, createdAt: null }] },
    changesRequested: { quality: 'partial', truncated: true, items: [{ id: 'review:1', author: 'reviewer-c', body: 'Handle the failed retry without dropping the original request.', bodyTruncated: true, url: 'https://github.com/org/b/pull/42#pullrequestreview-1', createdAt: at }] },
    approved: { quality: 'complete', truncated: false, items: [{ id: 'user:reviewer-a', label: 'reviewer-a', url: 'https://github.com/reviewer-a' }, { id: 'user:reviewer-b', label: 'reviewer-b', url: 'https://github.com/reviewer-b' }] },
    requested: { quality: 'complete', truncated: false, items: [{ id: 'user:reviewer-d', label: 'reviewer-d', url: 'https://github.com/reviewer-d' }, { id: 'team:platform', label: 'team:platform', url: null }] },
    checksPassed: { quality: 'complete', truncated: false, items: Array.from({ length: 61 }, (_, index) => ({ id: `check:${index + 1}`, name: `Validation ${String(index + 1).padStart(2, '0')}`, url: `https://github.com/org/b/actions/runs/${index + 1}` })) },
    checksFailed: { quality: 'complete', truncated: false, items: [{ id: 'check:62', name: 'Retry regression', url: 'https://github.com/org/b/actions/runs/62' }] },
    checksPending: { quality: 'complete', truncated: false, items: [{ id: 'check:63', name: 'Visual review', url: null }] },
  };
}
