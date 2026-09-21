import { expect, it, vi } from 'vitest';
import { parseClarificationReadItemV1, parseClarificationReadListQueryV1, parseClarificationReadPageV1, type ClarificationReadItemV1 } from './clarification-read';
import { parseClarificationCommandInputV1, parseClarificationCommandReceiptV1, type ClarificationCommandInputV1, type ClarificationCommandV1 } from './clarification-command';
import { parseSuggestedContactAdminInputV1, parseSuggestedContactAdminReceiptV1 } from './suggested-contact-admin';

const uuid = '00000000-0000-4000-8000-000000000001';
const time = '2026-01-01T00:00:00.000Z';
const input: ClarificationCommandInputV1 = { version: 1, repo: 'org/project', runId: 'run', questionId: 'question', expectedAttempt: 1, expectedChannelId: uuid, expectedQuestionRevision: 1, answer: 'Yes' };
const item: ClarificationReadItemV1 = { version: 1, id: 'question', runId: 'run', repo: 'org/project', revision: 1, prompt: 'Proceed?', required: true, owner: 'local', contactId: null,
  state: 'pending', answer: null, createdAt: time, timeoutAt: null, answeredAt: null, provenance: { kind: 'attempt-channel', attempt: 1, channelId: uuid }, currentAttempt: 1,
  blocksPublication: true, answerability: { available: true, reason: null } };
it('keeps unknown and prior required obligations visible but rejects invented answer eligibility', () => {
  const unknown = { ...item, provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { available: false, reason: 'provenance-unknown' } };
  expect(parseClarificationReadItemV1(unknown)).toMatchObject({ blocksPublication: true, provenance: { kind: 'legacy-unproven' } });
  expect(() => parseClarificationReadItemV1({ ...unknown, answerability: item.answerability })).toThrow();
  expect(() => parseClarificationReadItemV1({ ...item, currentAttempt: 2 })).toThrow();
  expect(() => parseClarificationReadItemV1({ ...item, state: 'cancelled', blocksPublication: false })).toThrow();
  expect(() => parseClarificationReadItemV1({ ...item, state: 'answered', blocksPublication: false })).toThrow();
});
it('validates scoped question identity, filters, duplicate rows, bounds and observation metadata', () => {
  const query = parseClarificationReadListQueryV1({ version: 1, repo: 'org/project', runId: 'run', states: ['pending'], limit: 1, cursor: null });
  const page = { version: 1, repo: query.repo, items: [item], nextCursor: null, total: 1, observedAt: time };
  expect(parseClarificationReadPageV1(page, query, ['org/project']).items).toHaveLength(1);
  for (const changed of [{ items: [item, item] }, { total: 0 }, { repo: null }, { observedAt: 'bad' }, { items: [{ ...item, repo: 'org/foreign' }] }]) {
    expect(() => parseClarificationReadPageV1({ ...page, ...changed }, query, ['org/project'])).toThrow();
  }
  expect(() => parseClarificationReadListQueryV1({ ...query, states: ['pending', 'pending'] })).toThrow();
  expect(() => parseClarificationReadListQueryV1({ ...query, limit: 101 })).toThrow();
  expect(() => parseClarificationReadItemV1(item, { version: 1, repo: item.repo, runId: 'different', questionId: item.id })).toThrow();
});
it('preserves existing trimmed UTF16 answer and contact semantics without email-only restrictions', () => {
  expect(parseClarificationCommandInputV1({ ...input, answer: '  Yes\n界  ' }).answer).toBe('Yes\n界');
  expect(parseClarificationCommandInputV1({ ...input, answer: '😀'.repeat(2000) }).answer.length).toBe(4000);
  expect(() => parseClarificationCommandInputV1({ ...input, answer: '😀'.repeat(2001) })).toThrow();
  expect(() => parseClarificationCommandInputV1({ ...input, answer: '\n ' })).toThrow();
  expect(parseSuggestedContactAdminInputV1({ version: 1, scope: 'global', kind: 'create', name: ' Person ', address: ' Slack ID ', enabled: false })).toMatchObject({ name: 'Person', address: 'Slack ID', enabled: false });
  expect(() => parseSuggestedContactAdminInputV1({ version: 1, scope: 'global', kind: 'create', name: 'Person', address: 'address' })).toThrow();
});
it('validates full immutable answer receipt identity and durable acceptance evidence', () => {
  const command: ClarificationCommandV1 = { ...input, requestId: uuid };
  const receipt = { version: 1, requestId: uuid, input, status: 'succeeded', result: { questionId: 'question', revision: 2, answer: 'Yes', answeredAt: time }, reason: null };
  expect(parseClarificationCommandReceiptV1(receipt, command).status).toBe('succeeded');
  for (const changed of [{ input: { ...input, expectedAttempt: 2 } }, { input: { ...input, answer: 'No' } }, { result: { ...receipt.result, revision: 3 } }, { result: { ...receipt.result, answer: 'No' } }, { reason: 'run-inactive' }, { consumed: true }]) {
    expect(() => parseClarificationCommandReceiptV1({ ...receipt, ...changed }, command)).toThrow();
  }
  expect(parseClarificationCommandReceiptV1({ ...receipt, status: 'rejected', result: null, reason: 'stop-requested' }, command).reason).toBe('stop-requested');
});
it('validates host-reserved contact identity, global scope and revision checked results', () => {
  const input = { version: 1 as const, scope: 'global' as const, kind: 'create' as const, name: 'Person', address: 'address', enabled: true, id: uuid };
  const receipt = { version: 1, scope: 'global', requestId: uuid, input, status: 'succeeded', result: { id: uuid, revision: 1, name: 'Person', address: 'address', enabled: true, createdAt: time }, reason: null };
  expect(parseSuggestedContactAdminReceiptV1(receipt, { ...input, requestId: uuid }).result?.revision).toBe(1);
  expect(() => parseSuggestedContactAdminInputV1(input)).toThrow();
  expect(() => parseSuggestedContactAdminReceiptV1({ ...receipt, repo: 'org/project' })).toThrow();
  expect(() => parseSuggestedContactAdminReceiptV1({ ...receipt, result: { ...receipt.result, revision: 2 } })).toThrow();
  expect(() => parseSuggestedContactAdminReceiptV1({ ...receipt, result: { ...receipt.result, address: 'other' } })).toThrow();
});
it('rejects accessors, hidden transport metadata and caller-selected IDs before side effects', () => {
  const getter = vi.fn(); const bad = Object.defineProperty({ ...input }, 'answer', { enumerable: true, get: getter });
  expect(() => parseClarificationCommandInputV1(bad)).toThrow(); expect(getter).not.toHaveBeenCalled();
  expect(() => parseClarificationCommandInputV1({ ...input, requestId: uuid })).toThrow();
  expect(() => parseClarificationReadItemV1({ ...item, questionsPath: '/private/path' })).toThrow();
  expect(Object.isFrozen(parseClarificationReadItemV1(item).provenance)).toBe(true);
});
