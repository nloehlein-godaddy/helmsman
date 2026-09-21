import type { PluginJson } from "./backend.js";
import type { SourceCommandResultV1 } from "./source-command.js";
import { type SourceSettingFieldsV1 } from "./source-settings.js";
export interface SourceAdminTargetV1 {
    readonly sourceId: string;
    readonly sourceRevision: number;
    readonly instanceId: string;
    readonly instanceRevision: number;
}
export interface SourceAdminScheduleV1 {
    readonly repo: string;
    readonly revision: number;
    readonly instanceIds: readonly string[];
}
export interface SourceAdminRuntimeV1 {
    readonly repo: string;
    readonly epoch: string;
    readonly revision: number;
    readonly enabled: boolean;
}
export type SourceReplacementModeV1 = 'adoption' | 'refresh';
export interface SourceAdminSourceV1 {
    readonly target: SourceAdminTargetV1;
    readonly label: string;
    readonly providerId: string;
    readonly identityLevel: string;
    readonly current: boolean;
    readonly available: boolean;
    readonly desiredEnabled: boolean;
    readonly allowedRepos: readonly string[];
    readonly settingsFields: SourceSettingFieldsV1;
    readonly settings: Readonly<Record<string, PluginJson>>;
    readonly replacements: readonly {
        readonly mode: SourceReplacementModeV1;
        readonly providerId: string;
        readonly artifactHash: string;
    }[];
}
export interface SourceAdminSnapshotV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly repos: readonly string[];
    readonly sources: readonly SourceAdminSourceV1[];
    readonly schedules: readonly SourceAdminScheduleV1[];
    readonly runtimes: readonly SourceAdminRuntimeV1[];
}
export interface SourceAdminValidationInputV1 {
    readonly repo: string;
    readonly target: SourceAdminTargetV1;
    readonly mode: SourceReplacementModeV1;
    readonly providerId: string;
    readonly artifactHash: string;
    readonly actor: string;
    readonly reason: string;
}
export interface SourceAdminValidationV1 extends SourceAdminValidationInputV1 {
    readonly validationId: string;
    readonly instanceId: string;
    readonly evidenceHash: string;
}
export type SourceAdminInputV1 = {
    readonly version: 1;
    readonly repo: string | null;
} & ({
    readonly kind: 'configure';
    readonly target: SourceAdminTargetV1;
    readonly changes: {
        readonly label: string;
        readonly desiredEnabled: boolean;
        readonly allowedRepos: readonly string[];
        readonly settings: Readonly<Record<string, PluginJson>>;
    };
} | {
    readonly kind: 'schedule';
    readonly repo: string;
    readonly expectedRevision: number;
    readonly instanceIds: readonly string[];
} | {
    readonly kind: 'runtime';
    readonly repo: string;
    readonly epoch: string;
    readonly expectedRevision: number;
    readonly enabled: boolean;
} | {
    readonly kind: 'replace';
    readonly repo: string;
    readonly validation: SourceAdminValidationV1;
});
export type SourceAdminCommandV1 = SourceAdminInputV1 & {
    readonly requestId: string;
};
export type SourceAdminMutationResultV1 = {
    readonly kind: 'configured';
    readonly target: SourceAdminTargetV1;
} | {
    readonly kind: 'scheduled';
    readonly schedule: SourceAdminScheduleV1;
} | {
    readonly kind: 'runtime';
    readonly runtime: SourceAdminRuntimeV1;
} | {
    readonly kind: 'replaced';
    readonly sourceId: string;
    readonly currentInstanceId: string;
    readonly sourceRevision: number;
};
export interface SourceAdminReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: SourceAdminInputV1;
    readonly status: 'succeeded' | 'rejected' | 'expired';
    readonly result: SourceAdminMutationResultV1 | null;
    readonly message: string | null;
}
export interface SourceAdminReceiptQueryV1 {
    readonly repo: string | null;
    readonly requestId: string;
}
export interface SourceAdminPendingV1 {
    readonly command: SourceAdminCommandV1;
    readonly receipt: SourceAdminReceiptV1 | null;
}
export interface SourceAdminServiceV1 {
    readonly version: 1;
    snapshot(signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminSnapshotV1>>;
    validateReplacement(input: SourceAdminValidationInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminValidationV1>>;
    submit(input: SourceAdminInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1>>;
    retry?(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1>>;
    receipt(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1 | null>>;
    pending(): Promise<readonly SourceAdminPendingV1[]>;
    acknowledge(query: SourceAdminReceiptQueryV1): Promise<void>;
}
export declare const SOURCE_ADMIN_LIMITS: {
    readonly pending: number;
    readonly aggregateBytes: number;
    readonly responseBytes: number;
};
export declare function parseSourceAdminTargetV1(input: unknown): SourceAdminTargetV1;
export declare function parseSourceAdminScheduleV1(input: unknown): SourceAdminScheduleV1;
export declare function parseSourceAdminRuntimeV1(input: unknown): SourceAdminRuntimeV1;
export declare function parseSourceAdminValidationInputV1(input: unknown): SourceAdminValidationInputV1;
export declare function parseSourceAdminValidationV1(input: unknown, expected?: SourceAdminValidationInputV1): SourceAdminValidationV1;
export declare function parseSourceAdminInputV1(input: unknown): SourceAdminInputV1;
export declare function parseSourceAdminCommandV1(input: unknown): SourceAdminCommandV1;
export declare function parseSourceAdminReceiptQueryV1(input: unknown): SourceAdminReceiptQueryV1;
export declare function parseSourceAdminReceiptV1(input: unknown, expected?: SourceAdminCommandV1 | SourceAdminReceiptQueryV1): SourceAdminReceiptV1;
export declare function parseSourceAdminSnapshotV1(input: unknown, repo: string | null): SourceAdminSnapshotV1;
