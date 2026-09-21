import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationInteger, clarificationJson, clarificationObject, clarificationText, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';
import { parseTaskRepo } from './tasks';
import { sourceText } from './source-contract-validation';

export interface PullRequestCommandInputV1 {
  readonly version: 1; readonly repo: string; readonly number: number; readonly expectedHeadSha: string;
  readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; readonly body: string;
}
export interface PullRequestCommandV1 extends PullRequestCommandInputV1 { readonly requestId: string; }
export interface PullRequestCommandReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface PullRequestCommandOutcomeV1 { readonly repo: string; readonly number: number; readonly headSha: string; readonly actor: string; readonly reviewId: number; }
export interface PullRequestCommandReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: PullRequestCommandInputV1;
  readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required';
  readonly result: PullRequestCommandOutcomeV1 | null; readonly reason: string | null;
}
export interface PullRequestCommandPendingV1 { readonly command: PullRequestCommandV1; readonly receipt: PullRequestCommandReceiptV1 | null; }
export type PullRequestCommandResultV1<T> = ClarificationReadResultV1<T>;
export interface PullRequestCommandServiceV1 {
  readonly version: 1;
  submit(input: PullRequestCommandInputV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1>>;
  retry(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1>>;
  receipt(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<PullRequestCommandResultV1<PullRequestCommandReceiptV1 | null>>;
  pending(): Promise<readonly PullRequestCommandPendingV1[]>;
  acknowledge(input: PullRequestCommandReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export const PULL_REQUEST_COMMAND_LIMITS: Readonly<{ responseBytes: number; pending: number; aggregateBytes: number }> = Object.freeze({ responseBytes: 512 * 1024, pending: 256, aggregateBytes: 8 * 1024 * 1024 });
export function parsePullRequestCommandInputV1(input: unknown): PullRequestCommandInputV1 {
  const v = clarificationVersion(clarificationJson(input, PULL_REQUEST_COMMAND_LIMITS.responseBytes));
  clarificationFields(v, ['version', 'repo', 'number', 'expectedHeadSha', 'event', 'body']);
  if (typeof v.expectedHeadSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(v.expectedHeadSha)
    || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(v.event as string)
    || typeof v.body !== 'string' || v.body.length > 64_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v.body)
    || v.event !== 'APPROVE' && !v.body.trim()) invalidClarification();
  return Object.freeze({ version: 1, repo: parseTaskRepo(v.repo), number: clarificationInteger(v.number), expectedHeadSha: v.expectedHeadSha,
    event: v.event as PullRequestCommandInputV1['event'], body: v.body });
}
export function parsePullRequestCommandV1(input: unknown): PullRequestCommandV1 {
  const { requestId, ...intent } = clarificationObject(input);
  return Object.freeze({ ...parsePullRequestCommandInputV1(intent), requestId: clarificationUuid(requestId) });
}
export function parsePullRequestCommandReceiptQueryV1(input: unknown): PullRequestCommandReceiptQueryV1 {
  const v = clarificationObject(input); clarificationFields(v, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTaskRepo(v.repo), requestId: clarificationUuid(v.requestId) });
}
export function parsePullRequestCommandReceiptV1(input: unknown, expected?: PullRequestCommandV1 | PullRequestCommandReceiptQueryV1): PullRequestCommandReceiptV1 {
  const v = clarificationVersion(clarificationJson(input, PULL_REQUEST_COMMAND_LIMITS.responseBytes));
  clarificationFields(v, ['version', 'requestId', 'input', 'status', 'result', 'reason']);
  const intent = parsePullRequestCommandInputV1(v.input); const requestId = clarificationUuid(v.requestId);
  if (expected && (expected.repo !== intent.repo || expected.requestId !== requestId)) invalidClarification();
  if (expected && 'expectedHeadSha' in expected) {
    const { requestId: _requestId, ...base } = parsePullRequestCommandV1(expected);
    if (JSON.stringify(base) !== JSON.stringify(intent)) invalidClarification();
  }
  let result: PullRequestCommandOutcomeV1 | null = null;
  let reason: string | null = null;
  if (v.status === 'succeeded') {
    const r = clarificationObject(v.result); clarificationFields(r, ['repo', 'number', 'headSha', 'actor', 'reviewId']);
    if (v.reason !== null || r.repo !== intent.repo || r.number !== intent.number || r.headSha !== intent.expectedHeadSha) invalidClarification();
    result = Object.freeze({ repo: intent.repo, number: intent.number, headSha: intent.expectedHeadSha,
      actor: sourceText(r.actor, 128), reviewId: clarificationInteger(r.reviewId) });
  } else {
    if (!['rejected', 'pending', 'recovery-required'].includes(v.status as string) || v.result !== null) invalidClarification();
    if (v.reason !== null) reason = clarificationText(v.reason, 2000);
    if (v.status !== 'pending' && reason === null) invalidClarification();
  }
  return Object.freeze({ version: 1, requestId, input: intent, status: v.status as PullRequestCommandReceiptV1['status'], result, reason });
}
