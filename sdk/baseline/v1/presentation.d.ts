export type PresentationLocatorV1 = {
    readonly version: 1;
    readonly kind: 'run';
    readonly repo: string;
    readonly runId: string;
} | {
    readonly version: 1;
    readonly kind: 'legacy-run';
    readonly runId: string;
} | {
    readonly version: 1;
    readonly kind: 'pull-request';
    readonly repo: string;
    readonly number: number;
};
export declare function parsePresentationLocatorV1(input: unknown): PresentationLocatorV1 | null;
export declare function samePresentationLocatorV1(a: PresentationLocatorV1 | null | undefined, b: PresentationLocatorV1 | null | undefined): boolean;
export declare function scopedPresentationLocatorV1(input: unknown, repo: string | null): PresentationLocatorV1 | null;
export interface PullRequestRouteV1 {
    readonly version: 1;
    readonly repo: string;
    readonly number: number;
    readonly mode: 'review' | 'rerun' | null;
}
export declare function parsePullRequestRouteV1(input: unknown): PullRequestRouteV1 | null;
export declare function samePullRequestRouteV1(a: PullRequestRouteV1 | null | undefined, b: PullRequestRouteV1 | null | undefined): boolean;
