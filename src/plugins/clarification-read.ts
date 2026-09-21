import { parseTaskRepo } from './tasks';
import { clarificationArray, clarificationBoolean, clarificationCursor, clarificationFields, clarificationId, clarificationInteger,
  clarificationJson, clarificationObject, clarificationText, clarificationTime, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';

export type ClarificationReadStateV1 = 'pending' | 'answered' | 'timed-out' | 'cancelled';
export type ClarificationReadOwnerV1 = 'local' | 'trusted-contact';
export type ClarificationAnswerUnavailableReasonV1 = 'provenance-unknown' | 'different-attempt' | 'not-pending' | 'run-unavailable'
  | 'run-inactive' | 'stop-requested' | 'deadline-expired' | 'channel-unavailable';
export type ClarificationReadUnavailableReasonV1 = 'forbidden' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout' | 'conflict' | 'cursor-invalid';
export type ClarificationReadResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: ClarificationReadUnavailableReasonV1 };
export interface ClarificationReadListQueryV1 {
  readonly version: 1; readonly repo: string | null; readonly runId: string | null;
  readonly states: readonly ClarificationReadStateV1[]; readonly limit: number; readonly cursor: string | null;
}
export interface ClarificationReadLoadQueryV1 { readonly version: 1; readonly repo: string; readonly runId: string; readonly questionId: string; }
export interface ClarificationReadItemV1 {
  readonly version: 1; readonly id: string; readonly runId: string; readonly repo: string; readonly revision: number;
  readonly prompt: string; readonly required: boolean; readonly owner: ClarificationReadOwnerV1; readonly contactId: string | null;
  readonly state: ClarificationReadStateV1; readonly answer: string | null; readonly createdAt: string; readonly timeoutAt: string | null; readonly answeredAt: string | null;
  readonly provenance: { readonly kind: 'attempt-channel'; readonly attempt: number; readonly channelId: string }
    | { readonly kind: 'legacy-unproven'; readonly attempt: null; readonly channelId: null };
  readonly currentAttempt: number | null; readonly blocksPublication: boolean;
  readonly answerability: { readonly available: true; readonly reason: null } | { readonly available: false; readonly reason: ClarificationAnswerUnavailableReasonV1 };
}
export interface ClarificationReadPageV1 {
  readonly version: 1; readonly repo: string | null; readonly items: readonly ClarificationReadItemV1[];
  readonly nextCursor: string | null; readonly total: number | null; readonly observedAt: string;
}
export interface ClarificationReadServiceV1 {
  readonly version: 1;
  list(input: ClarificationReadListQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationReadPageV1>>;
  load(input: ClarificationReadLoadQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ClarificationReadItemV1>>;
}
export const CLARIFICATION_READ_LIMITS: Readonly<{ responseBytes: number; page: number }> = Object.freeze({ responseBytes: 2 * 1024 * 1024, page: 100 });
const STATES: readonly ClarificationReadStateV1[] = ['pending', 'answered', 'timed-out', 'cancelled'];
export const CLARIFICATION_ANSWER_UNAVAILABLE_REASONS: readonly ClarificationAnswerUnavailableReasonV1[] = Object.freeze([
  'provenance-unknown', 'different-attempt', 'not-pending', 'run-unavailable', 'run-inactive', 'stop-requested', 'deadline-expired', 'channel-unavailable',
]);
function state(value: unknown): ClarificationReadStateV1 { if (!STATES.includes(value as ClarificationReadStateV1)) invalidClarification(); return value as ClarificationReadStateV1; }
export function parseClarificationReadListQueryV1(input: unknown): ClarificationReadListQueryV1 {
  const v = clarificationVersion(clarificationJson(input)); clarificationFields(v, ['version', 'repo', 'runId', 'states', 'limit', 'cursor']);
  const states = clarificationArray(v.states, state, STATES.length); if (new Set(states).size !== states.length) invalidClarification();
  return Object.freeze({ version: 1, repo: v.repo === null ? null : parseTaskRepo(v.repo), runId: v.runId === null ? null : clarificationId(v.runId),
    states: Object.freeze([...states].sort()), limit: clarificationInteger(v.limit, CLARIFICATION_READ_LIMITS.page), cursor: clarificationCursor(v.cursor) });
}
export function parseClarificationReadLoadQueryV1(input: unknown): ClarificationReadLoadQueryV1 {
  const v = clarificationVersion(input); clarificationFields(v, ['version', 'repo', 'runId', 'questionId']);
  return Object.freeze({ version: 1, repo: parseTaskRepo(v.repo), runId: clarificationId(v.runId), questionId: clarificationId(v.questionId) });
}
export function parseClarificationReadItemV1(input: unknown, expected?: ClarificationReadLoadQueryV1): ClarificationReadItemV1 {
  const v = clarificationVersion(input); clarificationFields(v, ['version', 'id', 'runId', 'repo', 'revision', 'prompt', 'required', 'owner', 'contactId', 'state', 'answer', 'createdAt', 'timeoutAt', 'answeredAt', 'provenance', 'currentAttempt', 'blocksPublication', 'answerability']);
  const id = clarificationId(v.id); const runId = clarificationId(v.runId); const repo = parseTaskRepo(v.repo); const currentAttempt = v.currentAttempt === null ? null : clarificationInteger(v.currentAttempt);
  if (expected && (expected.questionId !== id || expected.runId !== runId || expected.repo !== repo)) invalidClarification();
  const p = clarificationObject(v.provenance); clarificationFields(p, ['kind', 'attempt', 'channelId']);
  let provenance: ClarificationReadItemV1['provenance'];
  if (p.kind === 'attempt-channel') provenance = Object.freeze({ kind: p.kind, attempt: clarificationInteger(p.attempt), channelId: clarificationUuid(p.channelId) });
  else { if (p.kind !== 'legacy-unproven' || p.attempt !== null || p.channelId !== null) invalidClarification(); provenance = Object.freeze({ kind: 'legacy-unproven', attempt: null, channelId: null }); }
  const status = state(v.state); const required = clarificationBoolean(v.required); const blocksPublication = clarificationBoolean(v.blocksPublication);
  const answer = v.answer === null ? null : clarificationText(v.answer, 4000); const answeredAt = v.answeredAt === null ? null : clarificationTime(v.answeredAt);
  if (blocksPublication !== (required && status !== 'answered') || (status === 'answered') !== (answer !== null && answeredAt !== null)
    || status !== 'answered' && (answer !== null || answeredAt !== null) || v.owner !== 'local' && v.owner !== 'trusted-contact') invalidClarification();
  const a = clarificationObject(v.answerability); clarificationFields(a, ['available', 'reason']);
  let answerability: ClarificationReadItemV1['answerability'];
  if (a.available === true) {
    if (a.reason !== null || provenance.kind !== 'attempt-channel' || provenance.attempt !== currentAttempt || status !== 'pending') invalidClarification();
    answerability = Object.freeze({ available: true, reason: null });
  } else {
    if (a.available !== false || !CLARIFICATION_ANSWER_UNAVAILABLE_REASONS.includes(a.reason as ClarificationAnswerUnavailableReasonV1)) invalidClarification();
    answerability = Object.freeze({ available: false, reason: a.reason as ClarificationAnswerUnavailableReasonV1 });
  }
  return Object.freeze({ version: 1, id, runId, repo, revision: clarificationInteger(v.revision), prompt: clarificationText(v.prompt, 4000), required,
    owner: v.owner, contactId: v.contactId === null ? null : clarificationId(v.contactId), state: status, answer, createdAt: clarificationTime(v.createdAt),
    timeoutAt: v.timeoutAt === null ? null : clarificationTime(v.timeoutAt), answeredAt, provenance, currentAttempt, blocksPublication, answerability });
}
export function parseClarificationReadPageV1(input: unknown, query?: ClarificationReadListQueryV1, repos?: readonly string[]): ClarificationReadPageV1 {
  const v = clarificationVersion(clarificationJson(input, CLARIFICATION_READ_LIMITS.responseBytes)); clarificationFields(v, ['version', 'repo', 'items', 'nextCursor', 'total', 'observedAt']);
  const repo = v.repo === null ? null : parseTaskRepo(v.repo); const items = clarificationArray(v.items, value => parseClarificationReadItemV1(value), query?.limit ?? 100);
  if (query && repo !== query.repo || new Set(items.map(item => item.id)).size !== items.length
    || items.some(item => repo !== null && item.repo !== repo || repos && !repos.includes(item.repo) || query?.runId && item.runId !== query.runId || query?.states.length && !query.states.includes(item.state))) invalidClarification();
  const total = v.total === null ? null : v.total === 0 ? 0 : clarificationInteger(v.total);
  if (total !== null && total < items.length) invalidClarification();
  return Object.freeze({ version: 1, repo, items, nextCursor: clarificationCursor(v.nextCursor), total, observedAt: clarificationTime(v.observedAt) });
}
