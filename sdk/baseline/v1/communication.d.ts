import type { ClarificationReadResultV1 } from "./clarification-read.js";
import { type CommunicationDestinationV1 } from "./communication-command.js";
export interface CommunicationHealthV1 {
    readonly enabled: boolean;
    readonly status: "disabled" | "healthy" | "scanning" | "partial" | "unavailable";
    readonly channelName: string;
    readonly intervalMs: number;
    readonly lastSuccessAt: string | null;
    readonly error: string | null;
}
export interface CommunicationReviewNotificationV1 {
    readonly kind?: "review-request";
    readonly id: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly prUrl: string;
    readonly sourceUrl: string;
    readonly author: string;
    readonly channelName: string;
    readonly status: "queued" | "launched" | "failed" | "blocked";
    readonly runId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly readAt: string | null;
    readonly error: string | null;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly complexity?: "low" | "medium" | "high" | null;
}
export interface CommunicationVoyageNotificationV1 extends Omit<CommunicationReviewNotificationV1, "kind" | "prNumber" | "status" | "runId" | "error" | "complexity"> {
    readonly kind: "voyage-completed";
    readonly title: string;
    readonly prNumber: number | null;
    readonly status: "succeeded" | "failed" | "stopped";
    readonly runId: string;
    readonly error: null;
}
export type CommunicationNotificationV1 = CommunicationReviewNotificationV1 | CommunicationVoyageNotificationV1;
export interface CommunicationNotificationsV1 {
    readonly version: 1;
    readonly quality: "complete" | "partial";
    readonly unread: number | null;
    readonly health: CommunicationHealthV1;
    readonly githubHealth: CommunicationHealthV1 | null;
    readonly notifications: readonly CommunicationNotificationV1[];
}
export interface CommunicationSettingsValuesV1 {
    readonly enabled: boolean;
    readonly watchEnabled: boolean;
    readonly clientId: string;
    readonly channelId: string;
    readonly channelName: string;
    readonly browserSurface: string;
    readonly reviewChannel: string;
    readonly reviewMention: string;
}
export interface CommunicationSettingsSnapshotV1 {
    readonly version: 1;
    readonly revision: string;
    readonly values: CommunicationSettingsValuesV1;
    readonly destination: CommunicationDestinationV1 | null;
}
export interface CommunicationServiceV1 {
    readonly version: 1;
    notifications(input: {
        readonly version: 1;
        readonly repo: string | null;
        readonly limit: number;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationNotificationsV1>>;
    markRead(input: {
        readonly repo: string;
        readonly id: string;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<{
        readonly version: 1;
        readonly id: string;
        readonly readAt: string;
    }>>;
    settings(signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationSettingsSnapshotV1>>;
    saveSettings(input: {
        readonly expectedRevision: string;
        readonly values: CommunicationSettingsValuesV1;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationSettingsSnapshotV1>>;
}
export declare const COMMUNICATION_LIMITS: Readonly<{
    responseBytes: number;
    notifications: number;
    text: number;
}>;
export declare function parseCommunicationHealthV1(input: unknown): CommunicationHealthV1;
export declare function parseCommunicationNotificationV1(input: unknown): CommunicationNotificationV1;
export declare function parseCommunicationNotificationsV1(input: unknown): CommunicationNotificationsV1;
export declare function parseCommunicationSettingsValuesV1(input: unknown): CommunicationSettingsValuesV1;
export declare function parseCommunicationSettingsSnapshotV1(input: unknown): CommunicationSettingsSnapshotV1;
export declare function parseCommunicationMarkReadReceiptV1(input: unknown, expected: {
    readonly id: string;
}): {
    readonly version: 1;
    readonly id: string;
    readonly readAt: string;
};
