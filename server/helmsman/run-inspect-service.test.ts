// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { createRunInspectService } from './run-inspect-service';
import { handleRunInspectApi } from './run-inspect-routes';
import { RUN_INSPECT_LIMITS } from '../../src/plugins/run-inspect';

const repo = 'owner/project'; const other = 'owner/other'; const at = '2026-09-20T12:00:00Z';
const target = { repo, runId: 'run-1', expectedAttempt: 1 };
const history = { version: 1 as const, repo, kind: 'all' as const, limit: 2, cursor: null };
const log = { version: 1 as const, target, scopeRepo: repo, direction: 'backward' as const, limit: 2, cursor: null };
let db: Db;
beforeEach(() => { db = openDb(':memory:'); }); afterEach(() => { db.close(); });
function run(changes: Partial<RunRow> = {}): RunRow { return { id: target.runId, repo, ticketId: 'TASK-1', adapter: 'private', status: 'succeeded', attempt: 1,
  prNumber: null, startedAt: at, endedAt: at, costUsd: null, worktreePath: '/private/worktree', ...changes }; }
const fixture = () => createRunInspectService({ db, repos: () => [repo, other], now: () => at });
const append = (text: string, id = target.runId) => db.appendEvent(id, 'log', text, at);
async function collect(chunks: AsyncIterable<Uint8Array>) { const parts = []; for await (const part of chunks) parts.push(part); return Buffer.concat(parts).toString('utf8'); }

describe('scoped run inspection', () => {
  it('resolves only within effective permitted scope without exposing internal metadata', () => {
    db.insertRun(run()); const service = fixture();
    expect(service.resolve({ version: 1, repo, runId: target.runId })).toEqual({ version: 1, target, observedAt: at });
    expect(service.resolve({ version: 1, repo: null, runId: target.runId })).toMatchObject({ target });
    expect(() => service.resolve({ version: 1, repo: other, runId: target.runId })).toThrow('not-found');
    expect(() => service.resolve({ version: 1, repo: other, runId: 'missing' })).toThrow('not-found');
    const rows = vi.spyOn(db, 'runInspectLog'); expect(() => service.log({ ...log, scopeRepo: other })).toThrow('not-found'); expect(rows).not.toHaveBeenCalled();
  });
  it('counts all matching rows before the keyset boundary and excludes later backdated insertions', () => {
    for (const id of ['a', 'b', 'c', 'd']) db.insertRun(run({ id })); db.insertRun(run({ id: 'foreign', repo: other }));
    const service = fixture(); const first = service.history(history);
    expect(first).toMatchObject({ total: 4, totalQuality: 'exact', coverage: 'insertion-bounded-current-state', observedAt: at });
    expect(first.items.map(row => row.id)).toEqual(['d', 'c']);
    db.insertRun(run({ id: 'backdated', startedAt: '2026-09-19T00:00:00Z' }));
    const second = service.history({ ...history, cursor: first.nextCursor }); expect(second.total).toBe(4); expect(second.items.map(row => row.id)).toEqual(['b', 'a']);
    expect(service.history(history).total).toBe(5);
  });
  it('reobserves status changes truthfully and preserves review/settlement parity', () => {
    for (const id of ['a', 'b', 'c']) db.insertRun(run({ id }));
    const service = createRunInspectService({ db, repos: () => [repo], settlement: () => ({ state: 'pending' }) });
    append('Verdict: Approve — Reviewed.', 'c'); db.appendEvent('c', 'review-verdict', 'Verdict: Approve — Reviewed.', at);
    const first = service.history({ ...history, kind: 'terminal', limit: 1 });
    expect(first.items[0]).toMatchObject({ review: { outcome: 'APPROVE' }, sourceSettlement: { state: 'pending' } });
    expect(first.items[0]).not.toHaveProperty('worktreePath');
    db.updateRun('a', { status: 'running', endedAt: null });
    const second = service.history({ ...history, kind: 'terminal', limit: 1, cursor: first.nextCursor }); expect(second.total).toBe(2); expect(second.items.map(row => row.id)).toEqual(['b']);
    expect(service.history({ ...history, kind: 'running' }).items[0]?.sourceSettlement).toBeNull();
  });
  it('binds history cursors to permitted repos, filter and service lifetime', () => {
    db.insertRun(run({ id: 'a' })); db.insertRun(run({ id: 'b' })); let repos = [repo, other];
    const service = createRunInspectService({ db, repos: () => repos }); const first = service.history({ ...history, repo: null, limit: 1 });
    expect(() => service.history({ ...history, cursor: first.nextCursor })).toThrow('cursor-invalid');
    expect(() => service.history({ ...history, repo: null, kind: 'terminal', cursor: first.nextCursor })).toThrow('cursor-invalid');
    expect(() => fixture().history({ ...history, repo: null, cursor: first.nextCursor })).toThrow('cursor-invalid');
    repos = [repo]; expect(() => service.history({ ...history, repo: null, cursor: first.nextCursor })).toThrow('cursor-invalid');
  });
  it('keeps independent backward and live cursors with ascending events and fixed observation windows', () => {
    db.insertRun(run()); for (let index = 1; index <= 6; index++) append(String(index)); const service = fixture();
    const tail = service.log(log); expect(tail.events.map(event => event.sequence)).toEqual([5, 6]); expect(tail).toMatchObject({ provenance: 'run-wide', hasEarlier: true, hasLater: false, throughSequence: 6 });
    append('7'); append('8'); append('9');
    const older = service.log({ ...log, cursor: tail.nextCursor }); expect(older.events.map(event => event.sequence)).toEqual([3, 4]); expect(older.followCursor).toBeNull(); expect(older.throughSequence).toBe(6);
    const oldest = service.log({ ...log, cursor: older.nextCursor }); expect(oldest.events.map(event => event.sequence)).toEqual([1, 2]); expect(oldest.nextCursor).toBeNull();
    const forward = service.log({ ...log, direction: 'forward', cursor: tail.followCursor }); expect(forward.events.map(event => event.sequence)).toEqual([7, 8]); expect(forward.hasLater).toBe(true);
    append('10'); const drain = service.log({ ...log, direction: 'forward', cursor: forward.nextCursor }); expect(drain.events.map(event => event.sequence)).toEqual([9]); expect(drain.throughSequence).toBe(9);
    const next = service.log({ ...log, direction: 'forward', cursor: drain.nextCursor }); expect(next.events.map(event => event.sequence)).toEqual([10]);
    expect(service.log({ ...log, direction: 'forward', cursor: next.nextCursor })).toMatchObject({ events: [], hasEarlier: true, hasLater: false });
  });
  it('fences attempts, directions, effective scope and tampered cursors', () => {
    db.insertRun(run()); append('a'); append('b'); append('c'); const service = fixture(); const tail = service.log(log);
    expect(() => service.log({ ...log, direction: 'forward', cursor: tail.nextCursor })).toThrow('cursor-invalid');
    expect(() => service.log({ ...log, scopeRepo: null, cursor: tail.nextCursor })).toThrow('cursor-invalid');
    expect(() => service.log({ ...log, cursor: `${tail.nextCursor}x` })).toThrow('cursor-invalid');
    db.updateRun(target.runId, { attempt: 2 }); expect(() => service.log({ ...log, cursor: tail.nextCursor })).toThrow('attempt-changed');
    expect(() => service.log({ ...log, target: { ...target, expectedAttempt: 2 }, cursor: tail.nextCursor })).toThrow('cursor-invalid');
    expect(service.log({ ...log, target: { ...target, expectedAttempt: 2 } }).events).toHaveLength(2);
  });
  it('clips Unicode preview precisely and preserves embedded NUL characters', () => {
    db.insertRun(run()); append('nul\0kept'); append('x'.repeat(3999) + '🛟' + 'z'.repeat(30)); const tail = fixture().log(log);
    expect(tail.events[0]).toMatchObject({ text: 'nul\0kept', truncated: false }); expect(tail.events[1]).toMatchObject({ text: 'x'.repeat(3999), truncated: true });
    expect(tail.events[1]?.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('follows empty logs when their first event arrives', () => {
    db.insertRun(run()); const service = fixture(); const empty = service.log(log); expect(empty.events).toEqual([]); expect(empty.nextCursor).toBeNull(); expect(empty.followCursor).toBeTruthy();
    append('first'); expect(service.log({ ...log, direction: 'forward', cursor: empty.followCursor }).events[0]?.text).toBe('first');
  });
  it('streams full watermark-bounded Unicode text in byte-sized reads without whole event rows', async () => {
    db.insertRun(run()); const content = 'x'.repeat(65530) + '🛟'.repeat(100000) + '\0tail'; append(content);
    const whole = vi.spyOn(db, 'eventPage'); const chunks = vi.spyOn(db, 'runInspectEventBytes'); const service = fixture(); const exportLog = service.openExport({ version: 1, target, scopeRepo: repo });
    append('later'); expect(exportLog.metadata).toMatchObject({ provenance: 'run-wide', throughSequence: 1 });
    expect(await collect(exportLog.chunks())).toBe(`[${at}] log: ${content}\n`); expect(whole).not.toHaveBeenCalled();
    expect(chunks.mock.calls.every(call => call[4] <= RUN_INSPECT_LIMITS.exportChunkBytes)).toBe(true); expect(chunks.mock.calls.length).toBeGreaterThan(5);
  });
  it.each(['attempt', 'scope', 'caller'] as const)('rejects %s changes during export instead of silently completing partial bytes', async reason => {
    db.insertRun(run()); append('huge'.repeat(100000)); let repos = [repo, other]; const controller = new AbortController();
    const service = createRunInspectService({ db, repos: () => repos }); const output = service.openExport({ version: 1, target, scopeRepo: null }); const iterator = output.chunks(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    if (reason === 'attempt') db.updateRun(target.runId, { attempt: 2 }); else if (reason === 'scope') repos = [repo]; else controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
  it('exports an empty log and rejects stale attempts before streaming', async () => {
    db.insertRun(run()); const service = fixture(); expect(await collect(service.openExport({ version: 1, target, scopeRepo: repo }).chunks())).toBe('');
    expect(() => service.openExport({ version: 1, target: { ...target, expectedAttempt: 2 }, scopeRepo: repo })).toThrow('attempt-changed');
  });
  it('keeps API routes read-only and sanitizes missing, invalid and internal failures', () => {
    db.insertRun(run()); const service = fixture(); const route = (path: string, params = '', method = 'GET') => handleRunInspectApi({ path, query: new URLSearchParams(params), method, service });
    expect(route('/other')).toBeNull(); expect(route('/api/run-inspect/history', '', 'POST')?.status).toBe(405);
    expect(route('/api/run-inspect/resolve', `repo=${repo}&runId=run-1`)?.status).toBe(200);
    expect(route('/api/run-inspect/history', 'limit=0')?.status).toBe(400);
    expect(route('/api/run-inspect/run-1/log', `repo=${repo}&expectedAttempt=1&direction=forward`)?.status).toBe(400);
    expect(route('/api/run-inspect/run-1/log', `repo=${repo}&expectedAttempt=2&direction=backward`)?.json).toEqual({ error: 'attempt-changed' });
    const failing = createRunInspectService({ db, repos() { throw new Error('/private/secret'); } });
    expect(handleRunInspectApi({ method: 'GET', path: '/api/run-inspect/history', query: new URLSearchParams(), service: failing })).toEqual({ status: 503, json: { error: 'service-unavailable' } });
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
  const service = fixture(); const result = service.history(history).items[0];
  expect(result?.status).toBe(status); expect(result?.feedbackOutcome?.state ?? null).toBe(expected);
  db.appendEvent('run-1', 'feedback-outcome', '{broken', '2026-09-20T12:02:00Z');
  expect(service.history(history).items[0]).not.toHaveProperty('feedbackOutcome');
});

it('projects retained task titles without exposing task data and tolerates malformed history', () => {
  db.insertRun(run({ taskJson: JSON.stringify({ title: 'Fix login failure', secret: 'private' }) }));
  const item = fixture().history(history).items[0];
  expect(item?.title).toBe('Fix login failure'); expect(item).not.toHaveProperty('taskJson'); expect(item).not.toHaveProperty('secret');
  db.updateRun('run-1', { taskJson: '{broken' });
  expect(fixture().history(history).items[0]).not.toHaveProperty('title');
});
