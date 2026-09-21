import { describe, expect, it } from 'vitest';
import { parsePullRequestCommandInputV1, parsePullRequestCommandV1, parsePullRequestCommandReceiptV1, parsePullRequestCommandReceiptQueryV1 } from './pull-request-command';

const input = { version: 1 as const, repo: 'org/repo', number: 12, expectedHeadSha: 'a'.repeat(40), event: 'COMMENT' as const, body: '  My review.\n\n_Helmsman · not reported - not reported_\n' };
const command = { ...input, requestId: '12345678-1234-4123-8123-123456789abc' };
const success = { version: 1, requestId: command.requestId, input, status: 'succeeded', reason: null,
  result: { repo: input.repo, number: input.number, headSha: input.expectedHeadSha, actor: 'reviewer', reviewId: 42 } };
describe('public pull request command contract', () => {
  it('preserves exact review text and permits empty approvals', () => {
    expect(parsePullRequestCommandV1(command)).toEqual(command);
    expect(parsePullRequestCommandInputV1({ ...input, event: 'APPROVE', body: '' }).body).toBe('');
    expect(parsePullRequestCommandInputV1({ ...input, event: 'APPROVE', body: '  \n' }).body).toBe('  \n');
    expect(parsePullRequestCommandInputV1({ ...input, body: '😀'.repeat(32_000) }).body).toHaveLength(64_000);
  });
  it.each([{ event: 'COMMENT', body: ' \n' }, { event: 'REQUEST_CHANGES', body: '' }, { event: 'BAD' }, { body: '\u0000text' },
    { number: 0 }, { number: NaN }, { expectedHeadSha: 'main' }, { expectedHeadSha: 'a'.repeat(41) }, { extra: true }, { body: 'a'.repeat(64_001) }])('rejects invalid input %j', invalid => {
    expect(() => parsePullRequestCommandInputV1({ ...input, ...invalid })).toThrow();
  });
  it('checks receipt request, immutable input and exact reviewed identity', () => {
    expect(parsePullRequestCommandReceiptV1(success, command)).toEqual(success);
    expect(() => parsePullRequestCommandReceiptV1(success, { ...command, body: input.body.trim() })).toThrow();
    expect(() => parsePullRequestCommandReceiptV1(success, { repo: 'other/repo', requestId: command.requestId })).toThrow();
    for (const patch of [{ number: 13 }, { headSha: 'b'.repeat(40) }, { repo: 'other/repo' }, { reviewId: 0 }, { actor: '' }]) {
      expect(() => parsePullRequestCommandReceiptV1({ ...success, result: { ...success.result, ...patch } }, command)).toThrow();
    }
  });
  it('requires evidence-shaped success and reasons for unresolved or rejected outcomes', () => {
    for (const status of ['rejected', 'recovery-required']) {
      expect(parsePullRequestCommandReceiptV1({ ...success, status, result: null, reason: 'Unavailable.' }).status).toBe(status);
      expect(() => parsePullRequestCommandReceiptV1({ ...success, status, result: null })).toThrow();
    }
    expect(parsePullRequestCommandReceiptV1({ ...success, status: 'pending', result: null }).status).toBe('pending');
    expect(() => parsePullRequestCommandReceiptV1({ ...success, reason: 'unexpected' })).toThrow();
    expect(() => parsePullRequestCommandReceiptV1({ ...success, status: 'pending' })).toThrow();
  });
  it('rejects accessors without invoking them and constrains receipt queries', () => {
    let called = false;
    expect(() => parsePullRequestCommandInputV1({ ...input, get body() { called = true; return ''; } })).toThrow();
    expect(called).toBe(false);
    expect(parsePullRequestCommandReceiptQueryV1({ repo: input.repo, requestId: command.requestId })).toEqual({ repo: input.repo, requestId: command.requestId });
    expect(() => parsePullRequestCommandReceiptQueryV1({ repo: input.repo, requestId: command.requestId, body: '' })).toThrow();
  });
});
