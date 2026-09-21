import type { ClarificationReadResultV1 } from "./clarification-read.js";
import type { CommunicationDestinationV1 } from "./communication-provider.js";
export type { CommunicationDestinationV1 } from "./communication-provider.js";
export interface CommunicationCommandInputV1 {
    readonly version: 1;
    readonly repo: string;
    readonly number: number;
    readonly expectedDestination: CommunicationDestinationV1;
}
export interface CommunicationCommandV1 extends CommunicationCommandInputV1 {
    readonly requestId: string;
}
export interface CommunicationCommandReceiptQueryV1 {
    readonly repo: string;
    readonly requestId: string;
}
export interface CommunicationCommandOutcomeV1 {
    readonly repo: string;
    readonly number: number;
    readonly destination: CommunicationDestinationV1;
    readonly permalink: string | null;
}
export interface CommunicationCommandReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: CommunicationCommandInputV1;
    readonly status: "succeeded" | "rejected" | "pending" | "recovery-required";
    readonly result: CommunicationCommandOutcomeV1 | null;
    readonly reason: string | null;
}
export interface CommunicationCommandPendingV1 {
    readonly command: CommunicationCommandV1;
    readonly receipt: CommunicationCommandReceiptV1 | null;
}
export type CommunicationCommandResultV1<T> = ClarificationReadResultV1<T>;
export interface CommunicationCommandServiceV1 {
    readonly version: 1;
    submit(input: CommunicationCommandInputV1, signal?: AbortSignal): Promise<CommunicationCommandResultV1<CommunicationCommandReceiptV1>>;
    retry(input: CommunicationCommandReceiptQueryV1, signal?: AbortSignal): Promise<CommunicationCommandResultV1<CommunicationCommandReceiptV1>>;
    receipt(input: CommunicationCommandReceiptQueryV1, signal?: AbortSignal): Promise<CommunicationCommandResultV1<CommunicationCommandReceiptV1 | null>>;
    pending(): Promise<readonly CommunicationCommandPendingV1[]>;
    acknowledge(input: CommunicationCommandReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const COMMUNICATION_COMMAND_LIMITS: Readonly<{
    responseBytes: number;
    pending: number;
    aggregateBytes: number;
}>;
export declare function parseCommunicationDestinationV1(input: unknown): CommunicationDestinationV1;
export declare function parseCommunicationCommandInputV1(input: unknown): CommunicationCommandInputV1;
export declare function parseCommunicationCommandV1(input: unknown): CommunicationCommandV1;
export declare function parseCommunicationCommandReceiptQueryV1(input: unknown): CommunicationCommandReceiptQueryV1;
export declare function parseCommunicationCommandReceiptV1(input: unknown, expected?: CommunicationCommandV1 | CommunicationCommandReceiptQueryV1): CommunicationCommandReceiptV1;
