import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationArray, clarificationBoolean, clarificationCursor, clarificationFields, clarificationId, clarificationInteger,
  clarificationJson, clarificationObject, clarificationText, clarificationTime, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';

export interface SuggestedContactAdminContactV1 { readonly id: string; readonly revision: number; readonly name: string; readonly address: string; readonly enabled: boolean; readonly createdAt: string; }
export interface SuggestedContactAdminListQueryV1 { readonly version: 1; readonly scope: 'global'; readonly limit: number; readonly cursor: string | null; }
export interface SuggestedContactAdminLoadQueryV1 { readonly version: 1; readonly scope: 'global'; readonly id: string; }
export interface SuggestedContactAdminPageV1 { readonly version: 1; readonly scope: 'global'; readonly items: readonly SuggestedContactAdminContactV1[]; readonly nextCursor: string | null; readonly observedAt: string; }
export type SuggestedContactAdminInputV1 = { readonly version: 1; readonly scope: 'global'; readonly name: string; readonly address: string; readonly enabled: boolean } & (
  { readonly kind: 'create' } | { readonly kind: 'update'; readonly id: string; readonly expectedRevision: number });
export type SuggestedContactAdminIntentV1 = SuggestedContactAdminInputV1 & { readonly id: string };
export type SuggestedContactAdminCommandV1 = SuggestedContactAdminIntentV1 & { readonly requestId: string };
export interface SuggestedContactAdminReceiptQueryV1 { readonly scope: 'global'; readonly requestId: string; }
export interface SuggestedContactAdminReceiptV1 {
  readonly version: 1; readonly scope: 'global'; readonly requestId: string; readonly input: SuggestedContactAdminIntentV1;
  readonly status: 'succeeded' | 'rejected'; readonly result: SuggestedContactAdminContactV1 | null; readonly reason: 'not-found' | 'revision-changed' | 'conflict' | null;
}
export interface SuggestedContactAdminPendingV1 { readonly command: SuggestedContactAdminCommandV1; readonly receipt: SuggestedContactAdminReceiptV1 | null; }
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
export const SUGGESTED_CONTACT_ADMIN_LIMITS: Readonly<{ responseBytes: number; pending: number; aggregateBytes: number; page: number }> = Object.freeze({ responseBytes: 512 * 1024, pending: 256, aggregateBytes: 8 * 1024 * 1024, page: 100 });
function global(input: unknown): Record<string, unknown> { const v = clarificationVersion(input); if (v.scope !== 'global') invalidClarification(); return v; }
export function parseSuggestedContactAdminContactV1(input: unknown, expectedId?: string): SuggestedContactAdminContactV1 {
  const v = clarificationObject(input); clarificationFields(v, ['id', 'revision', 'name', 'address', 'enabled', 'createdAt']); const id = clarificationId(v.id);
  if (expectedId !== undefined && id !== expectedId) invalidClarification();
  return Object.freeze({ id, revision: clarificationInteger(v.revision), name: clarificationText(v.name, 160), address: clarificationText(v.address, 320), enabled: clarificationBoolean(v.enabled), createdAt: clarificationTime(v.createdAt) });
}
export function parseSuggestedContactAdminListQueryV1(input: unknown): SuggestedContactAdminListQueryV1 {
  const v = global(input); clarificationFields(v, ['version', 'scope', 'limit', 'cursor']);
  return Object.freeze({ version: 1, scope: 'global', limit: clarificationInteger(v.limit, 100), cursor: clarificationCursor(v.cursor) });
}
export function parseSuggestedContactAdminLoadQueryV1(input: unknown): SuggestedContactAdminLoadQueryV1 {
  const v = global(input); clarificationFields(v, ['version', 'scope', 'id']); return Object.freeze({ version: 1, scope: 'global', id: clarificationId(v.id) });
}
export function parseSuggestedContactAdminPageV1(input: unknown, query?: SuggestedContactAdminListQueryV1): SuggestedContactAdminPageV1 {
  const v = global(clarificationJson(input, SUGGESTED_CONTACT_ADMIN_LIMITS.responseBytes)); clarificationFields(v, ['version', 'scope', 'items', 'nextCursor', 'observedAt']);
  const items = clarificationArray(v.items, value => parseSuggestedContactAdminContactV1(value), query?.limit ?? 100);
  if (new Set(items.map(item => item.id)).size !== items.length) invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', items, nextCursor: clarificationCursor(v.nextCursor), observedAt: clarificationTime(v.observedAt) });
}
export function parseSuggestedContactAdminInputV1(input: unknown): SuggestedContactAdminInputV1 {
  const v = global(clarificationJson(input)); if (v.kind !== 'create' && v.kind !== 'update') invalidClarification();
  clarificationFields(v, ['version', 'scope', 'kind', 'name', 'address', 'enabled', ...(v.kind === 'update' ? ['id', 'expectedRevision'] : [])]);
  const base = { version: 1 as const, scope: 'global' as const, name: clarificationText(v.name, 160, true), address: clarificationText(v.address, 320, true), enabled: clarificationBoolean(v.enabled) };
  return Object.freeze(v.kind === 'create' ? { ...base, kind: 'create' } : { ...base, kind: 'update', id: clarificationId(v.id), expectedRevision: clarificationInteger(v.expectedRevision, Number.MAX_SAFE_INTEGER - 1) });
}
export function parseSuggestedContactAdminIntentV1(input: unknown): SuggestedContactAdminIntentV1 {
  const v = clarificationObject(input);
  if (v.kind === 'create') { const { id, ...base } = v; return Object.freeze({ ...parseSuggestedContactAdminInputV1(base), id: clarificationUuid(id) }); }
  return parseSuggestedContactAdminInputV1(v) as SuggestedContactAdminIntentV1;
}
export function parseSuggestedContactAdminCommandV1(input: unknown): SuggestedContactAdminCommandV1 {
  const { requestId, ...base } = clarificationObject(input); return Object.freeze({ ...parseSuggestedContactAdminIntentV1(base), requestId: clarificationUuid(requestId) });
}
export function parseSuggestedContactAdminReceiptQueryV1(input: unknown): SuggestedContactAdminReceiptQueryV1 {
  const v = clarificationObject(input); clarificationFields(v, ['scope', 'requestId']); if (v.scope !== 'global') invalidClarification(); return Object.freeze({ scope: 'global', requestId: clarificationUuid(v.requestId) });
}
export function parseSuggestedContactAdminReceiptV1(input: unknown, expected?: SuggestedContactAdminCommandV1 | SuggestedContactAdminReceiptQueryV1): SuggestedContactAdminReceiptV1 {
  const v = global(clarificationJson(input, SUGGESTED_CONTACT_ADMIN_LIMITS.responseBytes)); clarificationFields(v, ['version', 'scope', 'requestId', 'input', 'status', 'result', 'reason']);
  const intent = parseSuggestedContactAdminIntentV1(v.input); const requestId = clarificationUuid(v.requestId);
  if (expected && (expected.scope !== 'global' || expected.requestId !== requestId)) invalidClarification();
  if (expected && 'kind' in expected) { const { requestId: _id, ...base } = parseSuggestedContactAdminCommandV1(expected); if (JSON.stringify(clarificationJson(base)) !== JSON.stringify(clarificationJson(intent))) invalidClarification(); }
  let result: SuggestedContactAdminContactV1 | null = null; let reason: SuggestedContactAdminReceiptV1['reason'] = null;
  if (v.status === 'succeeded') {
    result = parseSuggestedContactAdminContactV1(v.result, intent.id);
    if (v.reason !== null || result.revision !== (intent.kind === 'create' ? 1 : intent.expectedRevision + 1)
      || result.name !== intent.name || result.address !== intent.address || result.enabled !== intent.enabled) invalidClarification();
  } else {
    if (v.status !== 'rejected' || v.result !== null || !['not-found', 'revision-changed', 'conflict'].includes(v.reason as string)) invalidClarification(); reason = v.reason as SuggestedContactAdminReceiptV1['reason'];
  }
  return Object.freeze({ version: 1, scope: 'global', requestId, input: intent, status: v.status, result, reason });
}
