import { afterEach, expect, it } from 'vitest';
import { readRecommendation } from './recommendation';

afterEach(() => sessionStorage.clear());
const id = 'b0ef36b8-e7a2-4b24-a343-2dac4b561824'; const target = { repo: 'org/project', number: 42 };
const recommendation = { version: 1, ...target, runId: 'review-run', event: 'REQUEST_CHANGES', verdict: '<img src=x> Fix the change.', createdAt: Date.now() };
it('validates bounded recommendation provenance and preserves user content literally', () => {
  sessionStorage.setItem(`helmsman.review-recommendation.v1:${id}`, JSON.stringify(recommendation));
  expect(readRecommendation(id, target)).toEqual({ ...target, runId: 'review-run', event: 'REQUEST_CHANGES', verdict: recommendation.verdict });
  expect(readRecommendation(id, { ...target, number: 43 })).toBeNull(); expect(readRecommendation('../invalid', target)).toBeNull();
});
it.each([{ ...recommendation, createdAt: Date.now() - 31 * 60_000 }, { ...recommendation, verdict: 'x'.repeat(513) }, { ...recommendation, event: 'COMMENT' }, { ...recommendation, runId: '../outside' }])('rejects expired or malformed retained recommendations', value => {
  sessionStorage.setItem(`helmsman.review-recommendation.v1:${id}`, JSON.stringify(value)); expect(readRecommendation(id, target)).toBeNull();
});
