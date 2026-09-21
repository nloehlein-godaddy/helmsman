import type { ClarificationAnswerUnavailableReasonV1, ClarificationReadResultV1 } from "./clarification-read.js";
export interface ClarificationCommandInputV1 {
    readonly version: 1;
    readonly repo: string;
    readonly runId: string;
    readonly questionId: string;
    readonly expectedAttempt: number;
    readonly expectedChannelId: string;
    readonly expectedQuestionRevision: number;
    readonly answer: string;
}
export interface ClarificationCommandV1 extends ClarificationCommandInputV1 {
    readonly requestId: string;
}
export interface ClarificationCommandReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export type ClarificationCommandRejectionReasonV1 = ClarificationAnswerUnavailableReasonV1 | 'not-found' | 'revision-changed';
export interface ClarificationCommandOutcomeV1 {
    readonly questionId: string;
    readonly revision: number;
    readonly answer: string;
    readonly answeredAt: string;
}
export interface ClarificationCommandReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: ClarificationCommandInputV1;
    readonly status: 'succeeded' | 'rejected';
    readonly result: ClarificationCommandOutcomeV1 | null;
    readonly reason: ClarificationCommandRejectionReasonV1 | null;
}
export interface ClarificationCommandPendingV1 {
    readonly command: ClarificationCommandV1;
    readonly receipt: ClarificationCommandReceiptV1 | null;
}
export interface ClarificationCommandServiceV1 {
    readonly version: 1;
    submit(input: ClarificationCommandInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1>>;
    retry?(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1>>;
    receipt(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1 | null>>;
    pending(): Promise<readonly ClarificationCommandPendingV1[]>;
    acknowledge(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const CLARIFICATION_COMMAND_LIMITS: Readonly<{
    responseBytes: number;
    pending: number;
    aggregateBytes: number;
}>;
export declare function parseClarificationCommandInputV1(input: unknown): ClarificationCommandInputV1;
export declare function parseClarificationCommandV1(input: unknown): ClarificationCommandV1;
export declare function parseClarificationCommandReceiptQueryV1(input: unknown): ClarificationCommandReceiptQueryV1;
export declare function parseClarificationCommandReceiptV1(input: unknown, expected?: ClarificationCommandV1 | ClarificationCommandReceiptQueryV1): ClarificationCommandReceiptV1;
