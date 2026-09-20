import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOutcomes, saveOutcomeAssessment } from './outcomeClient';

const summary = {
  window: { from: '2026-01-01', to: '2026-01-30' }, repo: null, runs: 1,
  execution: { succeeded: 1, failed: 0, stopped: 0, running: 0 },
  assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 1 },
  outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 1 },
  knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costCoverage: null,
  averageCostUsd: null, averageDurationMs: null, runsWithDuration: 0,
  inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null,
  linkedPrs: 0, unknownPrs: 0, stalePrs: 0, unavailablePrs: 0, publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0,
  costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null, correctionRounds: null,
  failures: [], daily: [], recentRuns: [],
};
const day = { date: '2026-01-01', runs: 1, succeeded: 1, failed: 0, stopped: 0, running: 0,
  knownCostUsd: null, observedCostUsd: 2, runsWithKnownCost: 0 };
const run = { runId: 'run_1', repo: 'org/repo', status: 'succeeded', prNumber: null, startedAt: '',
  durationMs: null, costUsd: null, observedCostUsd: 2, assessment: null };

const assessment = { runId: 'run_1', state: 'complete' as const, outcome: 'achieved' as const, summary: 'Done', evidence: ['PR #1'], failureStage: null, correctionRounds: 0, updatedAt: '2026-09-20T12:00:00Z' };

afterEach(() => vi.unstubAllGlobals());

describe('outcomeClient', () => {
  it('propagates lifecycle cancellation to assessment writes', async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true }));
    }));
    const controller = new AbortController();
    const saving = saveOutcomeAssessment('run_1', { state: 'complete', outcome: 'unknown', summary: 'Done', evidence: [], failureStage: null, correctionRounds: null }, controller.signal);
    controller.abort();
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });
  it('validates estimate amounts, coverage and source metadata without changing reported spend', async () => {
    const costEstimate = { estimatedUnreportedCostUsd: 1.25, estimatedUsageEvents: 1, unreportedUsageEvents: 2,
      runsWithoutUsage: 0, ratesAsOf: '2026-09-19', rateSource: 'https://developers.openai.com/api/docs/pricing' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...summary, costEstimate }))));
    await expect(fetchOutcomes(null, 7)).resolves.toMatchObject({ observedCostUsd: null, costEstimate });
    for (const patch of [{ estimatedUnreportedCostUsd: -1 }, { estimatedUsageEvents: 3 }, { unreportedUsageEvents: 1.5 },
      { estimatedUnreportedCostUsd: null }, { runsWithoutUsage: -1 }, { ratesAsOf: null }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...summary, costEstimate: { ...costEstimate, ...patch } }))));
      await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
    }
  });
  it('scopes and validates summary requests', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify(summary));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOutcomes('org/repo', 30)).resolves.toMatchObject({ runs: 1 });
    expect(String(calls[0]?.[0])).toBe('/api/outcomes?days=30&repo=org%2Frepo');
  });

  it('rejects malformed or failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })));
    await expect(fetchOutcomes(null, 7)).rejects.toThrow('Unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
  });

  it('retains partial reported spend and rejects invalid reported amounts', async () => {
    const mixed = { ...summary, observedCostUsd: 2, knownCostUsd: null, daily: [day], recentRuns: [run] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mixed))));
    await expect(fetchOutcomes(null, 7)).resolves.toMatchObject({ observedCostUsd: 2, knownCostUsd: null, recentRuns: [{ observedCostUsd: 2, costUsd: null }] });
    for (const invalid of [{ ...mixed, observedCostUsd: -1 }, { ...mixed, daily: [null] }, { ...mixed, recentRuns: [{ observedCostUsd: '2' }] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(invalid))));
      await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
    }
  });

  it('rejects incomplete summaries and malformed nested display data before rendering', async () => {
    const malformed = [
      { window: undefined }, { window: { from: null, to: '2026-01-30' } }, { repo: [] },
      { failures: undefined }, { failures: [null] }, { failures: [{ stage: 'tests', count: '<img src=x>' }] },
      { runs: -1 }, { totalTokens: 0.5 }, { averageDurationMs: undefined }, { costCoverage: 1.1 },
      { execution: {} }, { execution: { ...summary.execution, succeeded: '1' } },
      { assessments: { ...summary.assessments, complete: null } }, { outcomes: {} },
      { daily: [{ ...day, date: null }] }, { daily: [{ ...day, runs: '<img src=x>' }] },
      { recentRuns: [{ ...run, runId: null }] }, { recentRuns: [{ ...run, status: 'unknown' }] },
      { recentRuns: [{ ...run, assessment: { ...assessment, evidence: 'unexpected' } }] },
      { recentRuns: [{ ...run, assessment: { ...assessment, correctionRounds: '\" onfocus=alert(1)' } }] },
      { recentRuns: [{ ...run, assessment: { ...assessment, runId: 'another_run' } }] },
    ];
    for (const patch of malformed) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...summary, ...patch }))));
      await expect(fetchOutcomes(null, 30), JSON.stringify(patch)).rejects.toThrow('Outcomes response was invalid.');
    }
  });

  it('accepts valid nested assessments and optional estimate metadata', async () => {
    const body = { ...summary, daily: [day], recentRuns: [{ ...run, assessment }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(fetchOutcomes(null, 30)).resolves.toEqual(body);
  });

  it('saves the complete assessment payload', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ assessment }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await saveOutcomeAssessment('run_1', { state: 'complete', outcome: 'achieved', summary: 'Done', evidence: ['PR #1'], failureStage: null, correctionRounds: 0 });
    expect(calls[0]?.[0]).toBe('/api/outcomes/run_1/assessment');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ outcome: 'achieved', evidence: ['PR #1'] });
  });

  it('rejects malformed or mismatched successful assessment responses', async () => {
    for (const invalid of [null, { runId: 'run_1' }, ...[
      { runId: 'another_run' }, { state: 'invalid' }, { outcome: null }, { summary: null },
      { evidence: 'unexpected' }, { evidence: [null] }, { failureStage: {} },
      { correctionRounds: -1 }, { correctionRounds: 1.5 }, { updatedAt: null }, { updatedAt: 'invalid' }, { source: 'unknown' },
    ].map(patch => ({ ...assessment, ...patch }))]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ assessment: invalid }))));
      await expect(saveOutcomeAssessment('run_1', assessment)).rejects.toThrow('Assessment response was invalid.');
    }
  });
});
