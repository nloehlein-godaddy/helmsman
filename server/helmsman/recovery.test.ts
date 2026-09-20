import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { recoverRuns } from './recovery';

let db: Db;
afterEach(() => db?.close());

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'claude-code',
    status: 'running', attempt: 1, prNumber: null,
    startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: '/tmp/w',
    hostRef: 'host-1', logPath: '/tmp/w/log.txt', exitPath: '/tmp/w/exit.json',
    taskJson: '{"ticketId":"LEKA-1"}',
    ...over,
  };
}

describe('recoverRuns', () => {
  it('dispatches each running row to reattach instead of failing it, without awaiting completion', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));
    db.insertRun(run({ id: 'c', status: 'succeeded', endedAt: '2026-08-17T00:00:00.000Z' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: async (row) => {
        seen.push(row.id);
        return { status: 'attached', completion: new Promise<void>(() => {}) };
      },
    });

    expect(new Set(seen)).toEqual(new Set(['a', 'b']));
    expect(new Set(res.reattached)).toEqual(new Set(['a', 'b']));
    expect(res.failed).toEqual([]);

    const a: RunRow | null = db.getRun('a');
    const b: RunRow | null = db.getRun('b');
    expect(a?.status).toBe('running');
    expect(b?.status).toBe('running');

    const c: RunRow | null = db.getRun('c');
    expect(c?.status).toBe('succeeded');
  });

  it('dispatches every row even when one reattach rejects', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: async (row) => {
        seen.push(row.id);
        if (row.id === 'a') throw new Error('boom');
        return { status: 'attached', completion: Promise.resolve() };
      },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(res.reattached).toEqual(['b']);
    expect(res.failed).toEqual(['a']);
    expect(db.getRun('a')?.status).toBe('running');
  });

  it('keeps dispatching remaining rows when one reattach throws synchronously', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: (row) => {
        seen.push(row.id);
        if (row.id === 'a') throw new Error('boom');
        return Promise.resolve({ status: 'attached', completion: Promise.resolve() });
      },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(res.reattached).toEqual(['b']);
    expect(res.failed).toEqual(['a']);
  });

  it('returns empty results when there are no reattachable runs', async () => {
    db = openDb(':memory:');
    const res = await recoverRuns(db, { reattach: async () => {} });
    expect(res).toEqual({ reattached: [], failed: [], blocked: [] });
  });

  it('waits for an explicit handshake while preserving the process through blocked attachment', async () => {
    db = openDb(':memory:'); db.insertRun(run());
    const recordAttachment = vi.fn();
    const result = await recoverRuns(db, { reattach: async () => ({ status: 'blocked', reason: 'Pinned host unavailable' }), recordAttachment });
    expect(result).toEqual({ reattached: [], failed: [], blocked: ['r1'] });
    expect(recordAttachment.mock.calls.map(call => call[1])).toEqual(['pending', 'blocked']);
    expect(db.getRun('r1')).toMatchObject({ status: 'running', hostRef: 'host-1', worktreePath: '/tmp/w' });
  });

  it('bounds missing handshakes and never reports legacy completion as attachment', async () => {
    db = openDb(':memory:'); db.insertRun(run());
    expect(await recoverRuns(db, { reattach: async () => {}, handshakeTimeoutMs: 10 })).toMatchObject({ blocked: ['r1'], reattached: [] });
    expect(await recoverRuns(db, { reattach: () => new Promise(() => {}), handshakeTimeoutMs: 10 })).toMatchObject({ blocked: ['r1'], reattached: [] });
    expect(db.getRun('r1')?.status).toBe('running');
  });

  it('deduplicates concurrent recovery and observes completion errors separately', async () => {
    db = openDb(':memory:'); db.insertRun(run());
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((_, fail) => { reject = fail; });
    const completionFailed = vi.fn();
    const reattach = vi.fn(async () => ({ status: 'attached' as const, completion }));
    const results = await Promise.all([recoverRuns(db, { reattach, completionFailed }), recoverRuns(db, { reattach, completionFailed })]);
    expect(reattach).toHaveBeenCalledOnce();
    expect(results.map(result => result.reattached)).toEqual([['r1'], ['r1']]);
    reject(new Error('monitor unavailable'));
    await vi.waitFor(() => expect(completionFailed).toHaveBeenCalledOnce());
    expect(db.getRun('r1')?.status).toBe('running');
  });

  it('includes prepared admissions provided by durable recovery inventory', async () => {
    db = openDb(':memory:');
    const prepared = run({ hostRef: null, logPath: null, exitPath: null });
    db.insertRun(prepared);
    const result = await recoverRuns(db, { rows: () => [prepared], reattach: async () => ({ status: 'blocked', reason: 'Launch ownership unknown' }) });
    expect(result.blocked).toEqual(['r1']);
  });
});
