import { describe, expect, it, vi } from 'vitest';
import { createTaskViewsReadService } from './task-views-read-service';
import { handleTaskViewsReadApi } from './task-views-read-routes';
import { TaskSourceViewUnavailableError } from './task-source-views';
import type { TaskSourceService } from './task-source-service';
const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/repo'; const asOf = '2026-09-20T12:00:00.000Z';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo };
const page = { version: 1, repo, group: 'mine-open', items: [], nextCursor: null, quality: 'partial' };
const count = { value: null, quality: 'unavailable' };
const report = { version: 1, repo, asOf, open: count, createdLast7d: count, completedLast7d: count, pastSla: count,
  rows: [], rowsQuality: 'unavailable', oldest: null, oldestQuality: 'unavailable', resolutionP75: { days: null, sampleSize: 0, population: count, quality: 'unavailable', capped: false } };
function fixture() {
  let revision = 2; let repos = [repo]; const instances = vi.fn(() => [{ id: 'tasks', sourceId, revision }]);
  const listTriage = vi.fn(async () => page); const readBugs = vi.fn(async () => report);
  const service = createTaskViewsReadService({ sources: { instances, listTriage, readBugs } as unknown as TaskSourceService, repos: () => repos, now: () => new Date(asOf) });
  const bugs = { method: 'GET', path: '/api/task-views-read/tasks/bugs', query: new URLSearchParams({ repo, revision: '2', sourceId }), service };
  const triage = { ...bugs, path: '/api/task-views-read/tasks/triage', query: new URLSearchParams({ repo, revision: '2', sourceId, group: 'mine-open', priorities: '1', updatedSince: '', until: asOf, cursor: '', limit: '10' }) };
  return { service, bugs, triage, instances, readBugs, listTriage, set revision(value: number) { revision = value; }, set repos(value: string[]) { repos = value; } };
}
describe('server task view services and routes', () => {
  it('enriches exact source refs and keeps related-run failures independent of groups', async () => {
    const f = fixture(); const item = { ref: { sourceId, externalId: '1' }, revision: '1', displayKey: 'TASK-1', title: 'Work', url: null, state: 'ready', priority: 1, updatedAt: asOf };
    f.listTriage.mockResolvedValue({ ...page, items: [item] } as typeof page);
    const relatedRun = vi.fn((): { repo: string; runId: string } | null => ({ repo, runId: 'run-1' }));
    const service = createTaskViewsReadService({ sources: { instances: f.instances, listTriage: f.listTriage } as unknown as TaskSourceService, repos: () => [repo], relatedRun });
    const query = { ...selection, group: 'mine-open' as const, priorities: [1], updatedSince: null, until: asOf, cursor: null, limit: 10 };
    expect(await service.triage(query, new AbortController().signal)).toMatchObject({ relatedRuns: [{ ref: item.ref, repo, runId: 'run-1' }], relatedRunsQuality: 'complete' });
    expect(relatedRun).toHaveBeenCalledWith(item.ref, repo);
    relatedRun.mockImplementationOnce(() => { throw new Error('Database unavailable'); });
    expect(await service.triage(query, new AbortController().signal)).toMatchObject({ page: { items: [item] }, relatedRuns: [], relatedRunsQuality: 'partial' });
    relatedRun.mockReturnValue(null); expect(await service.triage(query, new AbortController().signal)).toMatchObject({ relatedRuns: [], relatedRunsQuality: 'complete' });
  });
  it('uses server time and bounded bug rows while preserving triage query identity', async () => {
    const f = fixture(); expect(await handleTaskViewsReadApi(f.bugs)).toMatchObject({ status: 200, json: { selection, report } });
    expect(f.readBugs).toHaveBeenCalledWith({ ...selection, asOf, rowLimit: 100 }, expect.any(AbortSignal));
    expect(await handleTaskViewsReadApi(f.triage)).toMatchObject({ status: 200, json: { selection, page } });
    expect(f.listTriage).toHaveBeenCalledWith({ ...selection, group: 'mine-open', priorities: [1], updatedSince: null, until: asOf, cursor: null, limit: 10 }, expect.any(AbortSignal));
  });
  it('rejects removed galleons and source revisions changing during provider reads', async () => {
    const f = fixture(); f.repos = []; expect((await handleTaskViewsReadApi(f.triage))?.status).toBe(409); expect(f.listTriage).not.toHaveBeenCalled();
    f.repos = [repo]; f.readBugs.mockImplementationOnce(async () => { f.revision = 3; return report; }); expect((await handleTaskViewsReadApi(f.bugs))?.status).toBe(409);
  });
  it('preserves unsupported views and private provider failures independently', async () => {
    const f = fixture(); f.listTriage.mockRejectedValueOnce(new TaskSourceViewUnavailableError('private'));
    expect(await handleTaskViewsReadApi(f.triage)).toEqual({ status: 501, json: { error: 'Source view unavailable' } });
    f.readBugs.mockRejectedValueOnce(new Error('private credentials')); expect(await handleTaskViewsReadApi(f.bugs)).toEqual({ status: 503, json: { error: 'Task views unavailable' } });
  });
  it('rejects duplicate, unbounded and mismatched query data before invoking providers', async () => {
    const f = fixture();
    for (const [key, value] of [['limit', '101'], ['priorities', '1,1'], ['until', 'tomorrow'], ['group', 'unknown'], ['updatedSince', '2027-01-01T00:00:00.000Z']]) {
      const query = new URLSearchParams(f.triage.query); query.set(key!, value!); expect((await handleTaskViewsReadApi({ ...f.triage, query }))?.status).toBe(400);
    }
    const query = new URLSearchParams(f.bugs.query); query.append('repo', repo); expect((await handleTaskViewsReadApi({ ...f.bugs, query }))?.status).toBe(400);
    expect(f.listTriage).not.toHaveBeenCalled(); expect(f.readBugs).not.toHaveBeenCalled();
  });
  it('rejects malformed provider metrics and honors late cancellation', async () => {
    const f = fixture(); f.readBugs.mockResolvedValueOnce({ ...report, open: { value: 0 as unknown as null, quality: 'unavailable' } });
    expect((await handleTaskViewsReadApi(f.bugs))?.status).toBe(502);
    const controller = new AbortController(); f.readBugs.mockImplementationOnce(async () => { controller.abort(); return report; });
    await expect(f.service.bugs(selection, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
