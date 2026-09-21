import type { PluginJson } from "./backend.js";
export interface ExecutionHostMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly workspace: 'worktree' | 'clone';
    readonly stageExecution: 'local' | 'isolated';
}
export interface ExecutionHostPrepareRunInputV1 {
    readonly version: 1;
    readonly runId: string;
    readonly repo: string;
    readonly mode: 'coding' | 'review' | 'branch';
}
export interface ExecutionHostIdentityV1 {
    readonly runId: string;
    readonly launchId: string;
    readonly attempt: number;
    readonly receiptPath: string;
}
export interface ExecutionHostCommandV1 {
    readonly cmd: string;
    readonly args: readonly string[];
}
export interface ExecutionHostLaunchSpecV1 extends ExecutionHostIdentityV1, ExecutionHostCommandV1 {
    readonly version: 1;
    readonly cwd: string;
    readonly logPath: string;
    readonly exitPath: string;
    readonly specPath: string;
    readonly wrapperPath: string;
    readonly coordinator: boolean;
    readonly configuration: PluginJson;
}
export interface ExecutionHostReferenceV1 {
    readonly version: 1;
    readonly identity: ExecutionHostIdentityV1;
    readonly state: PluginJson;
}
export type ExecutionHostDiscoveryV1 = {
    readonly status: 'found';
    readonly ref: ExecutionHostReferenceV1;
    readonly evidence: {
        readonly launchId: string;
        readonly runId: string;
        readonly attempt: number;
        readonly state: 'running' | 'exited';
        readonly exitCode?: number;
    };
} | {
    readonly status: 'absent';
    readonly evidence: string;
} | {
    readonly status: 'unknown';
    readonly reason: string;
};
export interface ExecutionHostStagePathsV1 {
    readonly skillsPath: string | null;
    readonly reportPath: string | null;
    readonly priorReportPath: string | null;
    readonly reviewOutputPaths: {
        readonly markdown: string;
        readonly comments: string;
    } | null;
    readonly clarification: {
        readonly questionsPath: string;
        readonly answersPath: string;
    } | null;
}
export interface ExecutionHostStageInputV1 extends ExecutionHostStagePathsV1 {
    readonly version: 1;
    readonly runId: string;
    readonly repo: string;
    readonly cwd: string;
    readonly runtimeRoot: string;
    readonly gateway: {
        readonly url: string;
        readonly capability: string;
    };
    readonly configuration: PluginJson;
    readonly transport: 'openai-responses' | 'anthropic-messages';
    readonly stage: 'implement' | 'review' | 'fix' | 'pr-review';
}
export interface ExecutionHostStageV1 {
    readonly command: ExecutionHostCommandV1;
    stop(): Promise<void>;
    cleanup(success: boolean): Promise<void>;
}
export interface ExecutionHostProviderV1 {
    readonly metadata: ExecutionHostMetadataV1;
    prepareRun(input: ExecutionHostPrepareRunInputV1): Promise<PluginJson>;
    launch(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostReferenceV1>;
    discover(spec: ExecutionHostLaunchSpecV1, ref?: ExecutionHostReferenceV1): Promise<ExecutionHostDiscoveryV1>;
    isAlive(ref: ExecutionHostReferenceV1): Promise<boolean>;
    stop(ref: ExecutionHostReferenceV1): Promise<void>;
    prepareStage?(input: ExecutionHostStageInputV1, renderCommand: (paths: ExecutionHostStagePathsV1) => ExecutionHostCommandV1): Promise<ExecutionHostStageV1>;
    stopStages?(runId: string): Promise<void>;
}
export interface ExecutionHostDeclarationV1 {
    readonly access: readonly [
        'execution'
    ];
}
export interface ExecutionHostBackendContextV1 {
    readonly pluginId: string;
    readonly signal: AbortSignal;
    readonly settings: Readonly<Record<string, PluginJson>>;
    registerExecutionHost(localId: string, provider: ExecutionHostProviderV1): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}
export interface ExecutionHostBackendModuleV1 {
    activate(context: ExecutionHostBackendContextV1): void | Promise<void>;
}
export declare function parseExecutionHostRunIdV1(value: unknown): string;
export declare function parseExecutionHostConfigurationV1(value: unknown): PluginJson;
export declare function parseExecutionHostMetadataV1(input: unknown): ExecutionHostMetadataV1;
export declare function parseExecutionHostPrepareRunInputV1(input: unknown): ExecutionHostPrepareRunInputV1;
export declare function parseExecutionHostIdentityV1(input: unknown): ExecutionHostIdentityV1;
export declare function parseExecutionHostCommandV1(input: unknown): ExecutionHostCommandV1;
export declare function parseExecutionHostLaunchSpecV1(input: unknown): ExecutionHostLaunchSpecV1;
export declare function parseExecutionHostReferenceV1(input: unknown): ExecutionHostReferenceV1;
export declare function parseExecutionHostDiscoveryV1(input: unknown): ExecutionHostDiscoveryV1;
export declare function parseExecutionHostStagePathsV1(input: unknown): ExecutionHostStagePathsV1;
export declare function parseExecutionHostStageInputV1(input: unknown): ExecutionHostStageInputV1;
