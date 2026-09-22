import { describe, expect, it, vi } from 'vitest';
import { createTaskContextService, TaskContextError } from './task-context-service';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceStore } from './task-sources/store';
import type { Db } from './db';

const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/project';
const selection = { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo };
const ref = { sourceId, externalId: '10001' };
const query = { version: 1 as const, selection, ref, taskRevision: 'revision-one', claim: 'active' as const };
const task = { version: 1 as const, ref, repo, revision: query.taskRevision, displayKey: 'TASK-1', title: 'Shared title', state: 'in_progress' as const, priority: null, url: 'https://tasks.example/10001', requirements: { description: '', acceptanceCriteria: [], links: [] } };
function fixture() {
  let repos = [repo]; const load = vi.fn(async () => task); const instance = { id: selection.instanceId, sourceId, revision: selection.instanceRevision }; const activeClaim = vi.fn(() => ({ id: 'claim-one', ref, instance, sourceRevision: 3, revision: 4, state: 'claimed' as const, runId: 'run-one' })); const latestClaim = vi.fn(() => null);
  const getRun = vi.fn(() => ({ id: 'run-one', repo, attempt: 2, prNumber: 42 }));
  const service = createTaskContextService({ sources: { load } as unknown as TaskSourceService, store: { activeClaim, latestClaim, source: () => ({ revision: 3 }) } as unknown as TaskSourceStore, db: { getRun } as unknown as Db, repos: () => repos });
  return { service, load, activeClaim, latestClaim, getRun, set repos(value: string[]) { repos = value; } };
}

describe('canonical task context', () => {
  it('uses only the exact task claim, recorded run and recorded PR', async () => {
    const f = fixture(); const result = await f.service.resolve(query, new AbortController().signal);
    expect(result).toEqual({ version: 1, task: { selection, ref, url: task.url }, claim: { id: 'claim-one', revision: 4, state: 'claimed' },
      run: { repo, runId: 'run-one', expectedAttempt: 2 }, pullRequest: { repo, number: 42, sourceRunId: 'run-one' } });
    expect(f.load).toHaveBeenCalledWith({ ...selection, ref }, expect.any(AbortSignal)); expect(f.activeClaim).toHaveBeenCalledWith(ref);
  });
  it('does not infer a run or PR from titles, ticket keys, branches, or a wrong-repo run', async () => {
    const f = fixture(); f.getRun.mockReturnValue({ id: 'run-one', repo: 'owner/other', attempt: 2, prNumber: 42 });
    await expect(f.service.resolve(query, new AbortController().signal)).resolves.toMatchObject({ claim: { id: 'claim-one' }, run: null, pullRequest: null });
  });
  it('requires the active/settled choice and rejects stale source task evidence', async () => {
    const f = fixture(); f.load.mockResolvedValue({ ...task, revision: 'changed' });
    await expect(f.service.resolve(query, new AbortController().signal)).rejects.toBeInstanceOf(TaskContextError);
    f.load.mockResolvedValue(task); (f.activeClaim as ReturnType<typeof vi.fn>).mockReturnValue(null); (f.latestClaim as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'settled', ref, instance: { id: selection.instanceId, sourceId, revision: selection.instanceRevision }, sourceRevision: 3, revision: 7, state: 'settled', runId: 'old-run' }); (f.getRun as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'old-run', repo, attempt: 1, prNumber: null });
    await expect(f.service.resolve({ ...query, claim: 'settled' }, new AbortController().signal)).resolves.toMatchObject({ claim: { id: 'settled', state: 'settled' }, run: { runId: 'old-run' }, pullRequest: null });
    expect(f.activeClaim).toHaveBeenCalledTimes(0);
  });
  it('refuses a galleon no longer in scope before loading the provider', async () => {
    const f = fixture(); f.repos = [];
    await expect(f.service.resolve(query, new AbortController().signal)).rejects.toMatchObject({ status: 403 }); expect(f.load).not.toHaveBeenCalled();
  });
  it('does not attach a claim captured by a different source instance or revision', async () => {
    const f = fixture(); (f.activeClaim as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'old-claim', ref, instance: { id: 'old', sourceId, revision: 1 }, sourceRevision: 3, revision: 1, state: 'claimed', runId: 'run-one' });
    await expect(f.service.resolve(query, new AbortController().signal)).resolves.toMatchObject({ claim: null, run: null, pullRequest: null }); expect(f.getRun).not.toHaveBeenCalled();
  });
  it('does not publish associations after cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); f.load.mockImplementation(async () => { controller.abort(); return task; });
    await expect(f.service.resolve(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.activeClaim).not.toHaveBeenCalled();
  });
});
