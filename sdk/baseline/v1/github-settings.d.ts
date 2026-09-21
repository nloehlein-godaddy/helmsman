import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface GithubSettingsValuesV1 {
    readonly defaultRepo: string;
    readonly author: string;
    readonly reviewWatchEnabled: boolean;
}
export interface GithubSettingsSnapshotV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly namespace: 'helmsman.github/settings';
    readonly revision: string;
    readonly values: GithubSettingsValuesV1;
    readonly tokenSet: boolean;
}
export interface GithubSettingsSaveInputV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly namespace: 'helmsman.github/settings';
    readonly expectedRevision: string;
    readonly values: GithubSettingsValuesV1;
}
export interface GithubSettingsServiceV1 {
    readonly version: 1;
    snapshot(input: {
        readonly version: 1;
        readonly scope: 'global';
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<GithubSettingsSnapshotV1>>;
    save(input: GithubSettingsSaveInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<GithubSettingsSnapshotV1>>;
}
export declare const GITHUB_SETTINGS_SCHEMA_V1: Readonly<{
    version: 1;
    scope: 'global';
    namespace: 'helmsman.github/settings';
    fields: Readonly<{
        defaultRepo: Readonly<{
            type: 'string';
            label: string;
            maxLength: number;
            default: string;
        }>;
        author: Readonly<{
            type: 'string';
            label: string;
            maxLength: number;
            default: string;
        }>;
        reviewWatchEnabled: Readonly<{
            type: 'boolean';
            label: string;
            default: boolean;
        }>;
    }>;
}>;
export declare function parseGithubSettingsSnapshotInputV1(input: unknown): {
    readonly version: 1;
    readonly scope: 'global';
};
export declare function parseGithubSettingsValuesV1(input: unknown): GithubSettingsValuesV1;
export declare function parseGithubSettingsSaveInputV1(input: unknown): GithubSettingsSaveInputV1;
export declare function parseGithubSettingsSnapshotV1(input: unknown): GithubSettingsSnapshotV1;
