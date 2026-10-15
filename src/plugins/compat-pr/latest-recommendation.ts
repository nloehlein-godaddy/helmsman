import type { RunReadSummaryV1 } from '@helmsman/plugin-sdk';

export function latestRecommendation(runs: readonly RunReadSummaryV1[], target: { repo: string; number: number } | null): RunReadSummaryV1 | null {
  if (!target || !Array.isArray(runs)) return null;
  const matches = runs.filter(run => !!run && run.repo === target.repo && run.prNumber === target.number && run.status === 'succeeded');
  if (matches.some(run => !Number.isFinite(Date.parse(run.startedAt)))) return null;
  const latest = matches.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.id.localeCompare(left.id))[0];
  const review = latest?.review;
  return latest && review && ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(review.outcome)
    && typeof review.verdict === 'string' && !!review.verdict.trim() && review.verdict.length <= 512 ? latest : null;
}
