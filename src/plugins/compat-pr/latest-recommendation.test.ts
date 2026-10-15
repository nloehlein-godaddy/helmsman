import { expect, it } from 'vitest';
import type { RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { latestRecommendation } from './latest-recommendation';

const target = { repo: 'org/project', number: 42 };
const run = (id: string, startedAt: string, outcome: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | null): RunReadSummaryV1 => ({ version: 1, id, repo: target.repo, prNumber: target.number, displayKey: 'review', status: 'succeeded', attempt: 1, startedAt, endedAt: startedAt, costUsd: null, sourceSettlement: null, review: outcome ? { outcome, verdict: outcome } : null });
it('chooses the latest succeeded associated run regardless of list order and excludes another PR', () => {
  const older = run('older', '2026-10-14T01:00:00Z', 'APPROVE'); const newest = run('newest', '2026-10-14T03:00:00Z', 'REQUEST_CHANGES');
  expect(latestRecommendation([newest, { ...run('other', '2026-10-14T04:00:00Z', 'APPROVE'), prNumber: 43 }, older], target)).toBe(newest);
});
it.each(['COMMENT', null] as const)('does not reuse an older approval beyond a newer %s outcome', outcome => {
  const newest = run('newest', '2026-10-14T03:00:00Z', outcome); const selected = latestRecommendation([run('older', '2026-10-14T01:00:00Z', 'APPROVE'), newest], target);
  expect(selected).toBe(outcome ? newest : null);
});
