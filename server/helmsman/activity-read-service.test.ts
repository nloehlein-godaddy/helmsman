// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createActivityReadService } from './activity-read-service';
import { handleActivityReadApi } from './activity-read-routes';
import { TaskSourceViewUnavailableError, type TaskSourceService } from './task-source-service';
const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/repo';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo };
const history = { version: 1, repo, from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z', historyQuality: 'partial', throughputQuality: 'complete', events: [], days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${14 + index}`, completed: index })) };
function fixture() {
  let revision = 2; let repos = [repo];
  const instances = vi.fn(() => [{ id: 'tasks', sourceId, revision }]);
  const readHistory = vi.fn(async () => history);
  const sources = { instances, readHistory } as unknown as TaskSourceService;
  const service = createActivityReadService({ sources, repos: () => repos, now: () => new Date(history.until) });
  const request = { method: 'GET', path: '/api/activity-read/tasks', query: new URLSearchParams({ repo, revision: '2', sourceId }), service };
  return { service, request, instances, readHistory, set revision(value: number) { revision = value; }, set repos(value: string[]) { repos = value; } };
}
describe('activity host service and routes', () => {
  it('passes a bounded exact-repository server UTC window to source history', async () => {
    const f = fixture(); const result = await handleActivityReadApi(f.request); expect(result).toMatchObject({ status: 200, json: { selection, history } });
    expect(f.readHistory).toHaveBeenCalledWith({ ...selection, from: history.from, until: history.until, eventLimit: 50 }, expect.any(AbortSignal));
    expect(f.instances).toHaveBeenCalledWith(repo);
  });
  it('rejects removed repositories and stale revisions before reading and after awaiting a provider', async () => {
    const f = fixture(); f.repos = []; expect((await handleActivityReadApi(f.request))?.status).toBe(409); expect(f.readHistory).not.toHaveBeenCalled();
    f.repos = [repo]; f.readHistory.mockImplementationOnce(async () => { f.revision = 3; return history; }); expect((await handleActivityReadApi(f.request))?.status).toBe(409);
  });
  it('preserves unsupported source history and provider failures instead of synthesizing empty data', async () => {
    const f = fixture(); f.readHistory.mockRejectedValueOnce(new TaskSourceViewUnavailableError('private'));
    expect(await handleActivityReadApi(f.request)).toEqual({ status: 501, json: { error: 'Source history unavailable' } });
    f.readHistory.mockRejectedValueOnce(new Error('private provider detail')); expect(await handleActivityReadApi(f.request)).toEqual({ status: 503, json: { error: 'Activity reads unavailable' } });
  });
  it('rejects malformed private provider responses and invalid query parameters', async () => {
    const f = fixture(); f.readHistory.mockResolvedValueOnce({ ...history, throughputQuality: 'partial' }); expect((await handleActivityReadApi(f.request))?.status).toBe(502);
    for (const query of [new URLSearchParams({ repo, revision: '0', sourceId }), new URLSearchParams({ repo, revision: '2', sourceId, limit: '999' }), new URLSearchParams(`repo=${repo}&revision=2&sourceId=${sourceId}&repo=${repo}`)]) expect((await handleActivityReadApi({ ...f.request, query }))?.status).toBe(400);
  });
  it('honors request cancellation after a provider resolves', async () => {
    const f = fixture(); const controller = new AbortController(); f.readHistory.mockImplementation(async () => { controller.abort(); return history; });
    await expect(f.service.query(selection, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
