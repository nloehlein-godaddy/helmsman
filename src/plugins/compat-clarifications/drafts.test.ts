import { afterEach, expect, it } from 'vitest';
import { clarificationDraftKey, createClarificationDraftStore } from './drafts.js';
import type { ClarificationCommandReceiptV1 } from '@helmsman/plugin-sdk';

const key = clarificationDraftKey({ repo: 'org/project', runId: 'run', id: 'question' });
const receipt: ClarificationCommandReceiptV1 = { version: 1, requestId: '00000000-0000-4000-8000-000000000001', input: { version: 1, repo: 'org/project', runId: 'run', questionId: 'question', expectedAttempt: 1,
  expectedChannelId: '00000000-0000-4000-8000-000000000002', expectedQuestionRevision: 1, answer: 'Original' }, status: 'succeeded', result: { questionId: 'question', revision: 2, answer: 'Original', answeredAt: '2026-01-01T00:00:00Z' }, reason: null };
afterEach(() => localStorage.clear());
it('isolates unrelated tab drafts and durable results into separate storage records', () => {
  const first = createClarificationDraftStore('helmsman.compat-clarifications/page'); const second = createClarificationDraftStore('helmsman.compat-clarifications/page');
  first.answer(key, 'Original'); const stale = second.read(); first.accept(receipt, 'Answer accepted');
  const other = clarificationDraftKey({ repo: 'org/project', runId: 'run', id: 'other' }); second.answer(other, 'Another tab');
  second.contact({ name: 'Person', address: 'Account', enabled: true });
  expect(stale.results).toEqual([]); expect(first.read()).toMatchObject({ answers: { [key]: 'Original', [other]: 'Another tab' }, results: [{ requestId: receipt.requestId, message: 'Answer accepted' }] });
});
it('receipt acceptance never clears newer text written by another tab', () => {
  const first = createClarificationDraftStore('helmsman.compat-clarifications/page'); const second = createClarificationDraftStore('helmsman.compat-clarifications/page'); first.answer(key, 'Original');
  second.answer(key, 'New unsent draft'); first.accept(receipt, 'Answer accepted');
  expect(first.read().answers[key]).toBe('New unsent draft');
  expect(() => second.accept(receipt, 'A different result')).toThrow('result changed');
  expect(first.read().results[0]?.message).toBe('Answer accepted');
});
it('rejects malformed and oversized records without silently replacing saved state', () => {
  const store = createClarificationDraftStore('helmsman.compat-clarifications/page'); store.answer(key, 'Original');
  expect(() => store.answer(key, 'x'.repeat(4001))).toThrow(); expect(store.read().answers[key]).toBe('Original');
  localStorage.setItem('helmsman.compat-clarifications.drafts.v2:contact', '{'); expect(() => store.read()).toThrow();
  expect(localStorage.getItem('helmsman.compat-clarifications.drafts.v2:contact')).toBe('{');
});
it('refuses stale draft removal and removes only the expected current content', () => {
  const first = createClarificationDraftStore('helmsman.compat-clarifications/page'); const second = createClarificationDraftStore('helmsman.compat-clarifications/page');
  first.answer(key, 'Original'); first.contact({ name: 'Original', address: 'account', enabled: true });
  const selected = first.read(); second.answer(key, 'Newer'); second.contact({ ...selected.contact, name: 'Newer' });
  expect(() => first.removeAnswer(key, selected.answers[key])).toThrow('Saved draft changed');
  expect(() => first.removeContact(selected.contact)).toThrow('Saved draft changed');
  expect(second.read().answers[key]).toBe('Newer'); expect(second.read().contact.name).toBe('Newer');
  const current = second.read(); first.removeAnswer(key, current.answers[key]); first.removeContact(current.contact);
  expect(second.read().answers[key]).toBeUndefined(); expect(second.read().contact.name).toBe('');
});

it('isolates renamed callers from original drafts and results in both directions', () => {
  const original = createClarificationDraftStore('helmsman.compat-clarifications/page');
  const copy = createClarificationDraftStore('example.recovery/page');
  original.answer(key, 'Original evidence'); original.accept(receipt, 'Original result');
  const retained = Object.fromEntries(Object.entries(localStorage));
  expect(copy.read()).toMatchObject({ answers: {}, results: [] });
  copy.answer(key, 'Independent draft'); copy.accept(receipt, 'Independent result');
  expect(original.read()).toMatchObject({ answers: { [key]: 'Original evidence' }, results: [{ message: 'Original result' }] });
  copy.removeAnswer(key, 'Independent draft'); copy.removeResult(receipt.requestId);
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual(retained);
});

it('keeps unknown original formats byte-for-byte while independent caller writes remain usable', () => {
  const legacyKey = 'helmsman.compat-clarifications.drafts.v2:future-format';
  const evidence = '{"version":99,"opaque":"retained"}'; localStorage.setItem(legacyKey, evidence);
  const original = createClarificationDraftStore('helmsman.compat-clarifications/page');
  expect(() => original.read()).toThrow();
  const copy = createClarificationDraftStore('example.recovery/page'); copy.answer(key, 'Independent');
  expect(copy.read().answers[key]).toBe('Independent'); expect(localStorage.getItem(legacyKey)).toBe(evidence);
});

it.each([undefined, '', 'page', 'example.recovery/page:legacy', 'example.recovery/page/extra'])('rejects unknown or malformed contribution identity %s before accessing storage', identity => {
  const before = Object.fromEntries(Object.entries(localStorage));
  expect(() => createClarificationDraftStore(identity as string)).toThrow('contribution identity');
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual(before);
});
