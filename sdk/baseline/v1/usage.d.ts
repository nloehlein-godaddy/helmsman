export interface ProviderUsage {
    runId: string;
    attempt: number;
    eventId: string;
    provider: string;
    model: string | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
}
export interface UsageCostEstimate {
    estimatedUnreportedCostUsd: number | null;
    estimatedUsageEvents: number;
    unreportedUsageEvents: number;
}
export interface UsageQuery {
    version: 1;
    repo: string | null;
    from: string;
    to: string;
}
export interface UsageRun {
    runId: string;
    repo: string;
    status: 'running' | 'succeeded' | 'failed' | 'stopped';
    startedAt: string;
    endedAt: string | null;
    reportedCostUsd: number | null;
}
export interface UsageTotals {
    observedCostUsd: number | null;
    knownCostUsd: number | null;
    runsWithKnownCost: number;
    runsWithoutUsage: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
}
export interface UsageSnapshot {
    version: 1;
    currency: 'USD';
    repo: string | null;
    window: {
        from: string;
        to: string;
    };
    runs: UsageRun[];
    records: ProviderUsage[];
    reported: UsageTotals;
}
export interface UsageQueryService {
    query(input: UsageQuery): Promise<UsageSnapshot>;
}
export interface PricingEstimate extends UsageCostEstimate {
    version: 1;
    currency: 'USD';
    provenance: {
        source: string;
        rateVersion: string;
        asOf: string;
    };
    records?: readonly {
        runId: string;
        attempt: number;
        eventId: string;
        estimatedCostUsd: number | null;
    }[];
}
