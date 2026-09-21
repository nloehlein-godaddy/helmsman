import type { WorkRefV1 } from "./tasks.js";
export interface SchedulingSourceV1 {
    readonly instanceId: string;
    readonly sourceId: string;
    readonly label: string;
}
export interface SchedulingCandidateV1 {
    readonly candidateId: string;
    readonly ref: WorkRefV1;
    readonly revision: string;
    readonly displayKey: string;
    readonly title: string;
    readonly priority: number | null;
}
export interface SchedulingPageV1 {
    readonly items: readonly SchedulingCandidateV1[];
    readonly nextCursor: string | null;
}
export interface SchedulingInputV1 {
    readonly version: 1;
    readonly repo: string;
    readonly sources: readonly SchedulingSourceV1[];
    readonly lastInstanceId: string | null;
}
export interface SchedulingDiscoveryInputV1 {
    readonly instanceId: string;
    readonly cursor: string | null;
    readonly limit: number;
}
export interface SchedulingContextV1 {
    readonly signal: AbortSignal;
    list(input: SchedulingDiscoveryInputV1): Promise<SchedulingPageV1>;
}
export interface SchedulingChoiceV1 {
    readonly candidateId: string;
}
export interface SchedulingProviderV1 {
    readonly intervalMs: number;
    select(input: SchedulingInputV1, context: SchedulingContextV1): Promise<SchedulingChoiceV1 | null>;
}
export interface SchedulingDeclaration {
    readonly access: readonly [
        'task-discovery'
    ];
}
export declare function parseSchedulingDiscoveryInputV1(input: unknown): SchedulingDiscoveryInputV1;
export declare function parseSchedulingChoiceV1(input: unknown): SchedulingChoiceV1 | null;
