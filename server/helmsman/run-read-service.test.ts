// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { createRunReadService } from './run-read-service';
import { handleRunReadApi } from './run-read-routes';
import type { RunReadSettlementV1 } from '../../src/plugins/run-read';

const repo = 'owner/project'; const other = 'owner/other';
const query = { version: 1 as const, repo, kind: 'all' as const, limit: 2, cursor: null };
const detail = { version: 1 as const, repo, runId: 'run-1' };
let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });
function run(changes: Partial<RunRow> = {}): RunRow { return { id: 'run-1', repo, ticketId: 'TASK-1', adapter: 'private-adapter', status: 'succeeded',
  attempt: 1, prNumber: null, startedAt: '2026-09-20T12:00:00Z', endedAt: '2026-09-20T12:10:00Z', costUsd: null,
  worktreePath: '/private/worktree', hostRef: 'private-capability', taskJson: '{"secret":true}', launchJson: '{"private":true}', ...changes }; }
function fixture() { return createRunReadService({ db, repos: () => [repo, other] }); }
describe('server run read projection', () => {
  it('filters scope and status before applying the result limit', () => {
    db.insertRun(run({ id: 'old-running', status: 'running', endedAt: null }));
    for (let index = 0; index < 70; index++) db.insertRun(run({ id: `new-${index}`, repo: other, startedAt: '2026-09-21T12:00:00Z' }));
    db.insertRun(run({ id: 'new-terminal', startedAt: '2026-09-21T12:00:00Z' }));
    expect(fixture().list({ ...query, kind: 'running', limit: 1 }).items.map(item => item.id)).toEqual(['old-running']);
    expect(fixture().list({ ...query, kind: 'terminal', limit: 1 }).items.map(item => item.id)).toEqual(['new-terminal']);
  });
  it('keeps keyset pages stable across insertions and binds opaque cursors to their query and lifetime', () => {
    for (const id of ['a', 'b', 'c', 'd']) db.insertRun(run({ id }));
    const service = fixture(); const first = service.list(query);
    expect(first.items.map(item => item.id)).toEqual(['d', 'c']); expect(first.nextCursor).not.toBeNull();
    db.insertRun(run({ id: 'new-backdated', startedAt: '2026-09-19T12:00:00Z' }));
    const next = service.list({ ...query, cursor: first.nextCursor }); expect(next.items.map(item => item.id)).toEqual(['b', 'a']); expect(next.nextCursor).toBeNull();
    expect(() => service.list({ ...query, repo: other, cursor: first.nextCursor })).toThrow('scope');
    expect(() => service.list({ ...query, kind: 'terminal', cursor: first.nextCursor })).toThrow('scope');
    expect(() => fixture().list({ ...query, cursor: first.nextCursor })).toThrow('expired');
    expect(() => service.list({ ...query, cursor: `${first.nextCursor}x` })).toThrow('expired');
  });
  it('never conflates succeeded workers and pending settlement or exposes private run data', () => {
    db.insertRun(run());
    const settlement = vi.fn((): RunReadSettlementV1 => ({ state: 'pending' }));
    const service = createRunReadService({ db, repos: () => [repo], settlement });
    const item = service.load(detail).run;
    expect(item).toMatchObject({ status: 'succeeded', sourceSettlement: { state: 'pending' } });
    for (const key of ['taskJson', 'launchJson', 'adapter', 'worktreePath', 'hostRef']) expect(item).not.toHaveProperty(key);
    db.updateRun('run-1', { status: 'running', endedAt: null }); settlement.mockClear();
    expect(service.load(detail).run?.sourceSettlement).toBeNull(); expect(settlement).not.toHaveBeenCalled();
  });
  it('enforces configured scope and hides cross-repository run identity before reading its events', () => {
    db.insertRun(run({ repo: other })); const service = fixture();
    expect(service.load(detail).run).toBeNull();
    const recent = vi.spyOn(db, 'recentEvents');
    expect(() => service.log({ ...detail, cursor: null, limit: 2 })).toThrow('not found'); expect(recent).not.toHaveBeenCalled();
    expect(() => service.load({ ...detail, repo: 'unknown/project' })).toThrow('forbidden');
    const restricted = createRunReadService({ db, repos: () => [repo] });
    expect(restricted.list({ ...query, repo: null }).items).toEqual([]);
  });
  it('reads bounded initial log snapshots then catches up without duplicate events or loss across polling watermarks', () => {
    db.insertRun(run()); const service = fixture();
    for (let index = 0; index < 4; index++) db.appendEvent('run-1', 'log', index === 3 ? 'x'.repeat(5000) : String(index), '2026-09-20T12:01:00Z');
    const first = service.log({ ...detail, cursor: null, limit: 2 });
    expect(first.earlierTruncated).toBe(true); expect(first.events.map(event => event.sequence)).toEqual([3, 4]);
    expect(first.events[1]).toMatchObject({ truncated: true, text: 'x'.repeat(2000) });
    expect(db.listEvents('run-1')[3]?.text).toHaveLength(5000);
    for (let index = 0; index < 3; index++) db.appendEvent('run-1', 'run-complete', 'failed', '2026-09-20T12:02:00Z');
    const second = service.log({ ...detail, cursor: first.nextCursor, limit: 2 });
    expect(second.events.map(event => event.sequence)).toEqual([5, 6]); expect(second.hasMore).toBe(true); expect(second.workerStatus).toBe('succeeded');
    db.appendEvent('run-1', 'log', 'later', '2026-09-20T12:03:00Z');
    const third = service.log({ ...detail, cursor: second.nextCursor, limit: 2 });
    expect(third.events.map(event => event.sequence)).toEqual([7]); expect(third.hasMore).toBe(false);
    const fourth = service.log({ ...detail, cursor: third.nextCursor, limit: 2 });
    expect(fourth.events.map(event => event.sequence)).toEqual([8]);
    expect(service.log({ ...detail, cursor: fourth.nextCursor, limit: 2 }).events).toEqual([]);
  });
  it('retains truthful successful review outcomes separately from worker failures', () => {
    db.insertRun(run()); db.appendEvent('run-1', 'review-verdict', 'Verdict: Request changes — Regression found.', '2026-09-20T12:01:00Z');
    const service = fixture(); expect(service.load(detail).run?.review?.outcome).toBe('REQUEST_CHANGES');
    db.updateRun('run-1', { status: 'failed' }); expect(service.load(detail).run?.review).toBeNull();
  });
  it('keeps routes read-only, validates requests and sanitizes internal errors', () => {
    db.insertRun(run()); const service = fixture();
    const route = (path: string, query = '', method = 'GET') => handleRunReadApi({ method, path, query: new URLSearchParams(query), service });
    expect(route('/api/unrelated')).toBeNull(); expect(route('/api/run-read', '', 'POST')?.status).toBe(405);
    expect(route('/api/run-read', `repo=${repo}&limit=0`)?.status).toBe(400);
    expect(route('/api/run-read', `repo=${repo}&kind=queued`)?.status).toBe(400);
    expect(route('/api/run-read/run-1')?.status).toBe(400);
    expect(route('/api/run-read/run-1', `repo=${repo}`)?.status).toBe(200);
    expect(route('/api/run-read/run-1/log', `repo=${repo}&cursor=bad`)?.status).toBe(409);
    const failing = createRunReadService({ db, repos: () => { throw new Error('/private/secrets'); } });
    expect(handleRunReadApi({ method: 'GET', path: '/api/run-read', query: new URLSearchParams(), service: failing })).toEqual({ status: 503, json: { error: 'Run reads unavailable' } });
  });
});

it.each([
  ['completed', 'succeeded', 'completed'], ['completed', 'running', null],
  ['completed', 'failed', 'changes_remaining'], ['completed', 'stopped', 'changes_remaining'],
  ['awaiting_decision', 'running', 'awaiting_decision'], ['awaiting_decision', 'failed', 'changes_remaining'],
  ['changes_remaining', 'succeeded', 'changes_remaining'],
] as const)('projects latest %s feedback on %s as %s', (state, status, expected) => {
  db.insertRun(run({ status, endedAt: status === 'running' ? null : '2026-09-20T12:10:00Z' }));
  db.appendEvent('run-1', 'feedback-outcome', JSON.stringify({ state, headSha: 'a'.repeat(40), summary: 'Feedback checked.' }), '2026-09-20T12:01:00Z');
  const service = fixture(); const result = service.load(detail).run;
  expect(result?.status).toBe(status); expect(result?.feedbackOutcome?.state ?? null).toBe(expected);
  db.appendEvent('run-1', 'feedback-outcome', '{broken', '2026-09-20T12:02:00Z');
  expect(service.load(detail).run).not.toHaveProperty('feedbackOutcome');
});

it('projects retained task titles without exposing task data and tolerates malformed history', () => {
  db.insertRun(run({ taskJson: JSON.stringify({ title: 'Fix login failure', secret: 'private' }) }));
  const item = fixture().load(detail).run;
  expect(item?.title).toBe('Fix login failure'); expect(item).not.toHaveProperty('taskJson'); expect(item).not.toHaveProperty('secret');
  db.updateRun('run-1', { taskJson: '{broken' });
  expect(fixture().load(detail).run).not.toHaveProperty('title');
});
