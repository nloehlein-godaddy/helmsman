import type { ClarificationReadResultV1 } from "./clarification-read.js";
export interface SuggestedContactAdminContactV1 {
    readonly id: string;
    readonly revision: number;
    readonly name: string;
    readonly address: string;
    readonly enabled: boolean;
    readonly createdAt: string;
}
export interface SuggestedContactAdminListQueryV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly limit: number;
    readonly cursor: string | null;
}
export interface SuggestedContactAdminLoadQueryV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly id: string;
}
export interface SuggestedContactAdminPageV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly items: readonly SuggestedContactAdminContactV1[];
    readonly nextCursor: string | null;
    readonly observedAt: string;
}
export type SuggestedContactAdminInputV1 = {
    readonly version: 1;
    readonly scope: 'global';
    readonly name: string;
    readonly address: string;
    readonly enabled: boolean;
} & ({
    readonly kind: 'create';
} | {
    readonly kind: 'update';
    readonly id: string;
    readonly expectedRevision: number;
});
export type SuggestedContactAdminIntentV1 = SuggestedContactAdminInputV1 & {
    readonly id: string;
};
export type SuggestedContactAdminCommandV1 = SuggestedContactAdminIntentV1 & {
    readonly requestId: string;
};
export interface SuggestedContactAdminReceiptQueryV1 {
    readonly scope: 'global';
    readonly requestId: string;
}
export interface SuggestedContactAdminReceiptV1 {
    readonly version: 1;
    readonly scope: 'global';
    readonly requestId: string;
    readonly input: SuggestedContactAdminIntentV1;
    readonly status: 'succeeded' | 'rejected';
    readonly result: SuggestedContactAdminContactV1 | null;
    readonly reason: 'not-found' | 'revision-changed' | 'conflict' | null;
}
export interface SuggestedContactAdminPendingV1 {
    readonly command: SuggestedContactAdminCommandV1;
    readonly receipt: SuggestedContactAdminReceiptV1 | null;
}
export interface SuggestedContactAdminServiceV1 {
    readonly version: 1;
    list(input: SuggestedContactAdminListQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<SuggestedContactAdminPageV1>>;
    load(input: SuggestedContactAdminLoadQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<SuggestedContactAdminContactV1>>;
    submit(input: SuggestedContactAdminInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<SuggestedContactAdminReceiptV1>>;
    retry?(input: SuggestedContactAdminReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<SuggestedContactAdminReceiptV1>>;
    receipt(input: SuggestedContactAdminReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<SuggestedContactAdminReceiptV1 | null>>;
    pending(): Promise<readonly SuggestedContactAdminPendingV1[]>;
    acknowledge(input: SuggestedContactAdminReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export declare const SUGGESTED_CONTACT_ADMIN_LIMITS: Readonly<{
    responseBytes: number;
    pending: number;
    aggregateBytes: number;
    page: number;
}>;
export declare function parseSuggestedContactAdminContactV1(input: unknown, expectedId?: string): SuggestedContactAdminContactV1;
export declare function parseSuggestedContactAdminListQueryV1(input: unknown): SuggestedContactAdminListQueryV1;
export declare function parseSuggestedContactAdminLoadQueryV1(input: unknown): SuggestedContactAdminLoadQueryV1;
export declare function parseSuggestedContactAdminPageV1(input: unknown, query?: SuggestedContactAdminListQueryV1): SuggestedContactAdminPageV1;
export declare function parseSuggestedContactAdminInputV1(input: unknown): SuggestedContactAdminInputV1;
export declare function parseSuggestedContactAdminIntentV1(input: unknown): SuggestedContactAdminIntentV1;
export declare function parseSuggestedContactAdminCommandV1(input: unknown): SuggestedContactAdminCommandV1;
export declare function parseSuggestedContactAdminReceiptQueryV1(input: unknown): SuggestedContactAdminReceiptQueryV1;
export declare function parseSuggestedContactAdminReceiptV1(input: unknown, expected?: SuggestedContactAdminCommandV1 | SuggestedContactAdminReceiptQueryV1): SuggestedContactAdminReceiptV1;
