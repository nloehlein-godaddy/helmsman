import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostTaskContextService } from './task-context-service';
import type { TaskReadScopeV1 } from './task-read-service';

const sourceId = '11111111-1111-4111-8111-111111111111'; const repo = 'owner/project';
const query = { version: 1 as const, selection: { version: 1 as const, sourceId, instanceId: 'tasks', instanceRevision: 2, repo }, ref: { sourceId, externalId: '10001' }, taskRevision: 'r1', claim: 'active' as const };
const snapshot = { version: 1, task: { selection: query.selection, ref: query.ref, url: null }, claim: null, run: null, pullRequest: null };
afterEach(() => vi.restoreAllMocks());
describe('host task context adapter', () => {
  it('sends exact scoped canonical evidence and hides protocol errors', async () => {
    const lifetime = new AbortController(); const activity = new AbortController(); let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(snapshot)); const service = createHostTaskContextService(lifetime.signal, { scope: () => scope, fetch: fetcher });
    expect(await service.resolve(query)).toEqual({ status: 'available', value: snapshot }); const url = new URL(String(fetcher.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toBe('/api/task-context/tasks/10001'); expect(Object.fromEntries(url.searchParams)).toEqual({ repo, sourceId, revision: '2', taskRevision: 'r1', claim: 'active' });
    scope = { ...scope, repo: 'owner/other' }; expect(await service.resolve(query)).toEqual({ status: 'unavailable', reason: 'forbidden' });
  });
  it.each([[409, 'selection-changed'], [404, 'not-found'], [503, 'service-unavailable']])('maps %s without exposing server details', async (status, reason) => {
    const lifetime = new AbortController(); const activity = new AbortController(); const service = createHostTaskContextService(lifetime.signal, { scope: () => ({ repo, epoch: 1, active: true, signal: activity.signal }), fetch: async () => Response.json({ error: 'secret' }, { status: Number(status) }) });
    expect(await service.resolve(query)).toEqual({ status: 'unavailable', reason });
  });
  it('rejects a cross-galleon run or unsafe task URL before rendering', async () => {
    const lifetime = new AbortController(); const activity = new AbortController(); const unsafe = { ...snapshot, task: { ...snapshot.task, url: 'javascript:alert(1)' }, run: { repo: 'owner/other', runId: 'run-one', expectedAttempt: 1 }, claim: { id: 'claim-one', revision: 1, state: 'claimed' }, pullRequest: null };
    const service = createHostTaskContextService(lifetime.signal, { scope: () => ({ repo, epoch: 1, active: true, signal: activity.signal }), fetch: async () => Response.json(unsafe) });
    expect(await service.resolve(query)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
  it('cancels a read when activity changes', async () => {
    const lifetime = new AbortController(); const activity = new AbortController(); let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal }; let finish!: (value: Response) => void;
    const service = createHostTaskContextService(lifetime.signal, { scope: () => scope, fetch: () => new Promise(resolve => { finish = resolve; }) }); const pending = service.resolve(query);
    scope = { ...scope, epoch: 2 }; finish(Response.json(snapshot)); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
