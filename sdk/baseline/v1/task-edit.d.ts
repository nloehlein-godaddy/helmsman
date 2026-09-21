import { type TaskEditorContractV1, type TaskEditorDeclarationV1, type TaskEditActionV1 } from "./task-editor-contract.js";
export * from "./task-editor-contract.js";
import type { PluginJson } from "./backend.js";
import { type TaskReadSelectionV1, type TaskReadTaskV1, type TaskReadResultV1 } from "./task-read.js";
import { type TaskSnapshotV1, type WorkRefV1 } from "./tasks.js";
export interface TaskEditQueryV1 {
    readonly selection: TaskReadSelectionV1;
    readonly editor: TaskEditorContractV1;
}
export interface TaskEditLoadQueryV1 extends TaskEditQueryV1 {
    readonly ref: WorkRefV1;
}
export interface TaskEditListQueryV1 extends TaskEditQueryV1 {
    readonly filter: PluginJson;
    readonly cursor: string | null;
    readonly limit: number;
}
export interface TaskEditAvailabilityV1 {
    readonly commandId: string;
    readonly available: boolean;
    readonly reason: string | null;
}
export interface TaskEditorDocumentV1 {
    readonly version: 1;
    readonly editor: TaskEditorContractV1;
    readonly target: {
        readonly ref: WorkRefV1;
        readonly revision: string;
    } | null;
    readonly value: PluginJson;
    readonly commands: Readonly<Record<TaskEditActionV1, TaskEditAvailabilityV1 | null>>;
    readonly destinationRepos: readonly string[];
    readonly relatedRun: {
        readonly repo: string;
        readonly runId: string;
    } | null;
}
export interface TaskEditEnvelopeV1 extends TaskEditorDocumentV1 {
    readonly selection: TaskReadSelectionV1;
    readonly sourceRevision: number;
}
export interface TaskEditSourceV1 {
    readonly selection: TaskReadSelectionV1;
    readonly label: string;
    readonly availability: 'available' | 'disabled' | 'unavailable';
    readonly editors: readonly TaskEditorDeclarationV1[];
}
export interface TaskEditDiscoveryV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly sources: readonly TaskEditSourceV1[];
}
export interface TaskEditListItemV1 extends TaskReadTaskV1 {
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
}
export interface TaskEditorPageV1 {
    readonly items: readonly (TaskSnapshotV1 & {
        readonly createdAt: string | null;
        readonly updatedAt: string | null;
    })[];
    readonly nextCursor: string | null;
    readonly total: number | null;
}
export interface TaskEditPageV1 {
    readonly selection: TaskReadSelectionV1;
    readonly items: readonly TaskEditListItemV1[];
    readonly nextCursor: string | null;
    readonly total: number | null;
}
export interface TaskEditServiceV1 {
    readonly version: 1;
    discover(signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditDiscoveryV1>>;
    create(input: TaskEditQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditEnvelopeV1>>;
    load(input: TaskEditLoadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditEnvelopeV1 | null>>;
    list(input: TaskEditListQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskEditPageV1>>;
}
export declare const LOCAL_TASK_EDITOR_V1: TaskEditorContractV1;
export declare function parseTaskEditQueryV1(input: unknown): TaskEditQueryV1;
export declare function parseTaskEditLoadQueryV1(input: unknown): TaskEditLoadQueryV1;
export declare function parseTaskEditListQueryV1(input: unknown): TaskEditListQueryV1;
export declare function parseTaskEditorDocumentV1(input: unknown): TaskEditorDocumentV1;
export declare function parseTaskEditEnvelopeV1(input: unknown, expected?: TaskEditQueryV1 & {
    ref?: WorkRefV1;
}): TaskEditEnvelopeV1;
export declare function parseTaskEditPageV1(input: unknown, query: TaskEditListQueryV1, provider?: boolean): TaskEditPageV1;
