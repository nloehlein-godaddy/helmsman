export type RunReadStatusV1 = 'running' | 'succeeded' | 'failed' | 'stopped';
export type RunReadUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type RunReadResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: RunReadUnavailableReasonV1;
};
export interface RunReadSettlementV1 {
    readonly state: 'pending' | 'settled' | 'operator-required';
}
export interface RunReadSummaryV1 {
    readonly version: 1;
    readonly id: string;
    readonly repo: string;
    readonly displayKey: string;
    readonly status: RunReadStatusV1;
    readonly attempt: number;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly prNumber: number | null;
    readonly costUsd: number | null;
    readonly review: {
        readonly outcome: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
        readonly verdict: string;
    } | null;
    /** Null while work is running or no source settlement applies; never changes the worker status. */
    readonly sourceSettlement: RunReadSettlementV1 | null;
}
export interface RunReadListQueryV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly kind: 'running' | 'terminal' | 'all';
    readonly limit: number;
    readonly cursor: string | null;
}
export interface RunReadLoadQueryV1 {
    readonly version: 1;
    readonly repo: string;
    readonly runId: string;
}
export interface RunReadLogQueryV1 extends RunReadLoadQueryV1 {
    readonly cursor: string | null;
    readonly limit: number;
}
export interface RunReadPageV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly items: readonly RunReadSummaryV1[];
    readonly nextCursor: string | null;
}
export interface RunReadItemV1 {
    readonly version: 1;
    readonly repo: string;
    readonly runId: string;
    readonly run: RunReadSummaryV1 | null;
}
export interface RunReadLogEventV1 {
    readonly sequence: number;
    readonly at: string;
    readonly kind: string;
    readonly text: string;
    readonly truncated: boolean;
}
export interface RunReadLogPageV1 {
    readonly version: 1;
    readonly repo: string;
    readonly runId: string;
    readonly events: readonly RunReadLogEventV1[];
    readonly nextCursor: string;
    readonly hasMore: boolean;
    readonly earlierTruncated: boolean;
    readonly workerStatus: RunReadStatusV1;
}
export interface RunReadServiceV1 {
    readonly version: 1;
    list(input: RunReadListQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadPageV1>>;
    load(input: RunReadLoadQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadItemV1>>;
    log(input: RunReadLogQueryV1, signal?: AbortSignal): Promise<RunReadResultV1<RunReadLogPageV1>>;
    watchList(input: RunReadListQueryV1, listener: (result: RunReadResultV1<RunReadPageV1>) => void, signal?: AbortSignal): () => void;
    watchLoad(input: RunReadLoadQueryV1, listener: (result: RunReadResultV1<RunReadItemV1>) => void, signal?: AbortSignal): () => void;
    watchLog(input: RunReadLogQueryV1, listener: (result: RunReadResultV1<RunReadLogPageV1>) => void, signal?: AbortSignal): () => void;
}
export declare const RUN_READ_LIMITS: Readonly<{
    page: number;
    logPage: number;
    logText: number;
    responseBytes: number;
    cursor: number;
    repos: number;
}>;
export declare class RunReadValidationError extends Error {
}
export declare function parseRunReadListQueryV1(input: unknown): RunReadListQueryV1;
export declare function parseRunReadLoadQueryV1(input: unknown): RunReadLoadQueryV1;
export declare function parseRunReadLogQueryV1(input: unknown): RunReadLogQueryV1;
export declare function parseRunReadSummaryV1(input: unknown): RunReadSummaryV1;
export declare function parseRunReadPageV1(input: unknown, query: RunReadListQueryV1, repos: readonly string[]): RunReadPageV1;
export declare function parseRunReadItemV1(input: unknown, query: RunReadLoadQueryV1): RunReadItemV1;
export declare function parseRunReadLogPageV1(input: unknown, query: RunReadLogQueryV1): RunReadLogPageV1;
