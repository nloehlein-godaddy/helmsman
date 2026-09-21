import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { recoverRuns, startRunRecovery, type AttachmentHandshake } from './recovery';

let db: Db;
afterEach(() => { vi.useRealTimers(); db?.close(); });

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

it('keeps an in-flight attachment deduplicated after a handshake timeout', async () => {
  vi.useFakeTimers(); db = openDb(':memory:'); db.insertRun(run());
  let finish!: (value: AttachmentHandshake) => void;
  const reattach = vi.fn(() => new Promise<AttachmentHandshake>(resolve => { finish = resolve; }));
  const first = recoverRuns(db, { reattach, handshakeTimeoutMs: 10 }); await vi.advanceTimersByTimeAsync(10); expect((await first).blocked).toEqual(['r1']);
  const second = recoverRuns(db, { reattach, handshakeTimeoutMs: 10 }); await vi.advanceTimersByTimeAsync(10); expect((await second).blocked).toEqual(['r1']);
  expect(reattach).toHaveBeenCalledOnce(); finish({ status: 'attached', completion: new Promise(() => {}) });
  expect((await recoverRuns(db, { reattach, handshakeTimeoutMs: 10 })).reattached).toEqual(['r1']); expect(reattach).toHaveBeenCalledOnce();
});

it('retries startup crash leases until expiry without reattaching live controls or new runs', async () => {
  vi.useFakeTimers(); db = openDb(':memory:'); db.insertRun(run({ id: 'leased' })); db.insertRun(run({ id: 'attached' }));
  const started = Date.now();
  const reattach = vi.fn(async (row: RunRow): Promise<AttachmentHandshake> => row.id === 'leased' && Date.now() - started < 60_000
    ? { status: 'blocked', reason: 'Another coordinator owns this execution attempt' } : { status: 'attached', completion: new Promise(() => {}) });
  const onResult = vi.fn(); const recovery = startRunRecovery(db, { reattach, onResult });
  expect(await recovery.initial).toEqual({ reattached: ['attached'], blocked: ['leased'], failed: [] });
  db.insertRun(run({ id: 'new' }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(onResult.mock.calls.at(-1)?.[0]).toEqual({ reattached: ['leased'], blocked: [], failed: [] });
  expect(reattach.mock.calls.filter(([row]) => row.id === 'attached')).toHaveLength(1);
  expect(reattach.mock.calls.some(([row]) => row.id === 'new')).toBe(false);
  const count = reattach.mock.calls.length; await vi.advanceTimersByTimeAsync(120_000); expect(reattach).toHaveBeenCalledTimes(count); recovery.dispose();
});

it('bounds retries for unresolved startup work and stops scheduling on disposal', async () => {
  vi.useFakeTimers(); db = openDb(':memory:'); db.insertRun(run());
  const reattach = vi.fn(async (): Promise<AttachmentHandshake> => ({ status: 'blocked', reason: 'Artifact unavailable' }));
  const recovery = startRunRecovery(db, { reattach, retryIntervalMs: 250, retryWindowMs: 1000 }); await recovery.initial;
  await vi.advanceTimersByTimeAsync(10_000); expect(reattach).toHaveBeenCalledTimes(5); recovery.dispose();
  const stopped = startRunRecovery(db, { reattach, retryIntervalMs: 250, retryWindowMs: 1000 }); await stopped.initial; stopped.dispose();
  const count = reattach.mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(reattach).toHaveBeenCalledTimes(count);
});

it('does not overlap slow startup recovery or retry a superseded attempt', async () => {
  vi.useFakeTimers(); db = openDb(':memory:'); db.insertRun(run());
  let finish!: (value: AttachmentHandshake) => void;
  const reattach = vi.fn(() => new Promise<AttachmentHandshake>(resolve => { finish = resolve; }));
  const recovery = startRunRecovery(db, { reattach, handshakeTimeoutMs: 10, retryIntervalMs: 250, retryWindowMs: 1000 });
  await vi.advanceTimersByTimeAsync(10); await recovery.initial; await vi.advanceTimersByTimeAsync(500); expect(reattach).toHaveBeenCalledOnce();
  finish({ status: 'blocked', reason: 'Original attempt unavailable' }); db.updateRun('r1', { attempt: 2 });
  await vi.advanceTimersByTimeAsync(1000); expect(reattach).toHaveBeenCalledOnce(); recovery.dispose();
});
