import type { UsageCostEstimate } from "./usage.js";
export type { ProviderUsage, UsageCostEstimate } from "./usage.js";
export declare const ASSESSMENT_STATES: readonly [
    "complete",
    "partial",
    "failed",
    "not-assessed"
];
export declare const TASK_OUTCOMES: readonly [
    "achieved",
    "partial",
    "not-achieved",
    "unknown"
];
export interface OutcomeAssessment {
    source?: 'manual' | 'telemetry';
    runId: string;
    state: typeof ASSESSMENT_STATES[number];
    outcome: typeof TASK_OUTCOMES[number];
    summary: string;
    evidence: string[];
    failureStage: string | null;
    correctionRounds: number | null;
    updatedAt: string;
}
export interface OutcomePullRequest {
    repo: string;
    number: number;
    published: boolean;
    reviewed: boolean;
    merged: boolean;
    availability?: 'known' | 'stale' | 'unavailable';
}
export interface OutcomeDay {
    costEstimate?: UsageCostEstimate;
    date: string;
    runs: number;
    succeeded: number;
    failed: number;
    stopped: number;
    running: number;
    knownCostUsd: number | null;
    observedCostUsd: number | null;
    runsWithKnownCost: number;
}
export interface OutcomeRun {
    costEstimate?: UsageCostEstimate;
    runId: string;
    repo: string;
    status: 'running' | 'succeeded' | 'failed' | 'stopped';
    prNumber: number | null;
    startedAt: string;
    durationMs: number | null;
    costUsd: number | null;
    observedCostUsd: number | null;
    assessment: OutcomeAssessment | null;
}
export interface OutcomeSummary {
    costEstimate?: UsageCostEstimate & {
        runsWithoutUsage: number;
        rateSource: string;
        ratesAsOf: string;
    };
    window: {
        from: string;
        to: string;
    };
    repo: string | null;
    runs: number;
    execution: Record<OutcomeRun['status'], number>;
    assessments: Record<OutcomeAssessment['state'], number>;
    outcomes: Record<OutcomeAssessment['outcome'], number>;
    knownCostUsd: number | null;
    observedCostUsd: number | null;
    runsWithKnownCost: number;
    costCoverage: number | null;
    averageCostUsd: number | null;
    averageDurationMs: number | null;
    runsWithDuration: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    linkedPrs: number;
    unknownPrs: number;
    stalePrs: number;
    unavailablePrs: number;
    publishedPrs: number;
    reviewedPrs: number;
    mergedPrs: number;
    costPerPublishedPrUsd: number | null;
    costPerReviewedPrUsd: number | null;
    costPerMergedPrUsd: number | null;
    correctionRounds: number | null;
    failures: Array<{
        stage: string;
        count: number;
    }>;
    daily: OutcomeDay[];
    recentRuns: OutcomeRun[];
}
export declare const OUTCOME_WINDOWS: readonly [
    7,
    30,
    90,
    365
];
export type OutcomeWindow = typeof OUTCOME_WINDOWS[number];
export interface AssessmentInput {
    state: OutcomeAssessment['state'];
    outcome: OutcomeAssessment['outcome'];
    summary: string;
    evidence: string[];
    failureStage: string | null;
    correctionRounds: number | null;
}
