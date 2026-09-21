import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface PullRequestCommandInputV1 {
    readonly version: 1;
    readonly repo: string;
    readonly number: number;
    readonly expectedHeadSha: string;
    readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    readonly body: string;
}
export interface PullRequestCommandV1 extends PullRequestCommandInputV1 {
    readonly requestId: string;
}
export interface PullRequestCommandReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export interface PullRequestCommandOutcomeV1 {
    readonly repo: string;
    readonly number: number;
    readonly headSha: string;
    readonly actor: string;
    readonly reviewId: number;
}
export interface PullRequestCommandReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: PullRequestCommandInputV1;
    readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required';
    readonly result: PullRequestCommandOutcomeV1 | null;
    readonly reason: string | null;
}
export interface PullRequestCommandPendingV1 {
    readonly command: PullRequestCommandV1;
    readonly receipt: PullRequestCommandReceiptV1 | null;
}
export type PullRequestCommandResultV1<T> = ClarificationReadResultV1<T>;
export interface PullRequestCommandServiceV1 {
    readonly version: 1;
    submit(input: PullRequestCommandInputV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1>>;
    retry(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1>>;
    receipt(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1 | null>>;
    pending(): Promise<readonly PullRequestCommandPendingV1[]>;
    acknowledge(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const PULL_REQUEST_COMMAND_LIMITS: Readonly<{
    responseBytes: number;
    pending: number;
    aggregateBytes: number;
}>;
export declare function parsePullRequestCommandInputV1(input: unknown): PullRequestCommandInputV1;
export declare function parsePullRequestCommandV1(input: unknown): PullRequestCommandV1;
export declare function parsePullRequestCommandReceiptQueryV1(input: unknown): PullRequestCommandReceiptQueryV1;
export declare function parsePullRequestCommandReceiptV1(input: unknown, expected?: PullRequestCommandV1 | PullRequestCommandReceiptQueryV1): PullRequestCommandReceiptV1;
