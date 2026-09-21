import type { PluginJson } from "./backend.js";
export type WorkflowModeV1 = 'coding' | 'review' | 'branch';
export interface WorkflowMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly modes: readonly WorkflowModeV1[];
    readonly execution: 'staged' | 'direct';
    readonly requiredSkills: readonly string[];
    readonly maxRounds: number;
    readonly stageTimeoutMinutes: number;
}
export interface WorkflowStageV1 {
    readonly stage: 'implement' | 'review' | 'fix';
    readonly baseSha: string;
    readonly headSha?: string;
    readonly reportPath: string;
    readonly feedback?: string;
    readonly round?: number;
    readonly summaryCorrection?: {
        readonly reportPath: string;
        readonly actualLength: number;
    };
}
export interface WorkflowPromptInputV1 {
    readonly version: 1;
    readonly runtime: {
        readonly providerId: string;
        readonly model: string | null;
        readonly effort: string | null;
        readonly reviewDelegation: 'review-agent-skill' | 'native-subagents' | 'none';
    };
    readonly byline: string;
    readonly clarificationInstructions: string;
    readonly task: {
        readonly ticketId: string;
        readonly title: string;
        readonly repo: string;
        readonly jiraBaseUrl: string;
        readonly jiraContext?: string;
        readonly task?: string;
        readonly prBranch?: string;
        readonly prNumber?: number;
        readonly review?: boolean;
        readonly prHeadSha?: string;
        readonly skillsPath?: string;
        readonly reviewOutputPaths?: {
            readonly markdown: string;
            readonly comments: string;
        };
    };
    readonly stage: WorkflowStageV1 | null;
}
export interface WorkflowFindingV1 {
    readonly title: string;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
}
export interface WorkflowReviewReportV1 {
    readonly baseSha: string;
    readonly headSha: string;
    readonly verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    readonly summary: string;
    readonly findings: readonly WorkflowFindingV1[];
}
export interface WorkflowStepInputV1 {
    readonly version: 1;
    readonly writerId: string;
    readonly reviewerIds: readonly string[];
    readonly round: number;
    readonly maxRounds: number;
    readonly implemented: boolean;
    readonly revision: {
        readonly baseSha: string;
        readonly headSha: string;
        readonly branch: string;
    };
    readonly reviews: readonly {
        readonly reviewer: string;
        readonly report: WorkflowReviewReportV1;
    }[];
}
export type WorkflowActionV1 = {
    readonly kind: 'author';
    readonly stage: 'implement' | 'fix';
} | {
    readonly kind: 'review';
    readonly reviewerId: string;
} | {
    readonly kind: 'publish';
} | {
    readonly kind: 'stop';
    readonly reason: string;
};
export interface WorkflowProviderV1 {
    readonly metadata: WorkflowMetadataV1;
    renderPrompt(input: WorkflowPromptInputV1): string;
    next(input: WorkflowStepInputV1): WorkflowActionV1;
}
export interface WorkflowDeclarationV1 {
    readonly access: readonly [
        'workflow-policy'
    ];
}
export interface WorkflowBackendContextV1 {
    readonly pluginId: string;
    readonly signal: AbortSignal;
    readonly settings: Readonly<Record<string, PluginJson>>;
    registerWorkflow(localId: string, provider: WorkflowProviderV1): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}
export interface WorkflowBackendModuleV1 {
    activate(context: WorkflowBackendContextV1): void | Promise<void>;
}
export declare const WORKFLOW_LIMITS_V1: Readonly<Record<'prompt' | 'input' | 'reviewers' | 'findings' | 'skills', number>>;
export declare function parseWorkflowModeV1(value: unknown): WorkflowModeV1;
export declare function parseWorkflowMetadataV1(input: unknown): WorkflowMetadataV1;
export declare function parseWorkflowStageV1(input: unknown): WorkflowStageV1;
export declare function parseWorkflowPromptInputV1(input: unknown): WorkflowPromptInputV1;
export declare function parseWorkflowPromptV1(value: unknown): string;
export declare function parseWorkflowReviewReportV1(input: unknown): WorkflowReviewReportV1;
export declare function parseWorkflowStepInputV1(input: unknown): WorkflowStepInputV1;
export declare function parseWorkflowActionV1(input: unknown): WorkflowActionV1;
