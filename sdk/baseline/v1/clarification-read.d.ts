export type ClarificationReadStateV1 = 'pending' | 'answered' | 'timed-out' | 'cancelled';
export type ClarificationReadOwnerV1 = 'local' | 'trusted-contact';
export type ClarificationAnswerUnavailableReasonV1 = 'provenance-unknown' | 'different-attempt' | 'not-pending' | 'run-unavailable' | 'run-inactive' | 'stop-requested' | 'deadline-expired' | 'channel-unavailable';
export type ClarificationReadUnavailableReasonV1 = 'forbidden' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict' | 'cursor-invalid';
export type ClarificationReadResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: ClarificationReadUnavailableReasonV1;
};
export interface ClarificationReadListQueryV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly runId: string | null;
    readonly states: readonly ClarificationReadStateV1[];
    readonly limit: number;
    readonly cursor: string | null;
}
export interface ClarificationReadLoadQueryV1 {
    readonly version: 1;
    readonly repo: string;
    readonly runId: string;
    readonly questionId: string;
}
export interface ClarificationReadItemV1 {
    readonly version: 1;
    readonly id: string;
    readonly runId: string;
    readonly repo: string;
    readonly revision: number;
    readonly prompt: string;
    readonly required: boolean;
    readonly owner: ClarificationReadOwnerV1;
    readonly contactId: string | null;
    readonly state: ClarificationReadStateV1;
    readonly answer: string | null;
    readonly createdAt: string;
    readonly timeoutAt: string | null;
    readonly answeredAt: string | null;
    readonly provenance: {
        readonly kind: 'attempt-channel';
        readonly attempt: number;
        readonly channelId: string;
    } | {
        readonly kind: 'legacy-unproven';
        readonly attempt: null;
        readonly channelId: null;
    };
    readonly currentAttempt: number | null;
    readonly blocksPublication: boolean;
    readonly answerability: {
        readonly available: true;
        readonly reason: null;
    } | {
        readonly available: false;
        readonly reason: ClarificationAnswerUnavailableReasonV1;
    };
}
export interface ClarificationReadPageV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly items: readonly ClarificationReadItemV1[];
    readonly nextCursor: string | null;
    readonly total: number | null;
    readonly observedAt: string;
}
export interface ClarificationReadServiceV1 {
    readonly version: 1;
    list(input: ClarificationReadListQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationReadPageV1>>;
    load(input: ClarificationReadLoadQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationReadItemV1>>;
}
export declare const CLARIFICATION_READ_LIMITS: Readonly<{
    responseBytes: number;
    page: number;
}>;
export declare const CLARIFICATION_ANSWER_UNAVAILABLE_REASONS: readonly ClarificationAnswerUnavailableReasonV1[];
export declare function parseClarificationReadListQueryV1(input: unknown): ClarificationReadListQueryV1;
export declare function parseClarificationReadLoadQueryV1(input: unknown): ClarificationReadLoadQueryV1;
export declare function parseClarificationReadItemV1(input: unknown, expected?: ClarificationReadLoadQueryV1): ClarificationReadItemV1;
export declare function parseClarificationReadPageV1(input: unknown, query?: ClarificationReadListQueryV1, repos?: readonly string[]): ClarificationReadPageV1;
