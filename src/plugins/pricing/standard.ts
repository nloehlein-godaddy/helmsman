import type { PluginBackendModule, PricingEstimate, ProviderUsage, UsageSnapshot } from '@helmsman/plugin-sdk';

export const RATE_SOURCE = 'https://developers.openai.com/api/docs/pricing';
export const RATE_DATE = '2026-09-19';
const rates = new Map<string, readonly [number, number, number]>([
  ['gpt-6-astra', [10, 1, 50]],
  ['gpt-5.6-sol', [4, 0.4, 20]],
  ['gpt-5.6-terra', [2, 0.2, 12]],
]);

export function estimateRecord(usage: ProviderUsage): number | null {
  if (!usage || usage.costUsd !== null || usage.provider !== 'codex' || !usage.model) return null;
  const rate = rates.get(usage.model);
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  if (!rate || ![inputTokens, cachedInputTokens, outputTokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || inputTokens === null || cachedInputTokens === null || outputTokens === null || cachedInputTokens > inputTokens) return null;
  return ((inputTokens - cachedInputTokens) * rate[0] + cachedInputTokens * rate[1] + outputTokens * rate[2]) / 1_000_000;
}

export function estimateSnapshot(snapshot: UsageSnapshot): PricingEstimate {
  const records = snapshot.records.filter(record => record.costUsd === null).map(record => ({
    runId: record.runId, attempt: record.attempt, eventId: record.eventId, estimatedCostUsd: estimateRecord(record),
  }));
  const amounts = records.flatMap(record => record.estimatedCostUsd === null ? [] : [record.estimatedCostUsd]);
  return { version: 1, currency: 'USD', provenance: { source: RATE_SOURCE, rateVersion: 'standard-short-context-v1', asOf: RATE_DATE },
    estimatedUnreportedCostUsd: amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
    estimatedUsageEvents: amounts.length, unreportedUsageEvents: records.length, records };
}

const plugin: PluginBackendModule = {
  activate(context) { context.registerPricing('standard', { estimate: estimateSnapshot }); },
};
export default plugin;
