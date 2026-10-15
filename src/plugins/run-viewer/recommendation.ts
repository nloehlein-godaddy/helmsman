import type { RunReadSummaryV1 } from '@helmsman/plugin-sdk';

const prefix = 'helmsman.review-recommendation.v1:';

export function prepareRecommendation(run: RunReadSummaryV1, headerRepo: string | null): string {
  if (run?.status !== 'succeeded' || !Number.isSafeInteger(run.prNumber) || !run.prNumber || run.prNumber < 1
    || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(run.repo) || !/^[a-z\d_-]{1,128}$/i.test(run.id)
    || !run.review || !['APPROVE', 'REQUEST_CHANGES'].includes(run.review.outcome)
    || typeof run.review.verdict !== 'string' || !run.review.verdict.trim() || run.review.verdict.length > 512) throw new Error('The review recommendation is unavailable. Refresh this run to try again.');
  const id = crypto.randomUUID();
  const handoff = { version: 1, repo: run.repo, number: run.prNumber, runId: run.id, event: run.review.outcome, verdict: run.review.verdict, createdAt: Date.now() };
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => !!key?.startsWith(prefix));
    for (const key of keys.slice(0, Math.max(0, keys.length - 19))) sessionStorage.removeItem(key);
    sessionStorage.setItem(`${prefix}${id}`, JSON.stringify(handoff));
  } catch { throw new Error('The review draft could not be opened. Browser session storage is unavailable.'); }
  const params = new URLSearchParams({ ...(headerRepo ? { repo: headerRepo } : {}), panel: 'pull-request',
    panelState: JSON.stringify({ 'helmsman.compat-pr/panel': { version: 1, value: { target: { repo: run.repo, number: run.prNumber }, mode: null, recommendationId: id } } }) });
  return `/prs?${params}`;
}
