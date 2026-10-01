import { readPullRequestDetail } from './pull-request-source';
import { parsePullRequestInspectDiffV1 } from '../../src/plugins/pull-request-inspect';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';
import type { ReviewScope } from './review-policy';

export async function prepareTriggerReview(input: { repo: string; number: number; headSha?: string; allowDraft?: boolean }, capture: TriggerPullRequestReadCapture) {
  capture.assertCurrent();
  const detail = await readPullRequestDetail(input, capture);
  capture.assertCurrent();
  if (detail.status !== 'open' || detail.draft && !input.allowDraft) throw new Error('Pull request is not eligible for review');
  if (input.headSha && detail.target.headSha !== input.headSha) throw new Error('PR changed before triggered review preparation');
  const diffQuery = { version: 1 as const, target: detail.target };
  const diff = parsePullRequestInspectDiffV1(await capture.provider.diff(diffQuery, capture.context), diffQuery);
  capture.assertCurrent();
  const files = diff.files.map(file => ({ filename: file.filename, changes: file.additions + file.deletions, patch: file.patch }));
  const scope: ReviewScope = { files, changedFiles: files.length, changedLines: files.reduce((sum, file) => sum + file.changes, 0),
    complete: diff.quality === 'complete' && !diff.truncated, headSha: detail.target.headSha };
  return { target: detail.target, pr: { number: detail.target.number, title: detail.title, headSha: detail.target.headSha, headRefName: detail.headRefName,
    state: 'open' as const, draft: detail.draft, merged: false }, scope };
}
