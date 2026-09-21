import type { PluginJson } from "./backend.js";
export type TriggerSelectionRoleV1 = 'campaign' | 'slack-review' | 'github-review' | 'github-webhook';
export interface CampaignTriggerMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly kind: 'campaign';
    readonly intervalMs: number;
}
export interface ReviewTriggerMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly kind: 'review-watch';
    readonly intervalMs: number;
    readonly source: 'communication' | 'pull-request';
}
export interface WebhookTriggerMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly kind: 'webhook';
    readonly ingress: {
        readonly signatureHeader: string;
        readonly deliveryHeader: string;
        readonly eventHeader: string;
        readonly algorithm: 'hmac-sha256';
        readonly signaturePrefix: string;
    };
}
export type TriggerMetadataV1 = CampaignTriggerMetadataV1 | ReviewTriggerMetadataV1 | WebhookTriggerMetadataV1;
export interface CampaignTriggerCandidateV1 {
    readonly candidateId: string;
    readonly repo: string;
    readonly campaignId: string;
    readonly phaseId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly workflowRef: string;
    readonly title: string;
    readonly mode: 'ticket' | 'freeform';
    readonly createdAt: string;
}
export interface CampaignTriggerInputV1 {
    readonly version: 1;
    readonly candidates: readonly CampaignTriggerCandidateV1[];
    readonly truncated: boolean;
}
export interface CampaignTriggerChoiceV1 {
    readonly candidateId: string;
}
export interface CampaignTriggerProviderV1 {
    readonly metadata: CampaignTriggerMetadataV1;
    select(input: CampaignTriggerInputV1): CampaignTriggerChoiceV1 | null;
}
export interface TriggerReviewTargetV1 {
    readonly targetId: string;
    readonly repo: string;
    readonly number: number;
    readonly headSha: string;
    readonly title: string;
    readonly url: string;
    readonly status: 'open' | 'closed' | 'merged';
    readonly draft: boolean;
}
export interface TriggerMessageV1 {
    readonly eventId: string;
    readonly channelId: string;
    readonly ts: string;
    readonly permalink: string;
    readonly author: string;
    readonly prUrls: readonly string[];
}
export interface TriggerMessageBatchV1 {
    readonly items: readonly TriggerMessageV1[];
    readonly complete: boolean;
}
export interface TriggerRequestedBatchV1 {
    readonly items: readonly {
        readonly repo: string;
        readonly number: number;
    }[];
    readonly quality: 'complete' | 'partial' | 'degraded';
    readonly truncated: boolean;
}
export interface TriggerReviewDetailInputV1 {
    readonly repo: string;
    readonly number: number;
}
export interface CommunicationReviewTriggerContextV1 {
    readonly source: 'communication';
    readonly signal: AbortSignal;
    messages(input: {
        readonly since: string | null;
    }, signal?: AbortSignal): Promise<TriggerMessageBatchV1>;
    detail(input: TriggerReviewDetailInputV1, signal?: AbortSignal): Promise<TriggerReviewTargetV1 | null>;
}
export interface PullRequestReviewTriggerContextV1 {
    readonly source: 'pull-request';
    readonly signal: AbortSignal;
    requested(signal?: AbortSignal): Promise<TriggerRequestedBatchV1>;
    detail(input: TriggerReviewDetailInputV1, signal?: AbortSignal): Promise<TriggerReviewTargetV1 | null>;
}
export type ReviewTriggerContextV1 = CommunicationReviewTriggerContextV1 | PullRequestReviewTriggerContextV1;
export interface ReviewTriggerInputV1 {
    readonly version: 1;
    readonly activatedAt: string;
    readonly cursor: string | null;
    readonly defaultWorkflowRef: string;
}
export interface ReviewTriggerProposalV1 {
    readonly eventId: string | null;
    readonly targetId: string;
    readonly workflowRef: string;
    readonly sourceUrl: string;
    readonly author: string;
    readonly channelName: string;
}
export interface ReviewTriggerResultV1 {
    readonly proposals: readonly ReviewTriggerProposalV1[];
    readonly nextCursor: string | null;
    readonly complete: boolean;
}
export interface CommunicationReviewTriggerProviderV1 {
    readonly metadata: ReviewTriggerMetadataV1 & {
        readonly source: 'communication';
    };
    scan(input: ReviewTriggerInputV1, context: CommunicationReviewTriggerContextV1): Promise<ReviewTriggerResultV1>;
}
export interface PullRequestReviewTriggerProviderV1 {
    readonly metadata: ReviewTriggerMetadataV1 & {
        readonly source: 'pull-request';
    };
    scan(input: ReviewTriggerInputV1, context: PullRequestReviewTriggerContextV1): Promise<ReviewTriggerResultV1>;
}
export type ReviewTriggerProviderV1 = CommunicationReviewTriggerProviderV1 | PullRequestReviewTriggerProviderV1;
export interface WebhookTriggerInputV1 {
    readonly version: 1;
    readonly deliveryId: string;
    readonly event: string;
    readonly body: PluginJson;
}
export interface WebhookTriggerResultV1 {
    readonly workflowRef: string;
    readonly intent: {
        readonly mode: 'freeform';
        readonly repo: string;
        readonly title: string;
        readonly task: string;
    } | {
        readonly mode: 'review';
        readonly repo: string;
        readonly title: string;
        readonly prNumber: number;
    };
}
export interface WebhookTriggerProviderV1 {
    readonly metadata: WebhookTriggerMetadataV1;
    parse(input: WebhookTriggerInputV1): WebhookTriggerResultV1 | null;
}
export type TriggerProviderV1 = CampaignTriggerProviderV1 | ReviewTriggerProviderV1 | WebhookTriggerProviderV1;
export interface TriggerDeclarationV1 {
    readonly access: readonly [
        'campaign-candidates'
    ] | readonly [
        'review-discovery'
    ] | readonly [
        'authenticated-event'
    ];
}
export interface TriggerBackendContextV1 {
    readonly pluginId: string;
    readonly signal: AbortSignal;
    readonly settings: Readonly<Record<string, PluginJson>>;
    registerTrigger(localId: string, provider: TriggerProviderV1): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}
export interface TriggerBackendModuleV1 {
    activate(context: TriggerBackendContextV1): void | Promise<void>;
}
export declare const TRIGGER_LIMITS_V1: Readonly<Record<'items' | 'urls' | 'inputBytes' | 'proposalBytes' | 'calls', number>>;
export declare function parseTriggerRoleV1(value: unknown): TriggerSelectionRoleV1;
export declare function parseTriggerWorkflowRefV1(value: unknown): string;
export declare function parseTriggerCursorV1(value: unknown): string | null;
export declare function parseTriggerMetadataV1(input: unknown): TriggerMetadataV1;
export declare function parseCampaignTriggerInputV1(input: unknown): CampaignTriggerInputV1;
export declare function parseCampaignTriggerChoiceV1(input: unknown): CampaignTriggerChoiceV1 | null;
export declare function parseTriggerReviewDetailInputV1(input: unknown): TriggerReviewDetailInputV1;
export declare function parseTriggerReviewTargetV1(input: unknown): TriggerReviewTargetV1 | null;
export declare function parseTriggerMessageBatchV1(input: unknown): TriggerMessageBatchV1;
export declare function parseTriggerRequestedBatchV1(input: unknown): TriggerRequestedBatchV1;
export declare function parseReviewTriggerInputV1(input: unknown): ReviewTriggerInputV1;
export declare function parseReviewTriggerResultV1(input: unknown): ReviewTriggerResultV1;
export declare function parseWebhookTriggerInputV1(input: unknown): WebhookTriggerInputV1;
export declare function parseWebhookTriggerResultV1(input: unknown): WebhookTriggerResultV1 | null;
