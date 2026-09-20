import type { ProviderUsage, UsageCostEstimate } from '../../src/plugins/usage';

import { estimateRecord } from '../../src/plugins/pricing/standard';
export { RATE_SOURCE as COST_ESTIMATE_SOURCE, RATE_DATE as COST_ESTIMATE_DATE, estimateRecord as estimateUnreportedUsage } from '../../src/plugins/pricing/standard';

export function summarizeCostEstimates(reports: ProviderUsage[]): UsageCostEstimate {
  const missing = reports.filter(report => report.costUsd === null);
  const estimates = missing.flatMap(report => {
    const estimate = estimateRecord(report);
    return estimate === null ? [] : [estimate];
  });
  return {
    estimatedUnreportedCostUsd: estimates.length ? estimates.reduce((sum, estimate) => sum + estimate, 0) : null,
    estimatedUsageEvents: estimates.length,
    unreportedUsageEvents: missing.length,
  };
}
