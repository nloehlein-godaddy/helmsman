import type { PullRequestInspectDetailV1, PullRequestInspectDiffV1 } from './pull-request-inspect';

export const inspectQuery = { version: 1 as const, repo: 'org/project', number: 42 };
export const inspectTarget = { repo: inspectQuery.repo, number: inspectQuery.number, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
export const inspectDetail: PullRequestInspectDetailV1 = { version: 1, target: inspectTarget, observedAt: '2026-09-21T12:00:00Z', title: 'Work',
  url: 'https://github.com/org/project/pull/42', status: 'open', draft: false, authorLogin: 'author', isOwnPr: true, headRefName: 'work', updatedAt: '2026-09-21T11:00:00Z', comments: null,
  checks: { quality: 'complete', passed: 1, failed: 0, pending: 0 },
  reviews: { quality: 'complete', approved: 1, changesRequested: 0, commented: 0, requested: 0, viewerReview: 'APPROVED', viewerReviewedAt: '2026-09-21T10:00:00Z', viewerReviewedCommitId: inspectTarget.headSha } };
export const inspectDiff: PullRequestInspectDiffV1 = { version: 1, target: inspectTarget, observedAt: inspectDetail.observedAt, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false,
  files: [{ filename: 'source.ts', previousFilename: null, status: 'modified', additions: 1, deletions: 0, patch: '+new', patchStatus: 'preview' }] };
