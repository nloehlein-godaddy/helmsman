import { describe, expect, it, vi } from 'vitest';
import type { OutcomeSummary, PluginPageServices, PricingEstimate, UsageSnapshot } from '@helmsman/plugin-sdk';
import { presentCostsReport, readCostsReport } from './report';

const stale = { estimatedUnreportedCostUsd: 999, estimatedUsageEvents: 9, unreportedUsageEvents: 9 };
const summary: OutcomeSummary = {
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' }, repo: 'org/a', runs: 2,
  execution: { succeeded: 1, running: 1, failed: 0, stopped: 0 },
  assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 2 }, outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 2 },
  costEstimate: { ...stale, runsWithoutUsage: 0, rateSource: 'Old policy', ratesAsOf: '2020-01-01' },
  knownCostUsd: 999, observedCostUsd: 999, runsWithKnownCost: 2, costCoverage: 1, averageCostUsd: 499.5,
  averageDurationMs: null, runsWithDuration: 0, inputTokens: 999, cachedInputTokens: 999, outputTokens: 999, totalTokens: 999,
  linkedPrs: 0, unknownPrs: 0, stalePrs: 0, unavailablePrs: 0, publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0,
  costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null, correctionRounds: null, failures: [],
  daily: ['2026-01-01', '2026-01-02'].map(date => ({ date, runs: 1, succeeded: 0, running: 1, failed: 0, stopped: 0,
    knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costEstimate: stale })),
  recentRuns: ['one', 'two'].map(runId => ({ runId, repo: 'org/a', status: 'running', prNumber: null,
    startedAt: '2026-01-01T00:00:00Z', durationMs: null, costUsd: null, observedCostUsd: null, assessment: null, costEstimate: stale })),
};
const usage: UsageSnapshot = {
  version: 1, currency: 'USD', repo: 'org/a', window: summary.window,
  runs: [{ runId: 'one', repo: 'org/a', status: 'succeeded', startedAt: '2026-01-01T12:00:00Z', endedAt: null, reportedCostUsd: 5 },
    { runId: 'two', repo: 'org/a', status: 'running', startedAt: '2026-01-01T20:00:00-08:00', endedAt: null, reportedCostUsd: null }],
  records: [{ runId: 'one', attempt: 1, eventId: 'paid', provider: 'example', model: 'm', inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, totalTokens: 10, costUsd: 5 },
    ...['a', 'b'].map(eventId => ({ runId: 'two', attempt: 1, eventId, provider: 'example', model: 'm', inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, totalTokens: 10, costUsd: null }))],
  reported: { observedCostUsd: 5, knownCostUsd: 5, runsWithKnownCost: 1, runsWithoutUsage: 0,
    inputTokens: 15, cachedInputTokens: 0, outputTokens: 15, totalTokens: 30 },
};
const pricing: PricingEstimate = { version: 1, currency: 'USD', estimatedUnreportedCostUsd: 1.25, estimatedUsageEvents: 1,
  unreportedUsageEvents: 2, provenance: { source: 'Example rates', rateVersion: 'v2', asOf: '2026-01-01' },
  records: [{ runId: 'two', attempt: 1, eventId: 'a', estimatedCostUsd: 1.25 }, { runId: 'two', attempt: 1, eventId: 'b', estimatedCostUsd: null }],
};

describe('public Costs reporting', () => {
  it('uses durable measured totals and selected-provider record identities without mutating either input', () => {
    const report = presentCostsReport(summary, usage, pricing);
    expect(report).toMatchObject({ observedCostUsd: 5, knownCostUsd: 5, averageCostUsd: 5, totalTokens: 30,
      costCoverage: 0.5, costEstimate: { estimatedUnreportedCostUsd: 1.25, rateSource: 'Example rates' } });
    expect(report.recentRuns[1]?.costEstimate).toMatchObject({ estimatedUnreportedCostUsd: 1.25, estimatedUsageEvents: 1, unreportedUsageEvents: 2 });
    expect(report.daily[0]?.costEstimate?.estimatedUnreportedCostUsd).toBeNull();
    expect(report.daily[1]?.costEstimate?.estimatedUnreportedCostUsd).toBe(1.25);
    expect(summary.observedCostUsd).toBe(999);
    expect(summary.daily[0]?.costEstimate).toBe(stale);
    expect(usage.reported.observedCostUsd).toBe(5);
  });

  it('removes all stale legacy estimates when the selected provider is unavailable', () => {
    const report = presentCostsReport(summary, usage, null);
    expect(report.observedCostUsd).toBe(5);
    expect(report.costEstimate).toBeUndefined();
    expect(report.daily.every(day => day.costEstimate === undefined)).toBe(true);
    expect(report.recentRuns.every(run => run.costEstimate === undefined)).toBe(true);
    expect(report.pricing).toEqual({ status: 'unavailable', estimate: null });
  });

  it('keeps run/day amounts unknown for a provider that only supplies aggregate estimates', () => {
    const { records: _records, ...aggregate } = pricing;
    const report = presentCostsReport(summary, usage, aggregate);
    expect(report.costEstimate?.estimatedUnreportedCostUsd).toBe(1.25);
    expect(report.daily.every(day => day.costEstimate === undefined)).toBe(true);
    expect(report.recentRuns.every(run => run.costEstimate === undefined)).toBe(true);
  });

  it('excludes concurrent or unrelated pricing records absent from the displayed measured snapshot', () => {
    const report = presentCostsReport(summary, usage, { ...pricing, estimatedUnreportedCostUsd: 41.25, estimatedUsageEvents: 2,
      records: [...pricing.records!, { runId: 'later-run', attempt: 1, eventId: 'a', estimatedCostUsd: 40 }] });
    expect(report.costEstimate).toMatchObject({ estimatedUnreportedCostUsd: 1.25, estimatedUsageEvents: 1, unreportedUsageEvents: 2 });
  });

  it('rejects aggregate-only pricing from a different recorded usage set', () => {
    const { records: _records, ...aggregate } = pricing;
    const report = presentCostsReport(summary, usage, { ...aggregate, unreportedUsageEvents: 3 });
    expect(report.observedCostUsd).toBe(5);
    expect(report.costEstimate).toBeUndefined();
    expect(report.pricing?.status).toBe('unavailable');
  });

  it('reads measured usage with the report window and keeps a pricing failure from hiding recorded data', async () => {
    const signal = new AbortController().signal;
    const services: PluginPageServices = { version: 1, usage: { query: vi.fn(async () => usage) },
      outcomes: { summary: vi.fn(async () => summary), assessment: vi.fn() },
      pricing: { estimate: vi.fn(async () => { throw new Error('Selected provider disabled'); }) } };
    const report = await readCostsReport(services, 'org/a', 30, signal);
    expect(services.outcomes.summary).toHaveBeenCalledWith('org/a', 30, signal);
    expect(services.usage.query).toHaveBeenCalledWith({ version: 1, repo: 'org/a', from: summary.window.from, to: summary.window.to }, signal);
    expect(report.observedCostUsd).toBe(5);
    expect(report.pricing?.status).toBe('unavailable');
  });
});
