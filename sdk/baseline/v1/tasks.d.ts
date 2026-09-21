import type { SourceCommandTargetV1 } from "./source-command.js";
import type { TaskEditorContractV1, TaskEditorDocumentV1, TaskEditActionV1, TaskEditorPageV1 } from "./task-edit.js";
import type { TaskHistoryQueryV1, TaskHistoryV1 } from "./activity-read.js";
import type { TaskTriageQueryV1, TaskTriagePageV1, TaskBugsQueryV1, TaskBugsReportV1 } from "./task-views.js";
import type { PluginJson, TaskSourceDeclaration } from "./backend.js";
export type SourceId = string;
export type SourceInstanceId = string;
export interface WorkRefV1 {
    readonly sourceId: SourceId;
    readonly externalId: string;
}
export interface SourceAuthorityV1 {
    readonly protocol: string;
    readonly authorityId: string;
    readonly identityFormat: string;
}
export interface SourceBindingV1 {
    readonly providerId: string;
    readonly pluginId: string;
    readonly artifactHash: string;
    readonly contractVersion: 1;
    readonly connectionId: string | null;
    readonly credentialHandle: string | null;
}
export interface SourceInstanceV1 {
    readonly version: 1;
    readonly id: SourceInstanceId;
    readonly sourceId: SourceId;
    readonly label: string;
    readonly revision: number;
    readonly desiredEnabled: boolean;
    readonly identityLevel: 'verified' | 'operator-seeded';
    readonly authority: SourceAuthorityV1 | null;
    readonly binding: SourceBindingV1;
    readonly settings: Readonly<Record<string, PluginJson>>;
    readonly allowedRepos: readonly string[];
}
export interface TaskSnapshotV1 {
    readonly version: 1;
    readonly ref: WorkRefV1;
    readonly revision: string;
    readonly displayKey: string;
    readonly title: string;
    readonly repo: string;
    readonly url: string | null;
    readonly state: 'ready' | 'in_progress' | 'review' | 'done' | 'blocked';
    readonly priority: number | null;
    readonly requirements: {
        readonly description: string;
        readonly acceptanceCriteria: readonly string[];
        readonly links: readonly {
            title: string;
            url: string;
        }[];
    };
    readonly providerData: PluginJson;
}
export interface SourceCallContextV1 {
    readonly instance: SourceInstanceV1;
    readonly signal: AbortSignal;
    readonly repo: string | null;
    readonly local: LocalSourceRecordsV1 | null;
    readonly http: SourceReadHttpV1 | null;
}
export interface TaskPageV1 {
    readonly items: readonly TaskSnapshotV1[];
    readonly nextCursor: string | null;
}
export interface SourceIdentityEvidenceV1 {
    readonly version: 1;
    readonly level: 'verified' | 'operator-seeded';
    readonly authority: SourceAuthorityV1 | null;
    readonly verifiedAt: string;
    readonly proof: PluginJson;
}
export interface TaskSourceProviderV1 {
    prepareEditorCommand?(input: {
        editor: TaskEditorContractV1;
        action: TaskEditActionV1;
        commandId: string;
        target: SourceCommandTargetV1 | null;
        destinationRepo: string | null;
        value: PluginJson;
    }, context: SourceCallContextV1): Promise<LocalSourceCommandPlanV1>;
    readEditor?(input: {
        editor: TaskEditorContractV1;
        ref: WorkRefV1 | null;
    }, context: SourceCallContextV1): Promise<TaskEditorDocumentV1 | null>;
    listEditableTasks?(input: {
        repo: string;
        editor: TaskEditorContractV1;
        filter: PluginJson;
        cursor: string | null;
        limit: number;
    }, context: SourceCallContextV1): Promise<TaskEditorPageV1>;
    identify(context: SourceCallContextV1): Promise<SourceIdentityEvidenceV1>;
    list(input: {
        repo: string;
        state: TaskSnapshotV1['state'] | null;
        cursor: string | null;
        limit: number;
    }, context: SourceCallContextV1): Promise<TaskPageV1>;
    readHistory?(input: TaskHistoryQueryV1, context: SourceCallContextV1): Promise<TaskHistoryV1>;
    listTriage?(input: TaskTriageQueryV1, context: SourceCallContextV1): Promise<TaskTriagePageV1>;
    readBugs?(input: TaskBugsQueryV1, context: SourceCallContextV1): Promise<TaskBugsReportV1>;
    listUnderway?(input: {
        repo: string;
        cursor: string | null;
        limit: number;
    }, context: SourceCallContextV1): Promise<TaskPageV1>;
    lookup(input: {
        displayKey: string;
    }, context: SourceCallContextV1): Promise<WorkRefV1 | null>;
    load(ref: WorkRefV1, context: SourceCallContextV1): Promise<TaskSnapshotV1 | null>;
    planClaim(input: SourceClaimRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
    planCompletion(input: SourceCompletionRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
    planAbort(input: SourceAbortRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
    validateAdoption(input: SourceAdoptionProposalV1, context: SourceCallContextV1): Promise<SourceAdoptionEvidenceV1>;
    readonly effects: Readonly<Record<string, SourceEffectHandlerV1>>;
    readonly commands?: Readonly<Record<string, SourceCommandHandlerV1>>;
}
export interface LocalSourceRecordV1 {
    readonly ref: WorkRefV1;
    readonly repo: string;
    readonly revision: string;
    readonly schema: string;
    readonly data: PluginJson;
    readonly claim: SourceClaimReceiptV1 | null;
    readonly lastRunId: string | null;
    readonly claimState: 'reserved' | 'claimed' | 'settling' | 'settled' | null;
}
export interface LocalSourceRecordsV1 {
    describeCollection(): Promise<{
        sourceId: SourceId;
        collectionId: string;
        schema: string;
        revision: number;
        evidenceId: string;
    }>;
    list(input: {
        repo: string;
        cursor: string | null;
        limit: number;
    }): Promise<{
        records: readonly LocalSourceRecordV1[];
        nextCursor: string | null;
    }>;
    get(externalId: string): Promise<LocalSourceRecordV1 | null>;
}
export interface SourceReadHttpV1 {
    query?(input: {
        readonly id: 'jira.approximate-count/v1';
        readonly input: {
            readonly jql: string;
        };
    }): Promise<{
        status: number;
        body: PluginJson;
    }>;
    get(input: {
        path: string;
        query: Readonly<Record<string, string>>;
    }): Promise<{
        status: number;
        body: PluginJson;
    }>;
}
export interface LocalTaskDocumentV1 {
    readonly version: 1;
    readonly title: string;
    readonly description: string;
    readonly acceptanceCriteria: string;
    readonly priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
    readonly state: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly completedAt: string | null;
}
export type LocalSourceCommandPlanV1 = {
    kind: 'create';
    schema: string;
    repo: string;
    data: PluginJson;
} | {
    kind: 'update';
    ref: WorkRefV1;
    expectedRevision: string;
    next: {
        schema: string;
        repo: string;
        data: PluginJson;
    };
} | {
    kind: 'delete';
    ref: WorkRefV1;
    expectedRevision: string;
};
export interface SourceCommandHandlerV1 {
    prepare(input: PluginJson, context: SourceCallContextV1): Promise<LocalSourceCommandPlanV1>;
}
export interface SourceClaimRequestV1 {
    readonly admissionId: string;
    readonly runId: string;
    readonly task: TaskSnapshotV1;
    readonly expectedInstanceRevision: number;
    readonly retryOf: string | null;
}
export interface SourceCompletionRequestV1 {
    readonly runId: string;
    readonly attempt: number;
    readonly task: TaskSnapshotV1;
    readonly claimReceipt: SourceClaimReceiptV1;
    readonly outcome: 'succeeded' | 'failed' | 'stopped';
    readonly publication: {
        repo: string;
        prNumber: number;
    } | null;
}
export interface SourceClaimReceiptV1 {
    readonly version: 1;
    readonly claimId: string;
    readonly ref: WorkRefV1;
    readonly admissionId: string;
    readonly runId: string;
    readonly revision: number;
    readonly binding: SourceBindingV1;
    readonly taskSnapshotHash: string;
    readonly localRecordRevision: string | null;
    readonly operations: readonly {
        operationId: string;
        receipt: PluginJson;
    }[];
}
export interface SourceAbortRequestV1 {
    readonly admissionId: string;
    readonly runId: string;
    readonly task: TaskSnapshotV1;
    readonly claimReceipt: SourceClaimReceiptV1 | null;
    readonly reason: 'cancelled' | 'preflight-failed' | 'stopped-before-launch';
    readonly claimSteps: readonly {
        operationId: string;
        state: 'unsent' | 'acknowledged' | 'uncertain' | 'blocked';
        evidence: PluginJson;
    }[];
}
export interface SourceSettlementReceiptV1 {
    readonly version: 1;
    readonly claimId: string;
    readonly claimRevision: number;
    readonly disposition: 'released' | 'completed' | 'retained-for-operator';
    readonly reason: string;
    readonly localRecordRevision: string | null;
    readonly operations: readonly {
        operationId: string;
        receipt: PluginJson;
    }[];
}
export type SourceMutationPlanV1 = {
    readonly kind: 'none';
    readonly reason: string;
} | {
    readonly kind: 'local-record';
    readonly ref: WorkRefV1;
    readonly expectedRevision: string;
    readonly next: {
        schema: string;
        repo: string;
        data: PluginJson;
    };
} | {
    readonly kind: 'remote-effects';
    readonly effects: readonly {
        readonly localId: string;
        readonly handler: string;
        readonly target: PluginJson;
        readonly payload: PluginJson;
        readonly after: readonly string[];
    }[];
};
export interface SourceEffectContextV1 {
    readonly signal: AbortSignal;
    readonly operationId: string;
    readonly generation: number;
    readonly instance: SourceInstanceV1;
    readonly http: SourceReadHttpV1;
}
export interface SourceEffectMutationContextV1 extends SourceEffectContextV1 {
    readonly http: SourceMutationHttpV1;
}
export interface SourceMutationHttpV1 extends SourceReadHttpV1 {
    send(input: {
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        path: string;
        body: PluginJson;
    }): Promise<{
        status: number;
        body: PluginJson;
    }>;
}
export interface SourceEffectHandlerV1 {
    readonly delivery: 'reconcile' | 'idempotent';
    invoke(input: {
        target: PluginJson;
        payload: PluginJson;
    }, context: SourceEffectMutationContextV1): Promise<SourceEffectResultV1>;
    reconcile(input: {
        target: PluginJson;
        payload: PluginJson;
    }, context: SourceEffectContextV1): Promise<SourceEffectResultV1>;
}
export type SourceEffectResultV1 = {
    status: 'acknowledged';
    receipt: PluginJson;
} | {
    status: 'definitely-not-applied';
    retryable: boolean;
    reason: string;
    evidence: PluginJson;
} | {
    status: 'unknown';
    reason: string;
    evidence: PluginJson;
} | {
    status: 'blocked';
    reason: string;
    evidence: PluginJson;
};
export interface SourceAdoptionProposalV1 {
    readonly sourceId: SourceId;
    readonly expectedSourceRevision: number;
    readonly previousBinding: SourceBindingV1;
    readonly proposedBinding: SourceBindingV1;
    readonly expectedAuthority: SourceAuthorityV1;
    readonly identityFormat: string;
    readonly storageSchema: string | null;
    readonly probes: readonly {
        ref: WorkRefV1;
        revision: string;
    }[];
}
export interface SourceAdoptionEvidenceV1 {
    readonly compatible: boolean;
    readonly authority: SourceIdentityEvidenceV1;
    readonly identityFormat: string;
    readonly readableSchemas: readonly string[];
    readonly probeResults: readonly {
        ref: WorkRefV1;
        matches: boolean;
        evidence: PluginJson;
    }[];
    readonly diagnostic: string | null;
}
export type LocalTaskInputV1 = Omit<LocalTaskDocumentV1, 'createdAt' | 'updatedAt' | 'completedAt'>;
export declare const TASK_SOURCE_LIMITS: Readonly<{
    pageItems: number;
    pageBytes: number;
    taskBytes: number;
    providerDataBytes: number;
    cursorLength: number;
    collectionRecords: number;
}>;
export declare class TaskSourceValidationError extends Error {
}
export declare function parseTaskRepo(input: unknown): string;
export declare function parseWorkRefV1(input: unknown): WorkRefV1;
export declare function parseSourceBindingV1(input: unknown): SourceBindingV1;
export declare function parseSourceIdentityEvidenceV1(input: unknown): SourceIdentityEvidenceV1;
export declare function parseSourceInstanceV1(input: unknown): SourceInstanceV1;
export declare function parseTaskSnapshotV1(input: unknown, expected?: {
    sourceId?: string;
    repo?: string;
}): TaskSnapshotV1;
export declare function parseTaskPageV1(input: unknown, expected?: {
    sourceId?: string;
    repo?: string;
}): TaskPageV1;
export declare function parseLocalTaskDocumentV1(input: unknown): LocalTaskDocumentV1;
export declare function parseLocalTaskInputV1(input: unknown): LocalTaskInputV1;
export declare function parseSourceMutationPlanV1(input: unknown, expected: {
    ref: WorkRefV1;
    repo: string;
    effectIds: readonly string[];
}): SourceMutationPlanV1;
export declare function parseSourceEffectResultV1(input: unknown): SourceEffectResultV1;
export declare function validateTaskSourceProvider(provider: unknown, declaration: TaskSourceDeclaration): asserts provider is TaskSourceProviderV1;
export declare function parseLocalSourceCommandPlanV1(input: unknown): LocalSourceCommandPlanV1;
export declare function parseSourceAdoptionEvidenceV1(input: unknown): SourceAdoptionEvidenceV1;
export declare function parseSourceClaimReceiptV1(input: unknown): SourceClaimReceiptV1;
export declare function parseSourceSettlementReceiptV1(input: unknown): SourceSettlementReceiptV1;
export declare function parseLocalSourceRecordV1(input: unknown, expected?: {
    sourceId?: string;
    repo?: string;
}): LocalSourceRecordV1;
