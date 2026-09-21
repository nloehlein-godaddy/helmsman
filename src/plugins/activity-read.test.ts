import { describe, expect, it, vi } from 'vitest';
import { activityReadWindow, parseActivityReadSnapshotV1, parseTaskHistoryQueryV1, parseTaskHistoryV1 } from './activity-read';
import type { TaskHistoryV1 } from './activity-read';
const sourceId = '11111111-1111-4111-8111-111111111111';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo: 'owner/repo' };
const window = activityReadWindow(new Date('2026-09-20T12:00:00.000Z'));
const query = { ...window, repo: selection.repo, eventLimit: 50 };
const history: TaskHistoryV1 = { version: 1, ...window, repo: selection.repo, historyQuality: 'partial', throughputQuality: 'complete',
  days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${14 + index}`, completed: index })),
  events: [{ id: 'change-1', ref: { sourceId, externalId: '1' }, displayKey: 'TASK-2', title: 'Actual source event', url: 'https://tasks.example/browse/TASK-2', at: '2026-09-20T10:00:00.000Z', kind: 'status-changed', status: 'Done' }] };
describe('public task activity contract', () => {
  it('uses seven UTC calendar days and deep immutable source-qualified observations', () => {
    expect(window).toEqual({ from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z' });
    const result = parseActivityReadSnapshotV1({ selection, history }, selection); expect(result.history.events[0]?.ref.sourceId).toBe(sourceId);
    expect(Object.isFrozen(result.history.events[0]?.ref)).toBe(true); expect(Object.isFrozen(result.history.days[0])).toBe(true);
  });
  it('keeps unknown completion counts separate from zero and partial event coverage', () => {
    expect(parseTaskHistoryV1(history, query, sourceId).days[0]?.completed).toBe(0);
    expect(() => parseTaskHistoryV1({ ...history, throughputQuality: 'partial' }, query, sourceId)).toThrow();
    const unknown = { ...history, throughputQuality: 'partial', days: history.days.map(day => ({ ...day, completed: null })) };
    expect(parseTaskHistoryV1(unknown, query, sourceId).days.every(day => day.completed === null)).toBe(true);
    expect(() => parseTaskHistoryV1({ ...unknown, throughputQuality: 'complete' }, query, sourceId)).toThrow();
  });
  it.each([{ at: '2026-09-13T23:59:59.000Z' }, { at: '2026-09-20T12:00:01.000Z' }, { url: 'javascript:alert(1)' }, { ref: { sourceId: '22222222-2222-4222-8222-222222222222', externalId: '1' } }, { status: null }])('rejects malformed source observations %j', change => {
    expect(() => parseTaskHistoryV1({ ...history, events: [{ ...history.events[0], ...change }] }, query, sourceId)).toThrow();
  });
  it('rejects wrong scope, oversized bounds, sparse days and accessors', () => {
    expect(() => parseActivityReadSnapshotV1({ selection: { ...selection, instanceRevision: 3 }, history }, selection)).toThrow();
    expect(() => parseTaskHistoryQueryV1({ ...query, eventLimit: 51 })).toThrow();
    expect(() => parseTaskHistoryQueryV1({ ...query, from: '2026-09-13T00:00:00.000Z' })).toThrow();
    expect(() => parseTaskHistoryV1({ ...history, days: new Array(7) }, query, sourceId)).toThrow();
    const get = vi.fn(); expect(() => parseTaskHistoryV1({ ...history, get events() { return get(); } }, query, sourceId)).toThrow(); expect(get).not.toHaveBeenCalled();
  });
});
