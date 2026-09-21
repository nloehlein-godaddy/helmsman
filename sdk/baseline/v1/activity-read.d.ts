import { type WorkRefV1 } from "./tasks.js";
import { type TaskReadSelectionV1, type TaskReadResultV1 } from "./task-read.js";
export type ActivityReadQualityV1 = 'complete' | 'partial' | 'unavailable';
export interface TaskHistoryQueryV1 {
    readonly repo: string;
    readonly from: string;
    readonly until: string;
    readonly eventLimit: number;
}
export interface TaskHistoryEventV1 {
    readonly id: string;
    readonly ref: WorkRefV1;
    readonly displayKey: string;
    readonly title: string;
    readonly url: string | null;
    readonly at: string;
    readonly kind: 'created' | 'updated' | 'completed' | 'status-changed';
    readonly status: string | null;
}
export interface TaskHistoryV1 {
    readonly version: 1;
    readonly repo: string;
    readonly from: string;
    readonly until: string;
    readonly events: readonly TaskHistoryEventV1[];
    readonly historyQuality: ActivityReadQualityV1;
    /** Current Done tasks grouped by their retained completion date; reopened/deleted tasks are excluded. */
    readonly days: readonly {
        readonly date: string;
        readonly completed: number | null;
    }[];
    readonly throughputQuality: ActivityReadQualityV1;
}
export interface ActivityReadSnapshotV1 {
    readonly selection: TaskReadSelectionV1;
    readonly history: TaskHistoryV1;
}
export interface ActivityReadServiceV1 {
    readonly version: 1;
    query(selection: TaskReadSelectionV1, signal?: AbortSignal): Promise<TaskReadResultV1<ActivityReadSnapshotV1>>;
}
export declare const ACTIVITY_READ_LIMITS: Readonly<{
    events: number;
    responseBytes: number;
}>;
export declare class ActivityReadValidationError extends Error {
}
export declare function activityReadWindow(now: Date): {
    readonly from: string;
    readonly until: string;
};
export declare function parseTaskHistoryQueryV1(input: unknown): TaskHistoryQueryV1;
export declare function parseTaskHistoryV1(input: unknown, query: TaskHistoryQueryV1, sourceId: string): TaskHistoryV1;
export declare function parseActivityReadSnapshotV1(input: unknown, selection: TaskReadSelectionV1): ActivityReadSnapshotV1;
