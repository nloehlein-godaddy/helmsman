import type { PluginJson } from "./backend.js";
import { type TaskReadSelectionV1 } from "./task-read.js";
import { type TaskEditorContractV1, type TaskEditActionV1 } from "./task-edit.js";
import { type WorkRefV1 } from "./tasks.js";
export interface SourceCommandTargetV1 {
    readonly ref: WorkRefV1;
    readonly expectedRevision: string;
}
export interface SourceCommandInputV1 {
    readonly version: 1;
    readonly selection: TaskReadSelectionV1;
    readonly sourceRevision: number;
    readonly editor: TaskEditorContractV1;
    readonly action: TaskEditActionV1;
    readonly commandId: string;
    readonly target: SourceCommandTargetV1 | null;
    readonly destinationRepo: string | null;
    readonly input: PluginJson;
}
export interface SourceCommandV1 extends SourceCommandInputV1 {
    readonly requestId: string;
}
export interface SourceCommandReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export type SourceCommandOutcomeV1 = {
    readonly kind: 'changed';
    readonly ref: WorkRefV1;
    readonly repo: string;
    readonly revision: string;
} | {
    readonly kind: 'deleted';
    readonly ref: WorkRefV1;
    readonly repo: string;
    readonly previousRevision: string;
};
export interface SourceCommandReceiptV1 extends Omit<SourceCommandV1, 'input'> {
    readonly status: 'pending' | 'succeeded' | 'rejected' | 'recovery-required';
    readonly result: SourceCommandOutcomeV1 | null;
    readonly message: string | null;
    readonly resolution?: {
        readonly version: 1;
        readonly id: string;
        readonly kind: 'not-applied';
    };
}
export interface SourceCommandPendingV1 {
    readonly command: SourceCommandV1;
    readonly receipt: SourceCommandReceiptV1 | null;
}
export type SourceCommandUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict';
export type SourceCommandResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: SourceCommandUnavailableReasonV1;
};
export interface SourceCommandServiceV1 {
    readonly version: 1;
    submit(input: SourceCommandInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1>>;
    retry?(query: SourceCommandReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1>>;
    receipt(input: SourceCommandReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceCommandReceiptV1 | null>>;
    pending(): Promise<readonly SourceCommandPendingV1[]>;
    acknowledge(input: SourceCommandReceiptQueryV1): Promise<void>;
}
export declare const SOURCE_COMMAND_LIMITS: Readonly<{
    responseBytes: number;
    pending: number;
    aggregateBytes: number;
}>;
export interface SourceCommandDefiniteRejectionV1 {
    readonly version: 1;
    readonly kind: 'rejected';
    readonly message: string;
}
export declare function parseSourceCommandDefiniteRejectionV1(input: unknown): SourceCommandDefiniteRejectionV1;
export declare function parseSourceCommandInputV1(input: unknown): SourceCommandInputV1;
export declare function parseSourceCommandV1(input: unknown): SourceCommandV1;
export declare function parseSourceCommandReceiptQueryV1(input: unknown): SourceCommandReceiptQueryV1;
export declare function parseSourceCommandReceiptV1(input: unknown, expected?: SourceCommandV1 | SourceCommandReceiptQueryV1): SourceCommandReceiptV1;
