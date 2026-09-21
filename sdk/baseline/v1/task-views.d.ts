import { type WorkRefV1, type TaskSnapshotV1 } from "./tasks.js";
import { type TaskReadSelectionV1, type TaskReadResultV1 } from "./task-read.js";
export type TaskViewQualityV1 = 'complete' | 'partial' | 'unavailable';
export type TaskTriageGroupV1 = 'unassigned-backlog' | 'unassigned-todo' | 'mine-open';
export interface TaskTriageQueryV1 {
    readonly repo: string;
    readonly group: TaskTriageGroupV1;
    readonly priorities: readonly number[];
    readonly updatedSince: string | null;
    readonly until: string;
    readonly cursor: string | null;
    readonly limit: number;
}
export interface TaskTriageItemV1 {
    readonly ref: WorkRefV1;
    readonly revision: string;
    readonly displayKey: string;
    readonly title: string;
    readonly url: string | null;
    readonly state: TaskSnapshotV1['state'];
    readonly priority: number;
    readonly updatedAt: string;
}
export interface TaskTriagePageV1 {
    readonly version: 1;
    readonly repo: string;
    readonly group: TaskTriageGroupV1;
    readonly items: readonly TaskTriageItemV1[];
    readonly nextCursor: string | null;
    readonly quality: TaskViewQualityV1;
}
export interface TaskBugsQueryV1 {
    readonly repo: string;
    readonly asOf: string;
    readonly rowLimit: number;
}
export interface TaskBugCountV1 {
    readonly value: number | null;
    readonly quality: 'exact' | 'approximate' | 'unavailable';
}
export interface TaskBugRowV1 {
    readonly ref: WorkRefV1;
    readonly displayKey: string;
    readonly title: string;
    readonly url: string | null;
    readonly priority: string | null;
    readonly severity: string | null;
    readonly dueAt: string | null;
    readonly createdAt: string;
}
export interface TaskBugsReportV1 {
    readonly version: 1;
    readonly repo: string;
    readonly asOf: string;
    readonly open: TaskBugCountV1;
    readonly createdLast7d: TaskBugCountV1;
    readonly completedLast7d: TaskBugCountV1;
    readonly pastSla: TaskBugCountV1;
    readonly rows: readonly TaskBugRowV1[];
    readonly rowsQuality: TaskViewQualityV1;
    readonly oldest: {
        readonly ref: WorkRefV1;
        readonly displayKey: string;
        readonly url: string | null;
        readonly createdAt: string;
    } | null;
    readonly oldestQuality: TaskViewQualityV1;
    readonly resolutionP75: {
        readonly days: number | null;
        readonly sampleSize: number;
        readonly population: TaskBugCountV1;
        readonly quality: TaskViewQualityV1;
        readonly capped: boolean;
    };
}
export type TaskTriageReadQueryV1 = TaskReadSelectionV1 & Omit<TaskTriageQueryV1, 'repo'>;
export interface TaskTriageReadSnapshotV1 {
    readonly selection: TaskReadSelectionV1;
    readonly query: TaskTriageQueryV1;
    readonly page: TaskTriagePageV1;
    readonly relatedRuns: readonly {
        readonly ref: WorkRefV1;
        readonly repo: string;
        readonly runId: string;
    }[];
    readonly relatedRunsQuality: TaskViewQualityV1;
}
export interface TaskBugsReadSnapshotV1 {
    readonly selection: TaskReadSelectionV1;
    readonly report: TaskBugsReportV1;
}
export interface TaskViewsReadServiceV1 {
    readonly version: 1;
    triage(input: TaskTriageReadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskTriageReadSnapshotV1>>;
    bugs(selection: TaskReadSelectionV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskBugsReadSnapshotV1>>;
}
export declare const TASK_VIEW_LIMITS: Readonly<{
    items: number;
    responseBytes: number;
    cursorLength: number;
}>;
export declare class TaskViewValidationError extends Error {
}
export declare function parseTaskTriageQueryV1(input: unknown): TaskTriageQueryV1;
export declare function parseTaskTriagePageV1(input: unknown, query: TaskTriageQueryV1, sourceId: string): TaskTriagePageV1;
export declare function parseTaskBugsQueryV1(input: unknown): TaskBugsQueryV1;
export declare function parseTaskBugCountV1(input: unknown): TaskBugCountV1;
export declare function parseTaskBugsReportV1(input: unknown, query: TaskBugsQueryV1, sourceId: string): TaskBugsReportV1;
export declare function parseTaskTriageReadQueryV1(input: unknown): TaskTriageReadQueryV1;
export declare function parseTaskTriageReadSnapshotV1(input: unknown, expected: TaskTriageReadQueryV1): TaskTriageReadSnapshotV1;
export declare function parseTaskBugsReadSnapshotV1(input: unknown, expected: TaskReadSelectionV1): TaskBugsReadSnapshotV1;
