import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { prepareRecommendation } from './recommendation';

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
const run: RunReadSummaryV1 = { version: 1, id: 'completed-review', repo: 'org/project', displayKey: 'review', status: 'succeeded', attempt: 1, startedAt: '2026-10-14T00:00:00Z', endedAt: '2026-10-14T01:00:00Z', prNumber: 42, costUsd: null, sourceSettlement: null, review: { outcome: 'APPROVE', verdict: 'Approve this reviewed change.' } };
describe('review recommendation handoff', () => {
  it('keeps review content out of the URL and preserves the header scope', () => {
    const url = new URL(prepareRecommendation(run, 'org/header'), 'https://helmsman.local');
    expect(url.pathname).toBe('/prs'); expect(url.searchParams.get('repo')).toBe('org/header'); expect(url.search).not.toContain('Approve');
    const panel = JSON.parse(url.searchParams.get('panelState')!)['helmsman.compat-pr/panel'];
    expect(panel.value.target).toEqual({ repo: run.repo, number: 42 }); expect(panel.value.mode).toBeNull();
    const stored = JSON.parse(sessionStorage.getItem(`helmsman.review-recommendation.v1:${panel.value.recommendationId}`)!);
    expect(stored).toMatchObject({ repo: run.repo, number: 42, runId: run.id, event: 'APPROVE', verdict: run.review!.verdict });
  });
  it.each([{ ...run, status: 'running' as const }, { ...run, prNumber: null }, { ...run, review: { outcome: 'COMMENT' as const, verdict: 'Comment only' } }])('rejects unavailable recommendations', value => {
    expect(() => prepareRecommendation(value, null)).toThrow('unavailable'); expect(sessionStorage.length).toBe(0);
  });
  it('reports unavailable session storage without navigating', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); }); expect(() => prepareRecommendation(run, null)).toThrow('Browser session storage');
  });
});
