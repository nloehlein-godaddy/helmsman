import type { ClarificationCommandReceiptV1, PanelOpaqueStateV1 } from '@helmsman/plugin-sdk';
import { bounded, fields, identifier, record, repository, text, uuid } from './saved-state.js';
export interface AnswerDraft { repo: string; runId: string; questionId: string; text: string; }
export interface AnswerResult { requestId: string; repo: string; runId: string; questionId: string; answer: string; status: 'succeeded' | 'rejected'; reason: string | null; }
export interface QuestionState { drafts: AnswerDraft[]; results: AnswerResult[]; }
export const key = (value: { repo: string; runId: string; questionId: string }) => JSON.stringify([value.repo, value.runId, value.questionId]);
export const empty = (): QuestionState => ({ drafts: [], results: [] });
export function readState(input: PanelOpaqueStateV1 | null): QuestionState | null {
  if (input === null) return empty();
  const value = input.value;
  if (input.version !== 1 || !bounded(input) || !record(value) || !fields(value, ['drafts', 'results']) || !Array.isArray(value.drafts) || value.drafts.length > 64 || !Array.isArray(value.results) || value.results.length > 32) return null;
  const drafts: AnswerDraft[] = []; const results: AnswerResult[] = [];
  for (const draft of value.drafts) {
    if (!record(draft) || !fields(draft, ['repo', 'runId', 'questionId', 'text']) || !repository(draft.repo) || !identifier(draft.runId) || !identifier(draft.questionId) || !text(draft.text, 4000)) return null;
    const next = { repo: draft.repo, runId: draft.runId, questionId: draft.questionId, text: draft.text };
    if (drafts.some(item => key(item) === key(next))) return null; drafts.push(next);
  }
  for (const result of value.results) {
    if (!record(result) || !fields(result, ['requestId', 'repo', 'runId', 'questionId', 'answer', 'status', 'reason']) || !uuid(result.requestId) || !repository(result.repo) || !identifier(result.runId) || !identifier(result.questionId)
      || !text(result.answer, 4000) || (result.status !== 'succeeded' && result.status !== 'rejected') || result.reason !== null && !text(result.reason, 128)
      || result.status === 'succeeded' && result.reason !== null || result.status === 'rejected' && !result.reason || results.some(item => item.requestId === result.requestId)) return null;
    results.push(result as unknown as AnswerResult);
  }
  return { drafts, results };
}
export const resultState = (receipt: ClarificationCommandReceiptV1): AnswerResult => ({ requestId: receipt.requestId, repo: receipt.input.repo, runId: receipt.input.runId,
  questionId: receipt.input.questionId, answer: receipt.input.answer, status: receipt.status, reason: receipt.reason });
