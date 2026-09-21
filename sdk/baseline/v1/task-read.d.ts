import type { TaskSnapshotV1, WorkRefV1 } from "./tasks.js";
export type TaskReadUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'disabled' | 'source-unavailable' | 'view-unavailable' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type TaskReadResultV1<T> = {
    readonly status: 'available';
    readonly value: T;
} | {
    readonly status: 'unavailable';
    readonly reason: TaskReadUnavailableReasonV1;
};
export interface TaskReadSelectionV1 {
    readonly version: 1;
    readonly sourceId: string;
    readonly instanceId: string;
    readonly instanceRevision: number;
    readonly repo: string;
}
export interface TaskReadSourceV1 extends TaskReadSelectionV1 {
    readonly readViews?: readonly ('underway' | 'history' | 'triage' | 'bugs')[];
    readonly label: string;
    readonly availability: 'available' | 'disabled' | 'unavailable';
}
export type TaskReadTaskV1 = Omit<TaskSnapshotV1, 'providerData'>;
export interface TaskReadDiscoveryV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly galleons: readonly {
        readonly repo: string;
        readonly sources: TaskReadResultV1<readonly TaskReadSourceV1[]>;
    }[];
}
export interface TaskReadListQueryV1 extends TaskReadSelectionV1 {
    readonly state: TaskReadTaskV1['state'] | null;
    readonly cursor: string | null;
    readonly limit: number;
}
export interface TaskReadLoadQueryV1 extends TaskReadSelectionV1 {
    readonly ref: WorkRefV1;
}
export interface TaskReadLookupQueryV1 extends TaskReadSelectionV1 {
    readonly displayKey: string;
}
export interface TaskReadUnderwayQueryV1 extends TaskReadSelectionV1 {
    readonly cursor: string | null;
    readonly limit: number;
}
export interface TaskReadPageV1 {
    readonly selection: TaskReadSelectionV1;
    readonly items: readonly TaskReadTaskV1[];
    readonly nextCursor: string | null;
}
export interface TaskReadItemV1 {
    readonly selection: TaskReadSelectionV1;
    readonly ref: WorkRefV1;
    readonly task: TaskReadTaskV1 | null;
}
export interface TaskReadServiceV1 {
    readonly version: 1;
    discover(signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadDiscoveryV1>>;
    list(input: TaskReadListQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadPageV1>>;
    load(input: TaskReadLoadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadItemV1>>;
    lookup?(input: TaskReadLookupQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadItemV1 | null>>;
    underway?(input: TaskReadUnderwayQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadPageV1>>;
}
export declare const TASK_READ_LIMITS: Readonly<{
    galleons: number;
    instances: number;
    discoveryConcurrency: number;
    responseBytes: number;
}>;
export declare class TaskReadValidationError extends Error {
}
export declare function parseTaskReadSelectionV1(input: unknown): TaskReadSelectionV1;
export declare function parseTaskReadListQueryV1(input: unknown): TaskReadListQueryV1;
export declare function parseTaskReadLoadQueryV1(input: unknown): TaskReadLoadQueryV1;
export declare function parseTaskReadLookupQueryV1(input: unknown): TaskReadLookupQueryV1;
export declare function parseTaskReadLookupRef(input: unknown, query: TaskReadLookupQueryV1): WorkRefV1 | null;
export declare function parseTaskReadUnderwayQueryV1(input: unknown): TaskReadUnderwayQueryV1;
export declare function parseTaskReadGalleons(input: unknown): readonly string[];
export declare function parseTaskReadSources(input: unknown, repo: string): readonly TaskReadSourceV1[];
export declare function parseTaskReadPage(input: unknown, query: TaskReadListQueryV1): TaskReadPageV1;
export declare function parseTaskReadItem(input: unknown, query: TaskReadLoadQueryV1): TaskReadItemV1;
