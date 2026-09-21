import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface ProfileIdentityV1 {
    readonly displayName: string | null;
    readonly login: string | null;
}
export interface ProfileSnapshotV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly profile: ProfileIdentityV1;
}
export interface ProfileServiceV1 {
    readonly version: 1;
    snapshot(input: {
        readonly version: 1;
        readonly scope: 'global';
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<ProfileSnapshotV1>>;
}
export declare function parseProfileSnapshotInputV1(input: unknown): {
    readonly version: 1;
    readonly scope: 'global';
};
export declare function parseProfileIdentityV1(input: unknown): ProfileIdentityV1;
export declare function parseProfileSnapshotV1(input: unknown): ProfileSnapshotV1;
