export type PullRequestReadKindV1 = 'repo-open' | 'authored-recent' | 'review-requested';
export type PullRequestReadQualityV1 = 'complete' | 'partial' | 'degraded';
export interface PullRequestReadQueryV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly kind: PullRequestReadKindV1;
    readonly limit: number;
}
export interface PullRequestReadItemV1 {
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly url: string | null;
    readonly status: 'open' | 'closed' | 'merged';
    readonly createdAt: string;
    readonly mergedAt: string | null;
    readonly draft: boolean | null;
    readonly ticketId: string | null;
    readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
    readonly comments: number | null;
    readonly reviews: {
        readonly approved: number | null;
        readonly changesRequested: number | null;
        readonly commented: number | null;
        readonly requested: number | null;
    } | null;
}
export interface PullRequestReadPageV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly kind: PullRequestReadKindV1;
    readonly items: readonly PullRequestReadItemV1[];
    readonly quality: PullRequestReadQualityV1;
    readonly truncated: boolean;
    readonly browseUrl: string | null;
}
export type PullRequestReadUnavailableReasonV1 = 'forbidden' | 'selection-required' | 'selection-changed' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type PullRequestReadResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: PullRequestReadUnavailableReasonV1;
};
export interface PullRequestReadServiceV1 {
    readonly version: 1;
    list(query: PullRequestReadQueryV1, signal?: AbortSignal): Promise<PullRequestReadResultV1<PullRequestReadPageV1>>;
    watchList(query: PullRequestReadQueryV1, listener: (result: PullRequestReadResultV1<PullRequestReadPageV1>) => void, signal?: AbortSignal): () => void;
}
export declare const PULL_REQUEST_READ_LIMITS: Readonly<{
    page: number;
    responseBytes: number;
    repos: number;
}>;
export declare class PullRequestReadValidationError extends Error {
}
export declare function parsePullRequestReadQueryV1(input: unknown): PullRequestReadQueryV1;
export declare function parsePullRequestReadItemV1(input: unknown): PullRequestReadItemV1;
export declare function parsePullRequestReadPageV1(input: unknown, query: PullRequestReadQueryV1, repos: readonly string[]): PullRequestReadPageV1;
