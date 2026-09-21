import type { PluginJson } from "./backend.js";
export declare const AGENT_PROVIDER_LIMITS_V1: Readonly<Record<'prompt' | 'line' | 'command' | 'arguments' | 'text', number>>;
export interface AgentModelSettingsV1 {
    readonly model: string | null;
    readonly effort: string | null;
}
export interface AgentProviderMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly defaults: AgentModelSettingsV1;
    readonly review: Readonly<Record<'low' | 'medium' | 'high', AgentModelSettingsV1>>;
    readonly reviewSkills: readonly string[];
    readonly reviewDelegation: 'review-agent-skill' | 'native-subagents' | 'none';
    readonly supportsPrePr: boolean;
    readonly docker: 'openai-responses' | 'anthropic-messages' | null;
    readonly costReporting: 'delta' | 'cumulative';
}
export interface AgentCommandInputV1 {
    readonly version: 1;
    readonly prompt: string;
    readonly model: string | null;
    readonly effort: string | null;
    readonly stage: 'direct' | 'implement' | 'review' | 'fix';
    readonly summaryCorrection: boolean;
    readonly task: {
        readonly ticketId: string;
        readonly repo: string;
        readonly title: string;
    };
}
export interface AgentCommandV1 {
    readonly cmd: string;
    readonly args: readonly string[];
}
export interface AgentUsageV1 {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
}
export interface AgentEventFieldsV1 {
    readonly text: string;
    readonly costUsd?: number;
    readonly prNumber?: number;
    readonly eventId?: string;
    readonly usage?: AgentUsageV1;
    readonly provider?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly stage?: string;
    readonly round?: number;
}
export type AgentEventV1 = AgentEventFieldsV1 & ({
    readonly kind: 'result';
    readonly outcome: 'success' | 'failure' | 'unknown';
} | {
    readonly kind: 'phase' | 'tool' | 'log' | 'usage' | 'error' | 'review-verdict';
    readonly outcome?: never;
});
export interface AgentProviderV1 {
    readonly metadata: AgentProviderMetadataV1;
    buildCommand(input: AgentCommandInputV1): AgentCommandV1;
    parseLine(line: string): AgentEventV1 | null;
}
export interface AgentDeclarationV1 {
    readonly access: readonly [
        'process-description'
    ];
}
export interface AgentBackendContextV1 {
    readonly pluginId: string;
    readonly signal: AbortSignal;
    readonly settings: Readonly<Record<string, PluginJson>>;
    registerAgent(localId: string, provider: AgentProviderV1): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}
export interface AgentBackendModuleV1 {
    activate(context: AgentBackendContextV1): void | Promise<void>;
}
export declare function parseAgentModelSettingsV1(input: unknown): AgentModelSettingsV1;
export declare function parseAgentProviderMetadataV1(input: unknown): AgentProviderMetadataV1;
export declare function parseAgentCommandInputV1(input: unknown): AgentCommandInputV1;
export declare function parseAgentCommandV1(input: unknown): AgentCommandV1;
export declare function parseAgentEventV1(input: unknown): AgentEventV1 | null;
