import { describe, expect, it, vi } from 'vitest';
import { handleTaskSourceApi } from './task-source-routes';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceSchedule } from './task-source-schedule';
import { PersistenceConflictError } from './persistence';
const instanceId = '00000000-0000-4000-8000-000000000001';
const ref = { sourceId: '00000000-0000-4000-8000-000000000002', externalId: '10001' };
function setup() {
  const list = vi.fn(async () => ({ items: [], nextCursor: null }));
  const assertLaunch = vi.fn();
  const load = vi.fn(async () => ({ ref })); const launch = vi.fn(() => 'run');
  const configure = vi.fn((input: { instanceId: string; instanceRevision: number; desiredEnabled?: boolean }) => ({ id: input.instanceId, revision: input.instanceRevision + 1, desiredEnabled: input.desiredEnabled ?? true }));
  const validate = vi.fn(async () => ({ validationId: 'validation', sourceId: ref.sourceId, instanceId, evidenceHash: 'a'.repeat(64) }));
  const commit = vi.fn(() => ({ sourceId: ref.sourceId, currentInstanceId: instanceId, revision: 2 }));
  const service = { instances: vi.fn(() => []), list, load, assertLaunch, lookup: vi.fn(async () => ref), command: vi.fn(async () => null), configure,
    adoption: { candidates: vi.fn(() => ({ sourceId: ref.sourceId, sourceRevision: 1, currentInstanceId: instanceId, candidates: [] })), validate, commit } } as unknown as TaskSourceService;
  service.refresh = { candidates: vi.fn(() => ({ mode: 'refresh' as const, sourceId: ref.sourceId, sourceRevision: 1, currentInstanceId: instanceId, candidates: [] })), validate, commit };
  const schedule = { selections: vi.fn(() => ({ revision: 0, instanceIds: [] })), select: vi.fn(() => ({ revision: 1, instanceIds: [instanceId] })) } as unknown as TaskSourceSchedule;
  const invoke = (path: string, method = 'GET', body: unknown = null, query = new URLSearchParams({ repo: 'owner/project', revision: '1' }), signal?: AbortSignal) => handleTaskSourceApi({ path, method, body, query, signal, service, schedule, launch });
  return { invoke, list, load, assertLaunch, launch, service, configure, validate, commit, schedule };
}
describe('task source HTTP routes', () => {
  it('preserves scope and revisions and passes canonical work references to launch', async () => {
    const f = setup(); await f.invoke(`/api/task-sources/${instanceId}/tasks`);
    expect(f.list).toHaveBeenCalledWith({ instanceId, instanceRevision: 1, repo: 'owner/project', state: null, cursor: null, limit: 50 }, expect.any(AbortSignal));
    expect(await f.invoke(`/api/task-sources/${instanceId}/launch`, 'POST', { instanceRevision: 1, repo: 'owner/project', ref })).toMatchObject({ status: 202, json: { runId: 'run' } });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.assertLaunch).toHaveBeenCalledWith({ instanceId, instanceRevision: 1, repo: 'owner/project', ref });
    expect(f.launch).toHaveBeenCalledWith({ repo: 'owner/project', mode: 'source', workRef: ref, sourceInstanceId: instanceId, sourceInstanceRevision: 1 });
  });
  it('rejects malformed/null/accessor bodies, invalid source refs and missing revisions before mutation', async () => {
    const f = setup(); const path = `/api/task-sources/${instanceId}/launch`;
    for (const body of [null, [], { instanceRevision: 0 }, { instanceRevision: 1, repo: '../x', ref }, { instanceRevision: 1, repo: 'owner/project', ref: null }]) expect((await f.invoke(path, 'POST', body))?.status).toBe(400);
    let reads = 0; const malicious = { get instanceRevision() { reads++; return 1; } }; expect((await f.invoke(path, 'POST', malicious))?.status).toBe(400); expect(reads).toBe(0); expect(f.launch).not.toHaveBeenCalled();
  });
  it('maps source conflicts to409, unavailable providers to503, and unknown or unsupported routes correctly', async () => {
    const f = setup(); f.assertLaunch.mockImplementationOnce(() => { throw new PersistenceConflictError('disabled'); });
    expect((await f.invoke(`/api/task-sources/${instanceId}/launch`, 'POST', { instanceRevision: 1, repo: 'owner/project', ref }))?.status).toBe(409);
    f.list.mockRejectedValueOnce(new Error('secret provider diagnostic')); expect(await f.invoke(`/api/task-sources/${instanceId}/tasks`)).toMatchObject({ status: 503, json: { error: expect.not.stringContaining('secret') } });
    expect((await f.invoke('/api/task-sources', 'POST', {}))?.status).toBe(405); expect((await f.invoke('/api/task-sources/schedule', 'DELETE'))?.status).toBe(405);
    expect((await f.invoke('/api/task-sources/missing'))?.status).toBe(404); expect(await f.invoke('/api/unrelated')).toBeNull();
    expect((await handleTaskSourceApi({ path: '/api/task-sources', method: 'GET', query: new URLSearchParams(), body: null, launch: f.launch }))?.status).toBe(503);
  });
  it('does not launch when cancellation arrives before reservation', async () => {
    const f = setup(); const controller = new AbortController(); f.assertLaunch.mockImplementationOnce(() => { controller.abort(); });
    expect((await f.invoke(`/api/task-sources/${instanceId}/launch`, 'POST', { instanceRevision: 1, repo: 'owner/project', ref }, undefined, controller.signal))?.status).toBe(503); expect(f.launch).not.toHaveBeenCalled();
  });
  it('validates adoption request bodies and delegates registered validation/commit only', async () => {
    const f = setup(); expect((await f.invoke('/api/task-sources/adoption', 'GET', null, new URLSearchParams({ sourceId: ref.sourceId })))?.status).toBe(200);
    const body = { sourceId: ref.sourceId, sourceRevision: 1, providerId: 'example.tasks/local', artifactHash: 'a'.repeat(64), repo: 'owner/project', actor: 'operator', reason: 'replace' };
    expect((await f.invoke('/api/task-sources/adoption/validate', 'POST', body))?.status).toBe(200); expect(f.validate).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect((await f.invoke('/api/task-sources/adoption/validate', 'POST', { ...body, compatible: true }))?.status).toBe(400);
    expect((await f.invoke('/api/task-sources/adoption/commit', 'POST', { validationId: 'validation' }))?.status).toBe(200); expect(f.commit).toHaveBeenCalledWith('validation');
    expect((await f.invoke('/api/task-sources/adoption/commit', 'POST', { validationId: 'validation', sourceId: ref.sourceId }))?.status).toBe(400);
  });
});

it('validates explicit artifact refresh routes and never accepts implicit identity promotion', async () => {
  const f = setup();
  expect((await f.invoke('/api/task-sources/refresh', 'GET', null, new URLSearchParams({ sourceId: ref.sourceId })))?.json).toMatchObject({ mode: 'refresh' });
  const body = { sourceId: ref.sourceId, sourceRevision: 1, providerId: 'helmsman.jira/issues', artifactHash: 'b'.repeat(64), repo: 'owner/project', actor: 'operator', reason: 'Upgrade provider' };
  expect((await f.invoke('/api/task-sources/refresh/validate', 'POST', body))?.status).toBe(200);
  expect(f.validate).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  expect((await f.invoke('/api/task-sources/refresh/validate', 'POST', { ...body, promoteAuthority: true }))?.status).toBe(400);
  expect((await f.invoke('/api/task-sources/refresh/commit', 'POST', { validationId: 'validation' }))?.status).toBe(200);
  expect((await f.invoke('/api/task-sources/refresh/commit', 'GET'))?.status).toBe(405);
});
