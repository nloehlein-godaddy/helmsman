import { parseTaskRepo } from './tasks';
import type { ClarificationAnswerUnavailableReasonV1, ClarificationReadResultV1 } from './clarification-read';
import { CLARIFICATION_ANSWER_UNAVAILABLE_REASONS } from './clarification-read';
import { clarificationFields, clarificationId, clarificationInteger, clarificationJson, clarificationObject, clarificationText,
  clarificationTime, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';

export interface ClarificationCommandInputV1 {
  readonly version: 1; readonly repo: string; readonly runId: string; readonly questionId: string;
  readonly expectedAttempt: number; readonly expectedChannelId: string; readonly expectedQuestionRevision: number; readonly answer: string;
}
export interface ClarificationCommandV1 extends ClarificationCommandInputV1 { readonly requestId: string; }
export interface ClarificationCommandReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export type ClarificationCommandRejectionReasonV1 = ClarificationAnswerUnavailableReasonV1 | 'not-found' | 'revision-changed';
export interface ClarificationCommandOutcomeV1 { readonly questionId: string; readonly revision: number; readonly answer: string; readonly answeredAt: string; }
export interface ClarificationCommandReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: ClarificationCommandInputV1;
  readonly status: 'succeeded' | 'rejected'; readonly result: ClarificationCommandOutcomeV1 | null; readonly reason: ClarificationCommandRejectionReasonV1 | null;
}
export interface ClarificationCommandPendingV1 { readonly command: ClarificationCommandV1; readonly receipt: ClarificationCommandReceiptV1 | null; }
export interface ClarificationCommandServiceV1 {
  readonly version: 1;
  submit(input: ClarificationCommandInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1>>;
  retry?(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1>>;
  receipt(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationCommandReceiptV1 | null>>;
  pending(): Promise<readonly ClarificationCommandPendingV1[]>;
  acknowledge(input: ClarificationCommandReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
export const CLARIFICATION_COMMAND_LIMITS: Readonly<{ responseBytes: number; pending: number; aggregateBytes: number }> = Object.freeze({ responseBytes: 64 * 1024, pending: 256, aggregateBytes: 8 * 1024 * 1024 });
export function parseClarificationCommandInputV1(input: unknown): ClarificationCommandInputV1 {
  const v = clarificationVersion(clarificationJson(input)); clarificationFields(v, ['version', 'repo', 'runId', 'questionId', 'expectedAttempt', 'expectedChannelId', 'expectedQuestionRevision', 'answer']);
  return Object.freeze({ version: 1, repo: parseTaskRepo(v.repo), runId: clarificationId(v.runId), questionId: clarificationId(v.questionId),
    expectedAttempt: clarificationInteger(v.expectedAttempt), expectedChannelId: clarificationUuid(v.expectedChannelId),
    expectedQuestionRevision: clarificationInteger(v.expectedQuestionRevision, Number.MAX_SAFE_INTEGER - 1), answer: clarificationText(v.answer, 4000, true) });
}
export function parseClarificationCommandV1(input: unknown): ClarificationCommandV1 {
  const { requestId, ...intent } = clarificationObject(input); return Object.freeze({ ...parseClarificationCommandInputV1(intent), requestId: clarificationUuid(requestId) });
}
export function parseClarificationCommandReceiptQueryV1(input: unknown): ClarificationCommandReceiptQueryV1 {
  const v = clarificationObject(input); clarificationFields(v, ['repo', 'requestId']); return Object.freeze({ repo: parseTaskRepo(v.repo), requestId: clarificationUuid(v.requestId) });
}
export function parseClarificationCommandReceiptV1(input: unknown, expected?: ClarificationCommandV1 | ClarificationCommandReceiptQueryV1): ClarificationCommandReceiptV1 {
  const v = clarificationVersion(clarificationJson(input, CLARIFICATION_COMMAND_LIMITS.responseBytes)); clarificationFields(v, ['version', 'requestId', 'input', 'status', 'result', 'reason']);
  const intent = parseClarificationCommandInputV1(v.input); const requestId = clarificationUuid(v.requestId);
  if (expected && (expected.repo !== intent.repo || expected.requestId !== requestId)) invalidClarification();
  if (expected && 'questionId' in expected) {
    const { requestId: _requestId, ...base } = parseClarificationCommandV1(expected);
    if (JSON.stringify(clarificationJson(base)) !== JSON.stringify(clarificationJson(intent))) invalidClarification();
  }
  let result: ClarificationCommandOutcomeV1 | null = null; let reason: ClarificationCommandRejectionReasonV1 | null = null;
  if (v.status === 'succeeded') {
    const r = clarificationObject(v.result); clarificationFields(r, ['questionId', 'revision', 'answer', 'answeredAt']);
    if (v.reason !== null || r.questionId !== intent.questionId || r.revision !== intent.expectedQuestionRevision + 1 || r.answer !== intent.answer) invalidClarification();
    result = Object.freeze({ questionId: intent.questionId, revision: clarificationInteger(r.revision), answer: intent.answer, answeredAt: clarificationTime(r.answeredAt) });
  } else {
    if (v.status !== 'rejected' || v.result !== null || ![...CLARIFICATION_ANSWER_UNAVAILABLE_REASONS, 'not-found', 'revision-changed'].includes(v.reason as ClarificationCommandRejectionReasonV1)) invalidClarification();
    reason = v.reason as ClarificationCommandRejectionReasonV1;
  }
  return Object.freeze({ version: 1, requestId, input: intent, status: v.status, result, reason });
}
