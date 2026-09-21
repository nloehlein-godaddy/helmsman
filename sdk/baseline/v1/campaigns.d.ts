import type { ClarificationReadResultV1 } from "./clarification-read.js";
export type CampaignPhaseState = 'draft' | 'running' | 'paused' | 'completed' | 'finished' | 'stopped';
export type CampaignTaskState = 'queued' | 'claiming' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Campaign {
    id: string;
    name: string;
    repo: string;
    workflowRef: string;
    concurrency: number;
    createdAt: string;
}
export interface CampaignPhase {
    id: string;
    campaignId: string;
    name: string;
    position: number;
    state: CampaignPhaseState;
    createdAt: string;
    updatedAt: string;
}
export interface CampaignRecord {
    key: string | null;
    repo: string;
    mode: 'freeform' | 'ticket';
    task: string | null;
    ticketId: string | null;
    title: string | null;
}
export interface CampaignTask {
    id: string;
    campaignId: string;
    phaseId: string;
    record: CampaignRecord;
    state: CampaignTaskState;
    attempt: number;
    runId: string;
    claimToken: string | null;
    claimedAt: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface CampaignPreview {
    id: string;
    campaignId: string;
    phaseId: string;
    digest: string;
    records: CampaignRecord[];
    duplicateCount: number;
    createdAt: string;
    importedAt: string | null;
}
export interface CampaignWorkflow {
    ref: string;
    name: string;
}
export interface CampaignList {
    campaigns: Campaign[];
    workflows: CampaignWorkflow[];
}
export interface CampaignDetail {
    campaign: Campaign;
    phases: Array<{
        phase: CampaignPhase;
        tasks: CampaignTask[];
    }>;
}
export interface CampaignListSnapshotV1 extends CampaignList {
    readonly version: 1;
    readonly repo: string | null;
}
export interface CampaignDetailSnapshotV1 extends CampaignDetail {
    readonly version: 1;
    readonly revision: string;
}
export interface CampaignTargetV1 {
    readonly campaignId: string;
    readonly revision: string;
}
export type CampaignPhaseActionV1 = 'start' | 'pause' | 'resume' | 'finish' | 'stop';
export type CampaignCommandInputV1 = {
    readonly version: 1;
    readonly repo: string;
} & ({
    readonly action: 'create';
    readonly name: string;
    readonly workflowRef: string;
    readonly concurrency: number;
} | {
    readonly action: 'add-phase';
    readonly target: CampaignTargetV1;
    readonly name: string;
} | {
    readonly action: 'preview';
    readonly target: CampaignTargetV1;
    readonly phaseId: string;
    readonly format: 'csv' | 'jsonl';
    readonly content: string;
} | {
    readonly action: 'confirm';
    readonly target: CampaignTargetV1;
    readonly previewId: string;
    readonly digest: string;
} | {
    readonly action: 'phase';
    readonly target: CampaignTargetV1;
    readonly phaseId: string;
    readonly operation: CampaignPhaseActionV1;
} | {
    readonly action: 'retry-task';
    readonly target: CampaignTargetV1;
    readonly taskId: string;
    readonly expectedAttempt: number;
});
export type CampaignCommandV1 = CampaignCommandInputV1 & {
    readonly requestId: string;
};
export type CampaignCommandValueV1 = {
    readonly kind: 'created';
    readonly campaign: Campaign;
} | {
    readonly kind: 'phase';
    readonly phase: CampaignPhase;
} | {
    readonly kind: 'preview';
    readonly preview: CampaignPreview;
} | {
    readonly kind: 'imported';
    readonly tasks: readonly CampaignTask[];
} | {
    readonly kind: 'retried';
    readonly task: CampaignTask;
};
export interface CampaignReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export interface CampaignCommandReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: CampaignCommandInputV1;
    readonly status: 'succeeded' | 'rejected';
    readonly result: CampaignCommandValueV1 | null;
    readonly reason: string | null;
}
export interface CampaignPendingV1 {
    readonly command: CampaignCommandV1;
    readonly receipt: CampaignCommandReceiptV1 | null;
}
export interface CampaignServiceV1 {
    readonly version: 1;
    list(input: {
        readonly version: 1;
        readonly repo: string | null;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignListSnapshotV1>>;
    detail(input: {
        readonly version: 1;
        readonly repo: string;
        readonly campaignId: string;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignDetailSnapshotV1>>;
    submit(input: CampaignCommandInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1>>;
    retry(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1>>;
    receipt(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1 | null>>;
    pending(signal?: AbortSignal): Promise<readonly CampaignPendingV1[]>;
    acknowledge(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const CAMPAIGN_LIMITS: Readonly<{
    campaigns: number;
    phases: number;
    tasks: number;
    records: number;
    importBytes: number;
    responseBytes: number;
}>;
export declare function parseCampaignV1(input: unknown): Campaign;
export declare function parseCampaignPhaseV1(input: unknown): CampaignPhase;
export declare function parseCampaignRecordV1(input: unknown): CampaignRecord;
export declare function parseCampaignTaskV1(input: unknown): CampaignTask;
export declare function parseCampaignPreviewV1(input: unknown): CampaignPreview;
export declare function parseCampaignTargetV1(input: unknown): CampaignTargetV1;
export declare function parseCampaignListSnapshotV1(input: unknown): CampaignListSnapshotV1;
export declare function parseCampaignDetailSnapshotV1(input: unknown): CampaignDetailSnapshotV1;
export declare function parseCampaignCommandInputV1(input: unknown): CampaignCommandInputV1;
export declare function parseCampaignCommandV1(input: unknown): CampaignCommandV1;
export declare function parseCampaignReceiptQueryV1(input: unknown): CampaignReceiptQueryV1;
export declare function parseCampaignCommandReceiptV1(input: unknown, expected?: CampaignCommandV1 | CampaignReceiptQueryV1): CampaignCommandReceiptV1;
