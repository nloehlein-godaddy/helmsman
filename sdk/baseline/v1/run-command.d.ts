import { type WorkRefV1 } from "./tasks.js";
export type RunCommandLaunchV1 = ({
    readonly mode: 'source';
    readonly workRef: WorkRefV1;
    readonly sourceInstanceId: string;
    readonly sourceInstanceRevision: number;
} | {
    readonly mode: 'freeform';
    readonly task: string;
} | {
    readonly mode: 'review';
    readonly prNumber: number;
    readonly headSha?: string;
} | {
    readonly mode: 'rerun';
    readonly prNumber: number;
    readonly feedback: string;
}) & {
    readonly model?: string;
    readonly effort?: string;
};
export interface RunCommandTargetV1 {
    readonly runId: string;
    readonly expectedAttempt: number;
}
export type RunCommandInputV1 = {
    readonly version: 1;
    readonly repo: string;
} & ({
    readonly action: 'stop';
    readonly target: RunCommandTargetV1;
} | {
    readonly action: 'retry';
    readonly target: RunCommandTargetV1;
} | {
    readonly action: 'launch';
    readonly launch: RunCommandLaunchV1;
});
export type RunCommandV1 = RunCommandInputV1 & {
    readonly requestId: string;
};
export interface RunCommandReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export interface RunCommandNotAdmittedResolutionV1 {
    readonly version: 1;
    readonly id: string;
    readonly kind: 'not-admitted';
    readonly runId: string;
    readonly attempt: number;
}
export interface RunCommandReceiptV1 extends RunCommandReceiptQueryV1 {
    readonly version: 1;
    readonly action: RunCommandInputV1['action'];
    readonly status: 'accepted' | 'rejected' | 'pending' | 'recovery-required';
    readonly runId: string | null;
    readonly attempt: number | null;
    readonly message: string | null;
    readonly resolution?: RunCommandNotAdmittedResolutionV1;
}
export interface RunCommandPendingV1 {
    readonly command: RunCommandV1;
    readonly receipt: RunCommandReceiptV1 | null;
}
export type RunCommandUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict';
export type RunCommandResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: RunCommandUnavailableReasonV1;
};
export interface RunCommandServiceV1 {
    readonly version: 1;
    submit(input: RunCommandInputV1, signal?: AbortSignal): Promise<RunCommandResultV1<RunCommandReceiptV1>>;
    retry?(query: RunCommandReceiptQueryV1, signal?: AbortSignal): Promise<RunCommandResultV1<RunCommandReceiptV1>>;
    receipt(input: RunCommandReceiptQueryV1, signal?: AbortSignal): Promise<RunCommandResultV1<RunCommandReceiptV1 | null>>;
    pending(): Promise<readonly RunCommandPendingV1[]>;
    acknowledge(input: RunCommandReceiptQueryV1): Promise<void>;
}
export declare const RUN_COMMAND_LIMITS: Readonly<{
    task: number;
    feedback: number;
    message: number;
    responseBytes: number;
}>;
export declare class RunCommandValidationError extends Error {
}
export declare function parseRunCommandInputV1(input: unknown): RunCommandInputV1;
export declare function parseRunCommandV1(input: unknown): RunCommandV1;
export declare function parseRunCommandReceiptQueryV1(input: unknown): RunCommandReceiptQueryV1;
export declare function parseRunCommandReceiptV1(input: unknown, expected?: RunCommandReceiptQueryV1 & {
    action?: RunCommandInputV1['action'];
    target?: RunCommandTargetV1;
}): RunCommandReceiptV1;
