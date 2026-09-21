import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface TerminalTargetV1 {
    readonly repo: string | null;
    readonly surfaceRef: string;
    readonly revision: string;
}
export interface TerminalTabV1 {
    readonly target: TerminalTargetV1;
    readonly title: string;
    readonly workspaceTitle: string;
    readonly type: string;
    readonly selected: boolean;
    readonly actions: readonly {
        readonly id: string;
        readonly label: string;
    }[];
}
export interface TerminalSnapshotV1 {
    readonly version: 1;
    readonly repo: string | null;
    readonly connected: boolean;
    readonly quality: 'complete' | 'partial';
    readonly tabs: readonly TerminalTabV1[];
    readonly observedAt: string;
}
export interface TerminalScreenV1 {
    readonly version: 1;
    readonly target: TerminalTargetV1;
    readonly text: string;
    readonly truncated: boolean;
    readonly observedAt: string;
}
export type TerminalControlOperationV1 = {
    readonly kind: 'text';
    readonly text: string;
    readonly enter: boolean;
} | {
    readonly kind: 'key';
    readonly key: string;
} | {
    readonly kind: 'action';
    readonly action: string;
} | {
    readonly kind: 'image';
    readonly mimeType: string;
    readonly dataBase64: string;
};
export interface TerminalControlInputV1 {
    readonly version: 1;
    readonly target: TerminalTargetV1;
    readonly operation: TerminalControlOperationV1;
}
export interface TerminalControlCommandV1 extends TerminalControlInputV1 {
    readonly requestId: string;
}
export interface TerminalControlReceiptV1 {
    readonly version: 1;
    readonly requestId: string;
    readonly input: TerminalControlInputV1;
    readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required';
    readonly reason: string | null;
}
export interface TerminalReceiptQueryV1 {
    readonly repo: string | null;
    readonly requestId: string;
}
export interface TerminalPendingV1 {
    readonly command: TerminalControlCommandV1;
    readonly receipt: TerminalControlReceiptV1 | null;
}
export interface TerminalServiceV1 {
    readonly version: 1;
    list(input: {
        readonly version: 1;
        readonly repo: string | null;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalSnapshotV1>>;
    screen(input: {
        readonly target: TerminalTargetV1;
        readonly lines: number;
    }, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalScreenV1>>;
    control(input: TerminalControlInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1>>;
    receipt(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1 | null>>;
    inspect(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1>>;
    pending(signal?: AbortSignal): Promise<readonly TerminalPendingV1[]>;
    acknowledge(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const TERMINAL_LIMITS: Readonly<{
    tabs: number;
    text: number;
    screen: number;
    lines: number;
    imageBase64: number;
    responseBytes: number;
}>;
export declare function parseTerminalRepo(value: unknown): string | null;
export declare function parseTerminalTargetV1(input: unknown): TerminalTargetV1;
export declare function parseTerminalControlInputV1(input: unknown): TerminalControlInputV1;
export declare function parseTerminalControlCommandV1(input: unknown): TerminalControlCommandV1;
export declare function parseTerminalReceiptQueryV1(input: unknown): TerminalReceiptQueryV1;
export declare function parseTerminalControlReceiptV1(input: unknown, expected?: TerminalControlCommandV1 | TerminalReceiptQueryV1): TerminalControlReceiptV1;
export declare function parseTerminalSnapshotV1(input: unknown): TerminalSnapshotV1;
export declare function parseTerminalScreenV1(input: unknown, target?: TerminalTargetV1): TerminalScreenV1;
export declare function parseTerminalLines(value: unknown): number;
