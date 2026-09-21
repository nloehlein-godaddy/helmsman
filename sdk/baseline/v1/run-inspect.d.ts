import type { RunReadListQueryV1, RunReadPageV1, RunReadStatusV1, RunReadUnavailableReasonV1 } from "./run-read.js";
export type RunInspectResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: RunReadUnavailableReasonV1 | 'attempt-changed' | 'cursor-invalid';
};
export interface RunInspectTargetV1 {
    readonly repo: string;
    readonly runId: string;
    readonly expectedAttempt: number;
}
export interface RunInspectResolveQueryV1 {
    readonly version: 1;
    readonly runId: string;
}
export interface RunInspectResolvedV1 {
    readonly version: 1;
    readonly target: RunInspectTargetV1;
    readonly observedAt: string;
}
export interface RunInspectHistoryPageV1 extends RunReadPageV1 {
    readonly total: number | null;
    readonly totalQuality: 'exact' | 'unknown';
    readonly observedAt: string;
    readonly coverage: 'insertion-bounded-current-state';
}
export interface RunInspectLogQueryV1 {
    readonly version: 1;
    readonly target: RunInspectTargetV1;
    readonly direction: 'backward' | 'forward';
    readonly cursor: string | null;
    readonly limit: number;
}
export interface RunInspectLogEventV1 {
    readonly sequence: number;
    readonly at: string;
    readonly kind: string;
    readonly text: string;
    readonly truncated: boolean;
}
export interface RunInspectLogPageV1 {
    readonly version: 1;
    readonly target: RunInspectTargetV1;
    readonly provenance: 'run-wide';
    readonly observedAt: string;
    readonly workerStatus: RunReadStatusV1;
    readonly events: readonly RunInspectLogEventV1[];
    readonly throughSequence: number;
    readonly hasEarlier: boolean;
    readonly hasLater: boolean;
    readonly nextCursor: string | null;
    readonly followCursor: string | null;
}
export interface RunInspectExportQueryV1 {
    readonly version: 1;
    readonly target: RunInspectTargetV1;
}
export interface RunInspectExportMetadataV1 extends RunInspectResolvedV1 {
    readonly provenance: 'run-wide';
    readonly throughSequence: number;
    readonly filename: string;
    readonly contentType: 'text/plain; charset=utf-8';
}
export interface RunInspectExportV1 extends RunInspectExportMetadataV1 {
    readonly stream: ReadableStream<Uint8Array>;
}
export interface RunInspectServiceV1 {
    readonly version: 1;
    resolve(input: RunInspectResolveQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectResolvedV1>>;
    history(input: RunReadListQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectHistoryPageV1>>;
    log(input: RunInspectLogQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectLogPageV1>>;
    exportLog(input: RunInspectExportQueryV1, signal?: AbortSignal): Promise<RunInspectResultV1<RunInspectExportV1>>;
}
export declare const RUN_INSPECT_LIMITS: Readonly<{
    page: number;
    logPage: number;
    logText: number;
    cursor: number;
    responseBytes: number;
    exportChunkBytes: number;
}>;
export declare class RunInspectValidationError extends Error {
}
export declare function parseRunInspectResolveQueryV1(input: unknown): RunInspectResolveQueryV1;
export declare function parseRunInspectTargetV1(input: unknown): RunInspectTargetV1;
export declare function parseRunInspectExportQueryV1(input: unknown): RunInspectExportQueryV1;
export declare function parseRunInspectLogQueryV1(input: unknown): RunInspectLogQueryV1;
export declare function parseRunInspectResolvedV1(input: unknown, query: RunInspectResolveQueryV1, repos: readonly string[]): RunInspectResolvedV1;
export declare function parseRunInspectHistoryPageV1(input: unknown, query: RunReadListQueryV1, repos: readonly string[]): RunInspectHistoryPageV1;
export declare function parseRunInspectLogPageV1(input: unknown, query: RunInspectLogQueryV1): RunInspectLogPageV1;
export declare function parseRunInspectExportMetadataV1(input: unknown, query: RunInspectExportQueryV1): RunInspectExportMetadataV1;
