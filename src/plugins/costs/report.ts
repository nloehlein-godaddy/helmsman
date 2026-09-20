import type { OutcomeSummary, PluginPageServices, PricingEstimate, UsageCostEstimate, UsageSnapshot } from '@helmsman/plugin-sdk';

export interface CostsReport extends OutcomeSummary {
  pricing?: { status: 'available' | 'unavailable'; estimate: PricingEstimate | null };
}

const identity = (record: { runId: string; attempt: number; eventId: string }) => JSON.stringify([record.runId, record.attempt, record.eventId]);

function estimates(usage: UsageSnapshot, pricing: PricingEstimate, runIds: ReadonlySet<string>): UsageCostEstimate | undefined {
  if (!pricing.records) return undefined;
  const amounts = new Map(pricing.records.map(record => [identity(record), record.estimatedCostUsd]));
  const records = usage.records.filter(record => runIds.has(record.runId) && record.costUsd === null);
  const known = records.map(record => amounts.get(identity(record))).filter((amount): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0);
  return { unreportedUsageEvents: records.length, estimatedUsageEvents: known.length,
    estimatedUnreportedCostUsd: known.length ? known.reduce((total, amount) => total + amount, 0) : null };
}

export function presentCostsReport(summary: OutcomeSummary, usage: UsageSnapshot, pricing: PricingEstimate | null): CostsReport {
  const reported = usage.reported;
  const scopedEstimate = pricing?.records ? estimates(usage, pricing, new Set(usage.runs.map(run => run.runId))) : null;
  const activePricing = pricing && scopedEstimate ? { ...pricing, ...scopedEstimate }
    : pricing?.unreportedUsageEvents === usage.records.filter(record => record.costUsd === null).length ? pricing : null;
  const byDay = new Map<string, Set<string>>();
  for (const run of usage.runs) {
    const date = new Date(run.startedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    const ids = byDay.get(day) ?? new Set<string>();
    ids.add(run.runId);
    byDay.set(day, ids);
  }
  return {
    ...summary, ...reported,
    averageCostUsd: reported.runsWithKnownCost && reported.knownCostUsd !== null ? reported.knownCostUsd / reported.runsWithKnownCost : null,
    costCoverage: usage.runs.length ? reported.runsWithKnownCost / usage.runs.length : null,
    costEstimate: activePricing ? { estimatedUnreportedCostUsd: activePricing.estimatedUnreportedCostUsd,
      estimatedUsageEvents: activePricing.estimatedUsageEvents, unreportedUsageEvents: activePricing.unreportedUsageEvents,
      runsWithoutUsage: reported.runsWithoutUsage, rateSource: activePricing.provenance.source, ratesAsOf: activePricing.provenance.asOf } : undefined,
    daily: summary.daily.map(day => ({ ...day, costEstimate: activePricing ? estimates(usage, activePricing, byDay.get(day.date) ?? new Set()) : undefined })),
    recentRuns: summary.recentRuns.map(run => ({ ...run, costEstimate: activePricing ? estimates(usage, activePricing, new Set([run.runId])) : undefined })),
    pricing: { status: activePricing ? 'available' : 'unavailable', estimate: activePricing },
  };
}

export async function readCostsReport(services: PluginPageServices, repo: string | null, days: 7 | 30 | 90 | 365, signal: AbortSignal): Promise<CostsReport> {
  const summary = await services.outcomes.summary(repo, days, signal);
  const query = { version: 1 as const, repo, from: summary.window.from, to: summary.window.to };
  const [usage, pricing] = await Promise.all([
    services.usage.query(query, signal),
    services.pricing.estimate(query, signal).catch(() => null),
  ]);
  return presentCostsReport(summary, usage, pricing);
}
