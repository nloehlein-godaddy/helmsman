import { describe, expect, it } from 'vitest';
import { parseRunCommandInputV1, parseRunCommandReceiptQueryV1, parseRunCommandReceiptV1, parseRunCommandV1, RUN_COMMAND_LIMITS } from './run-command';

const requestId = '00000000-0000-4000-8000-000000000001';
const base = { version: 1, repo: 'owner/repo', action: 'stop', target: { runId: 'run_1', expectedAttempt: 2 } };
const receipt = { version: 1, requestId, repo: base.repo, action: 'stop', status: 'accepted', runId: 'run_1', attempt: 2, message: null };
describe('public run command contract', () => {
  it('separates host request identities from authored input', () => {
    expect(parseRunCommandInputV1(base)).toEqual(base);
    expect(parseRunCommandV1({ ...base, requestId })).toEqual({ ...base, requestId });
    expect(() => parseRunCommandInputV1({ ...base, requestId })).toThrow();
    expect(() => parseRunCommandV1(base)).toThrow();
    expect(Object.isFrozen(parseRunCommandInputV1(base))).toBe(true);
    const parsed = parseRunCommandInputV1(base);
    expect(Object.isFrozen(parsed.action !== 'launch' && parsed.target)).toBe(true);
  });
  it.each([
    { mode: 'source', workRef: { sourceId: requestId, externalId: '42' }, sourceInstanceId: 'jira-one', sourceInstanceRevision: 3 },
    { mode: 'freeform', task: 'Implement\nrequirements', model: 'example', effort: 'high' },
    { mode: 'review', prNumber: 12, headSha: 'a'.repeat(40) },
    { mode: 'rerun', prNumber: 12, feedback: '' },
  ])('accepts only the bounded launch variants: $mode', launch => {
    expect(parseRunCommandInputV1({ version: 1, repo: base.repo, action: 'launch', launch })).toEqual({ version: 1, repo: base.repo, action: 'launch', launch });
  });
  it.each([
    { ...base, repo: '../other' }, { ...base, version: 2 }, { ...base, action: 'resume' },
    { ...base, pluginId: 'injected' }, { ...base, method: 'POST', path: '/api/config' },
    { ...base, target: { runId: 'a/b', expectedAttempt: 1 } }, { ...base, target: { runId: 'a', expectedAttempt: 0 } },
    { ...base, target: { runId: 'a', expectedAttempt: 1.5 } }, { ...base, target: null },
  ])('rejects invalid action, scope, identity and extra dispatch fields', value => { expect(() => parseRunCommandInputV1(value)).toThrow(); });
  it.each([
    { mode: 'ticket', ticketId: 'ISSUE-1' }, { mode: 'freeform', task: ' ' },
    { mode: 'freeform', task: 'a'.repeat(RUN_COMMAND_LIMITS.task + 1) },
    { mode: 'freeform', task: 'x', command: 'injected' }, { mode: 'review', prNumber: -1 },
    { mode: 'review', prNumber: 1, headSha: 'bad' }, { mode: 'rerun', prNumber: 1, feedback: '\0' },
    { mode: 'source', workRef: { sourceId: requestId, externalId: '42' }, sourceInstanceId: 'x/y', sourceInstanceRevision: 1 },
  ])('rejects malformed launch payloads', launch => { expect(() => parseRunCommandInputV1({ version: 1, repo: base.repo, action: 'launch', launch })).toThrow(); });
  it('does not invoke getters or accept inherited command data', () => {
    let read = false;
    const value = { ...base, get repo() { read = true; return base.repo; } };
    expect(() => parseRunCommandInputV1(value)).toThrow(); expect(read).toBe(false);
    expect(() => parseRunCommandInputV1(Object.create(base))).toThrow();
    expect(() => parseRunCommandInputV1({ ...base, [Symbol('unknown')]: 1 })).toThrow();
  });
  it('validates receipt identity before callers may clear their journal', () => {
    expect(parseRunCommandReceiptV1(receipt, { repo: base.repo, requestId, action: 'stop' })).toEqual(receipt);
    for (const changed of [{ repo: 'owner/other' }, { requestId: '00000000-0000-4000-8000-000000000002' }, { action: 'retry' }]) {
      expect(() => parseRunCommandReceiptV1({ ...receipt, ...changed }, { repo: base.repo, requestId, action: 'stop' })).toThrow();
    }
    expect(() => parseRunCommandReceiptV1({ ...receipt, runId: null })).toThrow();
    expect(() => parseRunCommandReceiptV1({ ...receipt, runId: null, attempt: null })).toThrow();
    expect(() => parseRunCommandReceiptV1({ ...receipt, status: 'stopped' })).toThrow();
    expect(parseRunCommandReceiptV1({ ...receipt, status: 'rejected', runId: null, attempt: null }).status).toBe('rejected');
  });
  it('accepts only scoped UUID receipt queries', () => {
    expect(parseRunCommandReceiptQueryV1({ repo: base.repo, requestId })).toEqual({ repo: base.repo, requestId });
    expect(() => parseRunCommandReceiptQueryV1({ repo: null, requestId })).toThrow();
    expect(() => parseRunCommandReceiptQueryV1({ repo: base.repo, requestId: 'abc' })).toThrow();
  });
  it('binds Stop receipts to the exact persisted target attempt', () => {
    const expected = parseRunCommandV1({ ...base, requestId });
    expect(parseRunCommandReceiptV1(receipt, expected)).toEqual(receipt);
    expect(() => parseRunCommandReceiptV1({ ...receipt, runId: 'another' }, expected)).toThrow();
    expect(() => parseRunCommandReceiptV1({ ...receipt, attempt: 3 }, expected)).toThrow();
    expect(parseRunCommandReceiptV1({ ...receipt, status: 'rejected', runId: null, attempt: null }, expected).status).toBe('rejected');
  });
});
