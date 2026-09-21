import { describe, expect, it, vi } from 'vitest';
import { parseTaskTriageQueryV1, parseTaskTriagePageV1, parseTaskTriageReadSnapshotV1, parseTaskBugCountV1, parseTaskBugsReportV1 } from './task-views';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/repo'; const asOf = '2026-09-20T12:00:00.000Z';
const query = parseTaskTriageQueryV1({ repo, group: 'mine-open', priorities: [0, 1, 2, 3, 4], updatedSince: null, until: asOf, cursor: null, limit: 10 });
const item = { ref: { sourceId, externalId: '1' }, revision: '1', displayKey: 'TASK-1', title: 'Work', url: 'https://task.example/1', state: 'ready', priority: 1, updatedAt: asOf };
const count = { value: null, quality: 'unavailable' };
const report = { version: 1, repo, asOf, open: count, createdLast7d: count, completedLast7d: count, pastSla: count,
  rows: [], rowsQuality: 'unavailable', oldest: null, oldestQuality: 'unavailable', resolutionP75: { days: null, sampleSize: 0, population: count, quality: 'unavailable', capped: false } };
describe('public task view contracts', () => {
  it('binds related runs to exact listed source refs and repository', () => {
    const selection = { version: 1 as const, repo, sourceId, instanceId: 'tasks', instanceRevision: 1 };
    const page = { version: 1, repo, group: 'mine-open', items: [item], nextCursor: null, quality: 'complete' };
    const related = { ref: item.ref, repo, runId: 'run-1' }; const snapshot = { selection, query, page, relatedRuns: [related], relatedRunsQuality: 'complete' };
    expect(parseTaskTriageReadSnapshotV1(snapshot, { ...selection, ...query }).relatedRuns).toEqual([related]);
    for (const changed of [{ repo: 'owner/other' }, { ref: { ...item.ref, externalId: 'other' } }, { runId: '../bad' }]) {
      expect(() => parseTaskTriageReadSnapshotV1({ ...snapshot, relatedRuns: [{ ...related, ...changed }] }, { ...selection, ...query })).toThrow();
    }
    expect(() => parseTaskTriageReadSnapshotV1({ ...snapshot, relatedRunsQuality: 'unavailable' }, { ...selection, ...query })).toThrow();
  });
  it('projects immutable allowlisted summaries and validates source identity, filters and timestamps', () => {
    const page = { version: 1, repo, group: 'mine-open', items: [{ ...item, providerData: { secret: true } }], nextCursor: null, quality: 'complete' };
    const value = parseTaskTriagePageV1(page, query, sourceId);
    expect(value.items[0]).not.toHaveProperty('providerData'); expect(Object.isFrozen(value.items[0]?.ref)).toBe(true);
    for (const changed of [{ ref: { sourceId: '22222222-2222-4222-8222-222222222222', externalId: '1' } }, { updatedAt: '2026-09-21T12:00:00.000Z' }, { url: 'javascript:alert(1)' }, { priority: 8 }]) {
      expect(() => parseTaskTriagePageV1({ ...page, items: [{ ...item, ...changed }] }, query, sourceId)).toThrow();
    }
    expect(() => parseTaskTriagePageV1(page, { ...query, priorities: [2] }, sourceId)).toThrow();
  });
  it('rejects accessor arrays, duplicate refs, unavailable nonempty pages and looping cursors', () => {
    const page = { version: 1, repo, group: 'mine-open', items: [item], nextCursor: null, quality: 'complete' };
    const getter = vi.fn(() => item); const items = [item]; Object.defineProperty(items, 0, { get: getter });
    expect(() => parseTaskTriagePageV1({ ...page, items }, query, sourceId)).toThrow(); expect(getter).not.toHaveBeenCalled();
    for (const changed of [{ items: [item, item] }, { quality: 'unavailable' }, { nextCursor: 'same' }]) {
      expect(() => parseTaskTriagePageV1({ ...page, ...changed }, { ...query, cursor: 'same' }, sourceId)).toThrow();
    }
  });
  it('keeps unknown count values null and explicit approximation distinct from exact zero', () => {
    expect(parseTaskBugCountV1({ value: 0, quality: 'exact' })).toEqual({ value: 0, quality: 'exact' });
    expect(parseTaskBugCountV1({ value: 35000, quality: 'approximate' })).toEqual({ value: 35000, quality: 'approximate' });
    for (const value of [{ value: 0, quality: 'unavailable' }, { value: null, quality: 'exact' }, { value: -1, quality: 'approximate' }]) expect(() => parseTaskBugCountV1(value)).toThrow();
    expect(parseTaskBugsReportV1(report, { repo, asOf, rowLimit: 10 }, sourceId).open.value).toBeNull();
  });
  it('rejects contradictory sample quality and invalid actual SLA dates', () => {
    for (const sample of [{ ...report.resolutionP75, sampleSize: 1 }, { ...report.resolutionP75, days: 0 }, { ...report.resolutionP75, capped: true, quality: 'complete' }]) {
      expect(() => parseTaskBugsReportV1({ ...report, resolutionP75: sample }, { repo, asOf, rowLimit: 10 }, sourceId)).toThrow();
    }
    const row = { ref: item.ref, displayKey: 'TASK-1', title: 'Bug', url: null, priority: null, severity: null, dueAt: '2026-02-30', createdAt: asOf };
    expect(() => parseTaskBugsReportV1({ ...report, rows: [row], rowsQuality: 'complete' }, { repo, asOf, rowLimit: 10 }, sourceId)).toThrow();
  });
});
