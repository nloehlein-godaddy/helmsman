import type { PluginJson } from "./backend.js";
export declare class SourceContractValidationError extends Error {
}
export declare function invalidSourceContract(): never;
export declare function sourceObject(input: unknown): Record<string, unknown>;
export declare function sourceFields(value: Record<string, unknown>, required: readonly string[], optional?: readonly string[]): void;
export declare function sourceText(input: unknown, maximum?: number): string;
export declare function sourceInteger(input: unknown): number;
export declare function sourceUuid(input: unknown): string;
export declare function sourceJson(input: unknown, maximum?: number): PluginJson;
export declare function isContributionId(value: unknown): value is string;
