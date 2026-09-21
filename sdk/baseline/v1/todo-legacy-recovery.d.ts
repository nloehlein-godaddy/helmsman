import { type WorkRefV1 } from "./tasks.js";
export interface LegacyTodoCommandQuery {
    readonly requestId: string;
    readonly path: string;
    readonly method: 'POST' | 'PUT' | 'DELETE';
    readonly input: unknown;
}
export interface LegacyTodoCommandReceipt {
    readonly version: 1;
    readonly requestId: string;
    readonly commandId: 'create' | 'update' | 'delete';
    readonly repo: string | null;
    readonly status: 'succeeded' | 'rejected' | 'pending' | 'unrecorded' | 'blocked';
    readonly reason: 'not-recorded' | 'mutation-unconfirmed' | 'original-authority-unavailable' | 'mutation-proof-mismatch' | null;
    readonly message: string | null;
    readonly result: {
        readonly kind: 'changed';
        readonly ref: WorkRefV1;
        readonly repo: string;
        readonly revision: string;
    } | {
        readonly kind: 'deleted';
        readonly ref: WorkRefV1;
        readonly repo: string;
    } | {
        readonly kind: 'not-found';
        readonly ref: WorkRefV1;
    } | null;
}
export interface TodoLegacyPendingV1 {
    readonly requestId: string;
    readonly commandId: LegacyTodoCommandReceipt['commandId'];
    readonly externalId: string | null;
}
export type TodoLegacyRecoveryResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: 'all-galleons-required' | 'storage-unavailable' | 'invalid-storage' | 'request-changed' | 'confirmation-required' | 'service-unavailable' | 'invalid-response' | 'timeout';
};
/** @deprecated Recovery-only for historical Todo journals. Use SourceCommandServiceV1 for new commands; retained journals must remain recoverable. */
export interface TodoLegacyRecoveryServiceV1 {
    readonly version: 1;
    pending(signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<readonly TodoLegacyPendingV1[]>>;
    check(requestId: string, signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<LegacyTodoCommandReceipt>>;
    acknowledge(requestId: string, signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<void>>;
}
export declare function parseLegacyTodoCommandQuery(input: unknown): LegacyTodoCommandQuery;
export declare function legacyTodoPending(query: LegacyTodoCommandQuery): TodoLegacyPendingV1;
export declare function parseLegacyTodoCommandReceipt(input: unknown, query: LegacyTodoCommandQuery): LegacyTodoCommandReceipt;
