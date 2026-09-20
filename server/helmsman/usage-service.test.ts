// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsage, UsageQuery } from '../../src/plugins/usage';
import { openDb, type RunRow } from './db';
import { aggregateOutcomes } from './outcomes';
import { createUsageQueryService } from './usage-service';
import { openUsageStore, UsageConflictError, UsageValidationError } from './usage-store';

const query: UsageQuery = { version: 1, repo: 'org/a', from: '2026-09-01T00:00:00Z', to: '2026-09-04T00:00:00Z' };
const run = (id: string, patch: Partial<RunRow> = {}): RunRow => ({ id, ticketId: 'TASK-1', repo: 'org/a', adapter: 'codex',
  status: 'succeeded', attempt: 1, prNumber: null, startedAt: query.from, endedAt: '2026-09-01T00:01:00Z',
  costUsd: null, worktreePath: '/private/worktree', taskJson: '{"token":"must-not-leak"}', hostRef: '{"token":"must-not-leak"}', ...patch });
const usage = (runId: string, patch: Partial<ProviderUsage> = {}): ProviderUsage => ({ runId, attempt: 1, eventId: 'event_1',
  provider: 'codex', model: 'gpt-6-astra', inputTokens: 100, cachedInputTokens: 20, outputTokens: 30,
  totalTokens: 130, costUsd: null, ...patch });
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); });
function fixture() {
  const db = openDb(':memory:');
  const store = openUsageStore(':memory:');
  cleanup.push(() => db.close(), () => store.close());
  return { db, store, service: createUsageQueryService({ db, usage: store }) };
}

describe('versioned measured usage query', () => {
  it('preserves existing reported spend semantics while excluding pricing and private execution payloads', async () => {
    const { db, store, service } = fixture();
    const runs = [run('mixed', { costUsd: 50 }), run('zero'), run('legacy', { costUsd: 3 }), run('unknown')];
    const records = [usage('mixed', { costUsd: 2 }), usage('mixed', { eventId: 'event_2' }), usage('zero', { costUsd: 0 })];
    runs.forEach(row => db.insertRun(row));
    records.forEach(record => store.recordUsage(record));
    const result = await service.query(query);
    expect(result).toMatchObject({ version: 1, currency: 'USD', repo: 'org/a',
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z' },
      reported: { observedCostUsd: 5, knownCostUsd: 3, runsWithKnownCost: 2, runsWithoutUsage: 2,
        inputTokens: 300, cachedInputTokens: 60, outputTokens: 90, totalTokens: 390 } });
    const legacy = aggregateOutcomes({ runs, usage: records, from: query.from, to: query.to, repo: query.repo });
    for (const key of ['observedCostUsd', 'knownCostUsd', 'runsWithKnownCost', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const) {
      expect(result.reported[key]).toBe(legacy[key]);
    }
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|worktree|taskJson|hostRef|estimated/);
    expect(result.records).toHaveLength(3);
    expect(result.runs.find(run => run.runId === 'mixed')?.reportedCostUsd).toBe(2);
    expect(result.runs.find(run => run.runId === 'legacy')?.reportedCostUsd).toBe(3);
    expect(db.getRun('mixed')?.costUsd).toBe(50);
  });

  it('keeps zero reported cost distinct from unknown and scopes records by galleon and start window', async () => {
    const { db, store, service } = fixture();
    for (const row of [run('included'), run('other', { repo: 'org/b' }), run('later', { startedAt: query.to }),
      run('earlier', { startedAt: '2026-08-31T23:59:59Z' })]) {
      db.insertRun(row); store.recordUsage(usage(row.id, { costUsd: row.id === 'included' ? 0 : 100 }));
    }
    const scoped = await service.query({ ...query, repo: 'ORG/A' });
    expect(scoped.runs.map(run => run.runId)).toEqual(['included']);
    expect(scoped.records.map(record => record.runId)).toEqual(['included']);
    expect(scoped.reported.observedCostUsd).toBe(0);
    const all = await service.query({ ...query, repo: null });
    expect(all.runs.map(run => run.runId).sort()).toEqual(['included', 'other']);
    const none = await service.query({ ...query, repo: 'org/missing' });
    expect(none.runs).toEqual([]);
    expect(none.records).toEqual([]);
    expect(none.reported).toMatchObject({ observedCostUsd: null, knownCostUsd: null, totalTokens: null, runsWithoutUsage: 0 });
  });

  it('deduplicates matching adapter records and rejects conflicting identities', async () => {
    const sample = usage('one', { costUsd: 2 });
    const listUsage = vi.fn(() => [sample, sample]);
    const service = createUsageQueryService({ db: { runsInWindow: () => [run('one')] }, usage: { listUsage } });
    expect((await service.query(query)).reported.observedCostUsd).toBe(2);
    listUsage.mockReturnValue([sample, { ...sample, costUsd: 3 }]);
    await expect(service.query(query)).rejects.toThrow(UsageConflictError);
  });

  it.each([null, {}, { ...query, version: 2 }, { ...query, repo: '../escape' }, { ...query, repo: undefined },
    { ...query, from: '2026-02-31T00:00:00Z' }, { ...query, to: query.from },
    { ...query, from: '2020-01-01T00:00:00Z' }, { ...query, to: '2026-09-04' }, { ...query, extra: true },
  ])('rejects malformed queries before any database work: %j', async input => {
    const runsInWindow = vi.fn(() => []);
    const listUsage = vi.fn(() => []);
    const service = createUsageQueryService({ db: { runsInWindow }, usage: { listUsage } });
    await expect(service.query(input as UsageQuery)).rejects.toThrow(UsageValidationError);
    expect(runsInWindow).not.toHaveBeenCalled(); expect(listUsage).not.toHaveBeenCalled();
  });

  it('returns fresh query results without allowing a caller to rewrite durable usage', async () => {
    const { db, store, service } = fixture();
    db.insertRun(run('one')); store.recordUsage(usage('one', { costUsd: 2 }));
    const first = await service.query(query);
    first.records[0]!.costUsd = 99; first.reported.observedCostUsd = 99;
    expect((await service.query(query)).reported.observedCostUsd).toBe(2);
    expect(store.listUsage(['one'])[0]?.costUsd).toBe(2);
  });
});
