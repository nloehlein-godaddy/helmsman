import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface JiraSettingsSnapshotV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly namespace: 'helmsman.jira/settings';
    readonly revision: string;
    readonly tokenSet: boolean;
    readonly sourceConfigured: boolean;
    readonly bootstrapEnabled: boolean;
}
export interface JiraSettingsRotateTokenInputV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly namespace: 'helmsman.jira/settings';
    readonly expectedRevision: string;
    readonly token: string;
}
export interface JiraSettingsServiceV1 {
    readonly version: 1;
    snapshot(input: {
        readonly version: 1;
        readonly scope: 'global';
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<JiraSettingsSnapshotV1>>;
    rotateToken(input: JiraSettingsRotateTokenInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<JiraSettingsSnapshotV1>>;
}
export declare const JIRA_SETTINGS_SCHEMA_V1: Readonly<{
    version: 1;
    scope: 'global';
    namespace: 'helmsman.jira/settings';
    fields: Readonly<{
        token: Readonly<{
            type: 'string';
            label: string;
            minLength: number;
            maxLength: number;
            writeOnly: true;
            persistInBrowser: false;
        }>;
    }>;
}>;
export declare function parseJiraSettingsSnapshotInputV1(input: unknown): {
    readonly version: 1;
    readonly scope: 'global';
};
export declare function parseJiraSettingsRotateTokenInputV1(input: unknown): JiraSettingsRotateTokenInputV1;
export declare function parseJiraSettingsSnapshotV1(input: unknown): JiraSettingsSnapshotV1;
