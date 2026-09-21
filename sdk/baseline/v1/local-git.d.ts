import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface LocalBranch {
    name: string;
    current: boolean;
    upstream: string | null;
    upstreamStatus?: 'present' | 'gone' | 'none' | 'unknown';
    deletionBlockedReason?: string | null;
    commit: string;
}
export interface LocalWorktree {
    path: string;
    branch: string | null;
    commit: string;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
    deletionBlockedReason?: string | null;
}
export type LocalGitAction = {
    action: 'delete-branch';
    branch: string;
    expectedCommit: string;
    force?: boolean;
} | {
    action: 'delete-worktree';
    path: string;
    expectedCommit: string;
} | {
    action: 'preview-delete-untracked-branches';
    force?: boolean;
} | {
    action: 'delete-untracked-branches';
    expectedHead: string;
    branches: {
        branch: string;
        expectedCommit: string;
    }[];
    force?: boolean;
} | {
    action: 'refresh-remotes';
};
export interface LocalGitCleanup {
    expectedHead: string;
    force: boolean;
    candidates: {
        branch: string;
        expectedCommit: string;
        upstreamStatus: 'none' | 'gone';
    }[];
    skipped: {
        branch: string;
        reason: string;
    }[];
}
export interface LocalGitResponse {
    repo: string;
    path: string | null;
    branches: LocalBranch[];
    worktrees: LocalWorktree[];
    error: string | null;
    cleanup?: LocalGitCleanup;
}
export interface LocalGitTargetV1 {
    readonly repo: string;
    readonly revision: string;
}
export interface LocalGitSnapshotV1 extends Omit<LocalGitResponse, 'cleanup'> {
    readonly version: 1;
    readonly revision: string;
}
export interface LocalGitPreviewV1 {
    readonly version: 1;
    readonly target: LocalGitTargetV1;
    readonly cleanup: LocalGitCleanup;
}
export interface LocalGitControlInputV1 {
    readonly version: 1;
    readonly target: LocalGitTargetV1;
    readonly operation: Exclude<LocalGitAction, {
        action: 'preview-delete-untracked-branches';
    }>;
}
export interface LocalGitControlCommandV1 extends LocalGitControlInputV1 {
    readonly requestId: string;
}
export interface LocalGitReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export interface LocalGitControlReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: LocalGitControlInputV1;
    readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required';
    readonly reason: string | null;
    readonly result: LocalGitSnapshotV1 | null;
}
export interface LocalGitPendingV1 {
    readonly command: LocalGitControlCommandV1;
    readonly receipt: LocalGitControlReceiptV1 | null;
}
export interface LocalGitServiceV1 {
    readonly version: 1;
    snapshot(input: {
        readonly version: 1;
        readonly repo: string;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitSnapshotV1>>;
    preview(input: {
        readonly target: LocalGitTargetV1;
        readonly force: boolean;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitPreviewV1>>;
    control(input: LocalGitControlInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1>>;
    receipt(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1 | null>>;
    inspect(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1>>;
    pending(signal?: AbortSignal): Promise<readonly LocalGitPendingV1[]>;
    acknowledge(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const LOCAL_GIT_LIMITS: Readonly<{
    branches: number;
    worktrees: number;
    responseBytes: number;
}>;
export declare function parseLocalGitTargetV1(input: unknown): LocalGitTargetV1;
export declare function parseLocalGitSnapshotV1(input: unknown): LocalGitSnapshotV1;
export declare function parseLocalGitCleanupV1(input: unknown): LocalGitCleanup;
export declare function parseLocalGitPreviewV1(input: unknown, expected?: LocalGitTargetV1): LocalGitPreviewV1;
export declare function parseLocalGitControlInputV1(input: unknown): LocalGitControlInputV1;
export declare function parseLocalGitControlCommandV1(input: unknown): LocalGitControlCommandV1;
export declare function parseLocalGitReceiptQueryV1(input: unknown): LocalGitReceiptQueryV1;
export declare function parseLocalGitControlReceiptV1(input: unknown, expected?: LocalGitControlCommandV1 | LocalGitReceiptQueryV1): LocalGitControlReceiptV1;
