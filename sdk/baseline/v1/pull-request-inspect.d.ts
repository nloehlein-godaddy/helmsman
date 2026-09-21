export interface PullRequestInspectDetailQueryV1 {
    readonly version: 1;
    readonly repo: string;
    readonly number: number;
}
export interface PullRequestInspectTargetV1 {
    readonly repo: string;
    readonly number: number;
    readonly headSha: string;
    readonly baseSha: string;
}
export interface PullRequestInspectDiffQueryV1 {
    readonly version: 1;
    readonly target: PullRequestInspectTargetV1;
}
export type PullRequestInspectQualityV1 = 'complete' | 'partial' | 'unavailable';
export type PullRequestInspectReviewV1 = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
/** Ownership and viewer reviews refer to the configured author, not authenticated publication authority. */
export interface PullRequestInspectDetailV1 {
    readonly version: 1;
    readonly target: PullRequestInspectTargetV1;
    readonly observedAt: string;
    readonly title: string;
    readonly url: string;
    readonly status: 'open' | 'closed' | 'merged';
    readonly draft: boolean;
    readonly authorLogin: string | null;
    readonly isOwnPr: boolean | null;
    readonly headRefName: string;
    readonly updatedAt: string;
    readonly comments: number | null;
    readonly checks: {
        readonly quality: PullRequestInspectQualityV1;
        readonly passed: number | null;
        readonly failed: number | null;
        readonly pending: number | null;
    };
    readonly reviews: {
        readonly quality: PullRequestInspectQualityV1;
        readonly approved: number | null;
        readonly changesRequested: number | null;
        readonly commented: number | null;
        readonly requested: number | null;
        readonly viewerReview: PullRequestInspectReviewV1 | null;
        readonly viewerReviewedAt: string | null;
        readonly viewerReviewedCommitId: string | null;
    };
}
export interface PullRequestInspectFileV1 {
    readonly filename: string;
    readonly previousFilename: string | null;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    readonly patch: string | null;
    readonly patchStatus: 'preview' | 'truncated' | 'unavailable';
}
export interface PullRequestInspectDiffV1 {
    readonly version: 1;
    readonly target: PullRequestInspectTargetV1;
    readonly observedAt: string;
    readonly coverage: 'immutable-comparison-preview';
    readonly quality: 'complete' | 'partial';
    readonly truncated: boolean;
    readonly files: readonly PullRequestInspectFileV1[];
}
export type PullRequestInspectUnavailableReasonV1 = 'forbidden' | 'not-found' | 'selection-changed' | 'head-changed' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type PullRequestInspectResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: PullRequestInspectUnavailableReasonV1;
};
export interface PullRequestInspectServiceV1 {
    readonly version: 1;
    detail(query: PullRequestInspectDetailQueryV1, signal?: AbortSignal): Promise<PullRequestInspectResultV1<PullRequestInspectDetailV1>>;
    diff(query: PullRequestInspectDiffQueryV1, signal?: AbortSignal): Promise<PullRequestInspectResultV1<PullRequestInspectDiffV1>>;
}
export declare const PULL_REQUEST_INSPECT_LIMITS: Readonly<{
    files: number;
    providerFiles: number;
    page: number;
    pages: number;
    patch: number;
    patches: number;
    responseBytes: number;
    transportBytes: number;
    repos: number;
}>;
export declare class PullRequestInspectValidationError extends Error {
}
export declare function parsePullRequestInspectDetailQueryV1(input: unknown): PullRequestInspectDetailQueryV1;
export declare function parsePullRequestInspectTargetV1(input: unknown): PullRequestInspectTargetV1;
export declare function parsePullRequestInspectDiffQueryV1(input: unknown): PullRequestInspectDiffQueryV1;
export declare function parsePullRequestInspectDetailV1(input: unknown, query: PullRequestInspectDetailQueryV1): PullRequestInspectDetailV1;
export declare function parsePullRequestInspectDiffV1(input: unknown, query: PullRequestInspectDiffQueryV1): PullRequestInspectDiffV1;
