import type { PluginBackendModule, PricingEstimate } from '@helmsman/plugin-sdk';

const plugin: PluginBackendModule = {
  activate(context) {
    context.registerPricing('flat', {
      async estimate(snapshot): Promise<PricingEstimate> {
        const rate = context.settings.usdPerMillionTokens;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error('Invalid configured rate');
        const records = snapshot.records.filter(record => record.costUsd === null).map(record => ({
          runId: record.runId, attempt: record.attempt, eventId: record.eventId,
          estimatedCostUsd: record.totalTokens === null ? null : record.totalTokens * rate / 1_000_000,
        }));
        const amounts = records.flatMap(record => record.estimatedCostUsd === null ? [] : [record.estimatedCostUsd]);
        await context.storage.set('last-rate', rate);
        return { version: 1, currency: 'USD', provenance: { source: 'Operator-configured flat token rate', rateVersion: `flat-${rate}`, asOf: '2026-09-20' },
          estimatedUnreportedCostUsd: amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
          estimatedUsageEvents: amounts.length, unreportedUsageEvents: records.length, records };
      },
    });
  },
};
export default plugin;
