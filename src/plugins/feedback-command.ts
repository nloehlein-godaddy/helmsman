import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationObject, clarificationText, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';
import { parseTaskRepo } from './tasks';

export interface FeedbackDestinationV1 { readonly id: string; readonly label: string; readonly url: string; readonly revision: string; }
export interface FeedbackContextV1 { readonly version: string; readonly repo: string | null; readonly page: string; }
export interface FeedbackCommandInputV1 { readonly version: 1; readonly draftId: string; readonly title: string; readonly body: string; readonly context: FeedbackContextV1; readonly expectedDestination: FeedbackDestinationV1; }
export interface FeedbackCommandV1 extends FeedbackCommandInputV1 { readonly requestId: string; }
export interface FeedbackReceiptQueryV1 { readonly requestId: string; readonly repo: string | null; }
export interface FeedbackReceiptV1 { readonly version: 1; readonly requestId: string; readonly input: FeedbackCommandInputV1; readonly status: 'pending' | 'succeeded' | 'rejected' | 'recovery-required'; readonly result: { readonly id: string; readonly url: string } | null; readonly reason: string | null; }
export interface FeedbackPendingV1 { readonly command: FeedbackCommandV1; readonly receipt: FeedbackReceiptV1 | null; }
export type FeedbackResultV1<T> = ClarificationReadResultV1<T>;
export interface FeedbackCommandServiceV1 {
  readonly version: 1;
  context(): FeedbackContextV1;
  destination(signal?: AbortSignal): Promise<FeedbackResultV1<FeedbackDestinationV1 | null>>;
  submit(input: FeedbackCommandInputV1, signal?: AbortSignal): Promise<FeedbackResultV1<FeedbackReceiptV1>>;
  retry(input: FeedbackReceiptQueryV1, signal?: AbortSignal): Promise<FeedbackResultV1<FeedbackReceiptV1>>;
  receipt(input: FeedbackReceiptQueryV1, signal?: AbortSignal): Promise<FeedbackResultV1<FeedbackReceiptV1 | null>>;
  pending(): Promise<readonly FeedbackPendingV1[]>;
  acknowledge(input: FeedbackReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export function feedbackUrl(value: unknown): string {
  const text = clarificationText(value, 2048); let url: URL;
  try { url = new URL(text); } catch { return invalidClarification(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalidClarification();
  return url.href;
}
export function parseFeedbackDestinationV1(input: unknown): FeedbackDestinationV1 {
  const value = clarificationObject(input); clarificationFields(value, ['id', 'label', 'url', 'revision']);
  if (typeof value.revision !== 'string' || !/^[a-f\d]{64}$/.test(value.revision)) invalidClarification();
  return Object.freeze({ id: clarificationText(value.id, 256), label: clarificationText(value.label, 256), url: feedbackUrl(value.url), revision: value.revision });
}
export function parseFeedbackInputV1(input: unknown): FeedbackCommandInputV1 {
  const value = clarificationObject(input); clarificationFields(value, ['version', 'draftId', 'title', 'body', 'context', 'expectedDestination']); clarificationVersion(value);
  const context = clarificationObject(value.context); clarificationFields(context, ['version', 'repo', 'page']);
  const title = clarificationText(value.title, 256).trim(); const body = clarificationText(value.body, 10000).trim();
  if (!title || !body || /[\r\n\x00]/.test(title) || body.includes('\0')) invalidClarification();
  return Object.freeze({ version: 1, draftId: clarificationUuid(value.draftId), title, body,
    context: Object.freeze({ version: clarificationText(context.version, 64), repo: context.repo === null ? null : parseTaskRepo(context.repo), page: clarificationText(context.page, 128) }),
    expectedDestination: parseFeedbackDestinationV1(value.expectedDestination) });
}
export function parseFeedbackCommandV1(input: unknown): FeedbackCommandV1 {
  const value = clarificationObject(input); const { requestId, ...rest } = value;
  return Object.freeze({ ...parseFeedbackInputV1(rest), requestId: clarificationUuid(requestId) });
}
export function parseFeedbackReceiptQueryV1(input: unknown): FeedbackReceiptQueryV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: value.repo === null ? null : parseTaskRepo(value.repo), requestId: clarificationUuid(value.requestId) });
}
export function parseFeedbackReceiptV1(input: unknown, command?: FeedbackCommandV1): FeedbackReceiptV1 {
  const value = clarificationObject(input); clarificationFields(value, ['version', 'requestId', 'input', 'status', 'result', 'reason']); clarificationVersion(value);
  const requestId = clarificationUuid(value.requestId); const original = parseFeedbackInputV1(value.input);
  if (!['pending', 'succeeded', 'rejected', 'recovery-required'].includes(String(value.status))) invalidClarification();
  if (command) { const { requestId: expected, ...rest } = command; if (requestId !== expected || JSON.stringify(rest) !== JSON.stringify(original)) invalidClarification(); }
  let result: FeedbackReceiptV1['result'] = null;
  if (value.status === 'succeeded') { const data = clarificationObject(value.result); clarificationFields(data, ['id', 'url']); const url = feedbackUrl(data.url); const destination = new URL(original.expectedDestination.url); const resultUrl = new URL(url); if (resultUrl.origin !== destination.origin || !resultUrl.pathname.startsWith(`${destination.pathname.replace(/\/$/, '')}/`)) invalidClarification(); result = Object.freeze({ id: clarificationText(data.id, 256), url }); }
  else if (value.result !== null) invalidClarification();
  return Object.freeze({ version: 1, requestId, input: original, status: value.status as FeedbackReceiptV1['status'], result,
    reason: value.reason === null ? null : clarificationText(value.reason, 2000) });
}
