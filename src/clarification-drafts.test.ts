import { afterEach, expect, it } from 'vitest';
import { clarificationDraftKey, createClarificationDraftStore } from './clarification-drafts';
import type { ClarificationCommandReceiptV1 } from './plugins/clarification-command';

const key = clarificationDraftKey({ repo: 'org/project', runId: 'run', id: 'question' });
const receipt: ClarificationCommandReceiptV1 = { version: 1, requestId: '00000000-0000-4000-8000-000000000001', input: { version: 1, repo: 'org/project', runId: 'run', questionId: 'question', expectedAttempt: 1,
  expectedChannelId: '00000000-0000-4000-8000-000000000002', expectedQuestionRevision: 1, answer: 'Original' }, status: 'succeeded', result: { questionId: 'question', revision: 2, answer: 'Original', answeredAt: '2026-01-01T00:00:00Z' }, reason: null };
afterEach(() => localStorage.clear());
it('isolates unrelated tab drafts and durable results into separate storage records', () => {
  const first = createClarificationDraftStore(); const second = createClarificationDraftStore();
  first.answer(key, 'Original'); const stale = second.read(); first.accept(receipt, 'Answer accepted');
  const other = clarificationDraftKey({ repo: 'org/project', runId: 'run', id: 'other' }); second.answer(other, 'Another tab');
  second.contact({ name: 'Person', address: 'Account', enabled: true });
  expect(stale.results).toEqual([]); expect(first.read()).toMatchObject({ answers: { [key]: 'Original', [other]: 'Another tab' }, results: [{ requestId: receipt.requestId, message: 'Answer accepted' }] });
});
it('receipt acceptance never clears newer text written by another tab', () => {
  const first = createClarificationDraftStore(); const second = createClarificationDraftStore(); first.answer(key, 'Original');
  second.answer(key, 'New unsent draft'); first.accept(receipt, 'Answer accepted');
  expect(first.read().answers[key]).toBe('New unsent draft');
  expect(() => second.accept(receipt, 'A different result')).toThrow('result changed');
  expect(first.read().results[0]?.message).toBe('Answer accepted');
});
it('rejects malformed and oversized records without silently replacing saved state', () => {
  const store = createClarificationDraftStore(); store.answer(key, 'Original');
  expect(() => store.answer(key, 'x'.repeat(4001))).toThrow(); expect(store.read().answers[key]).toBe('Original');
  localStorage.setItem('helmsman.compat-clarifications.drafts.v2:contact', '{'); expect(() => store.read()).toThrow();
  expect(localStorage.getItem('helmsman.compat-clarifications.drafts.v2:contact')).toBe('{');
});
