import { describe, expect, it, vi } from 'vitest';
import { parseRunReadItemV1, parseRunReadListQueryV1, parseRunReadLogPageV1, parseRunReadPageV1, parseRunReadSummaryV1 } from './run-read';
import type { RunReadSummaryV1 } from './run-read';

const repo = 'owner/project';
const run: RunReadSummaryV1 = { version: 1, id: 'run-1', repo, displayKey: 'TASK-1', status: 'succeeded', attempt: 1,
  startedAt: '2026-09-20T12:00:00Z', endedAt: '2026-09-20T12:10:00Z', prNumber: 4, costUsd: null, review: null, sourceSettlement: { state: 'pending' } };
const query = { version: 1 as const, repo, kind: 'terminal' as const, limit: 10, cursor: null };
const logQuery = { version: 1 as const, repo, runId: run.id, limit: 10, cursor: null };
describe('public run read data', () => {
  it('accepts an optional retained title without requiring it from older providers', () => {
    expect(parseRunReadSummaryV1(run)).not.toHaveProperty('title');
    expect(parseRunReadSummaryV1({ ...run, title: 'Fix login failure' }).title).toBe('Fix login failure');
    for (const title of [null, 1, '', 'x'.repeat(513), 'line\nfeed']) {
      expect(() => parseRunReadSummaryV1({ ...run, title })).toThrow();
    }
  });
  it('copies and freezes allowlisted data while keeping worker result independent of settlement', () => {
    const source = { ...run, sourceSettlement: { state: 'pending' }, taskJson: 'private', worktreePath: '/private', hostRef: 'capability', review: { outcome: 'APPROVE', verdict: 'Approved', secret: 'private' } };
    const parsed = parseRunReadSummaryV1(source);
    source.sourceSettlement.state = 'settled';
    expect(parsed).toMatchObject({ status: 'succeeded', sourceSettlement: { state: 'pending' } });
    expect(parsed).not.toHaveProperty('taskJson'); expect(parsed).not.toHaveProperty('worktreePath'); expect(parsed).not.toHaveProperty('hostRef');
    expect(parsed.review).toEqual({ outcome: 'APPROVE', verdict: 'Approved' });
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.sourceSettlement)).toBe(true); expect(Object.isFrozen(parsed.review)).toBe(true);
  });
  it.each([
    { status: 'queued' }, { attempt: 0 }, { costUsd: -1 }, { costUsd: Infinity }, { startedAt: 'yesterday' }, { prNumber: 0 },
    { status: 'running', sourceSettlement: { state: 'pending' } }, { status: 'failed', review: { outcome: 'APPROVE', verdict: 'Invalid' } },
  ])('rejects invalid or misleading run summaries %j', changes => { expect(() => parseRunReadSummaryV1({ ...run, ...changes })).toThrow(); });
  it('does not invoke accessors or coercion callbacks', () => {
    const getter = vi.fn(() => run.id); const input = { ...run }; Object.defineProperty(input, 'id', { get: getter });
    expect(() => parseRunReadSummaryV1(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const toString = vi.fn(() => 'succeeded'); expect(() => parseRunReadSummaryV1({ ...run, status: { toString } })).toThrow(); expect(toString).not.toHaveBeenCalled();
  });
  it('enforces exact response scope, filter and unique run identity', () => {
    for (const changes of [{ repo: 'owner/other' }, { items: [{ ...run, repo: 'owner/other' }] }, { items: [run, run] }, { items: [{ ...run, status: 'running', sourceSettlement: null }] }]) {
      expect(() => parseRunReadPageV1({ version: 1, repo, items: [run], nextCursor: null, ...changes }, query, [repo, 'owner/other'])).toThrow();
    }
    expect(() => parseRunReadItemV1({ version: 1, repo, runId: run.id, run: { ...run, id: 'other' } }, logQuery)).toThrow();
  });
  it('rejects sparse arrays and overridden maps without running code', () => {
    const map = vi.fn(); const items = [run]; Object.defineProperty(items, 'map', { value: map });
    expect(() => parseRunReadPageV1({ version: 1, repo, items, nextCursor: null }, query, [repo])).toThrow(); expect(map).not.toHaveBeenCalled();
    expect(() => parseRunReadPageV1({ version: 1, repo, items: new Array(1), nextCursor: null }, query, [repo])).toThrow();
  });
  it('validates bounded queries and monotonically ordered log events', () => {
    expect(() => parseRunReadListQueryV1({ ...query, limit: 101 })).toThrow();
    expect(() => parseRunReadListQueryV1({ ...query, cursor: 'x'.repeat(4097) })).toThrow();
    const event = { sequence: 2, at: run.startedAt, kind: 'log', text: 'hello\nworld', truncated: false };
    const page = { version: 1, repo, runId: run.id, events: [event], nextCursor: 'opaque', hasMore: false, earlierTruncated: false, workerStatus: 'succeeded' };
    expect(parseRunReadLogPageV1(page, logQuery).events[0]?.text).toBe('hello\nworld');
    expect(() => parseRunReadLogPageV1({ ...page, events: [event, event] }, logQuery)).toThrow();
    expect(() => parseRunReadLogPageV1({ ...page, events: [], hasMore: true }, logQuery)).toThrow();
    expect(() => parseRunReadLogPageV1({ ...page, events: [{ ...event, text: 'x'.repeat(2001) }] }, logQuery)).toThrow();
  });
});

describe('feedback outcomes in the public run projection', () => {
  it.each([
    ['completed', 'succeeded', 'completed'], ['completed', 'running', null],
    ['completed', 'failed', 'changes_remaining'], ['completed', 'stopped', 'changes_remaining'],
    ['awaiting_decision', 'running', 'awaiting_decision'], ['awaiting_decision', 'succeeded', 'changes_remaining'],
    ['awaiting_decision', 'failed', 'changes_remaining'], ['awaiting_decision', 'stopped', 'changes_remaining'],
    ['changes_remaining', 'succeeded', 'changes_remaining'],
  ])('projects %s on %s as %s without changing execution status', (state, status, expected) => {
    const parsed = parseRunReadSummaryV1({ ...run, status, sourceSettlement: null,
      feedbackOutcome: { state, headSha: 'a'.repeat(40), summary: 'Feedback result.', privateData: 'omit' } });
    expect(parsed.status).toBe(status);
    expect(parsed.feedbackOutcome?.state ?? null).toBe(expected);
    if (expected) { expect(Object.isFrozen(parsed.feedbackOutcome)).toBe(true); expect(parsed.feedbackOutcome).not.toHaveProperty('privateData'); }
  });
  it.each([undefined, null, { state: 'completed' }, '{broken'])('omits absent or malformed optional outcome %j', feedbackOutcome => {
    expect(parseRunReadSummaryV1({ ...run, feedbackOutcome })).not.toHaveProperty('feedbackOutcome');
  });
});
