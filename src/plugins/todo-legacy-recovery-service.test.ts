import { describe, expect, it, vi } from 'vitest';
import { createHostTodoLegacyRecoveryService } from './todo-legacy-recovery-service';
import type { TaskReadScopeV1 } from './task-read-service';
import type { LegacyTodoCommandReceipt } from './todo-legacy-recovery';

const key = 'helmsman.todos.pending-mutations.v1';
const requestId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const oldKey = JSON.stringify(['/api/todos/TODO-1', 'PUT', { repo: 'owner/destination', title: 'Saved draft' }]);
const receipt: LegacyTodoCommandReceipt = { version: 1, requestId, commandId: 'update', repo: 'owner/origin',
  status: 'succeeded', reason: null, message: null, result: { kind: 'changed', ref: { sourceId, externalId: 'TODO-1' }, repo: 'owner/destination', revision: 'r2' } };
function fixture(repo: string | null = null) {
  const lifetime = new AbortController(); const activity = new AbortController();
  let scope: TaskReadScopeV1 = { repo, epoch: 1, active: true, signal: activity.signal };
  const values = new Map<string, string>([[key, JSON.stringify([[oldKey, requestId]])]]);
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(receipt));
  const options = { scope: () => scope, storage, fetch: fetcher };
  return { service: createHostTodoLegacyRecoveryService(lifetime.signal, options), values, storage, fetcher, lifetime, activity,
    remount: () => createHostTodoLegacyRecoveryService(lifetime.signal, options), setScope: (value: Partial<TaskReadScopeV1>) => { scope = { ...scope, ...value }; } };
}

describe('legacy Todo recovery host port', () => {
  it('redacts drafts, preserves exact old identity, and only clears explicitly acknowledged terminal receipts', async () => {
    const f = fixture(); const before = f.values.get(key);
    expect(await f.service.pending()).toEqual({ status: 'available', value: [{ requestId, commandId: 'update', externalId: 'TODO-1' }] });
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'confirmation-required' });
    expect(await f.service.check(requestId)).toEqual({ status: 'available', value: receipt });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('/api/todo-legacy-recovery/receipt');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ requestId, path: '/api/todos/TODO-1', method: 'PUT', input: { repo: 'owner/destination', title: 'Saved draft' } });
    expect(f.values.get(key)).toBe(before);
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'available', value: undefined });
    expect(f.values.has(key)).toBe(false);
  });
  it('requires All scope for old moves and deletes while allowing an empty journal in any scope', async () => {
    const f = fixture('owner/destination');
    expect(await f.service.pending()).toEqual({ status: 'unavailable', reason: 'all-galleons-required' });
    expect(await f.service.check(requestId)).toEqual({ status: 'unavailable', reason: 'all-galleons-required' });
    f.values.set(key, JSON.stringify([[JSON.stringify(['/api/todos/TODO-1', 'DELETE', null]), requestId]]));
    expect(await f.service.pending()).toEqual({ status: 'unavailable', reason: 'all-galleons-required' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.values.clear(); expect(await f.service.pending()).toEqual({ status: 'available', value: [] });
  });
  it.each([
    ['unrecorded', 'not-recorded'], ['pending', 'mutation-unconfirmed'], ['blocked', 'original-authority-unavailable'], ['blocked', 'mutation-proof-mismatch'],
  ] as const)('preserves %s evidence and never permits acknowledgment', async (status, reason) => {
    const f = fixture(); const before = f.values.get(key);
    f.fetcher.mockImplementation(async () => Response.json({ ...receipt, status, reason, result: null }));
    expect(await f.service.check(requestId)).toMatchObject({ status: 'available', value: { status, reason } });
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'confirmation-required' });
    expect(f.values.get(key)).toBe(before);
  });
  it('accepts a definite rejection but requires another check after remount', async () => {
    const f = fixture(); f.fetcher.mockImplementation(async () => Response.json({ ...receipt, status: 'rejected', message: 'Task is claimed', result: null }));
    expect(await f.service.check(requestId)).toMatchObject({ status: 'available', value: { status: 'rejected' } });
    const remounted = f.remount();
    expect(await remounted.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'confirmation-required' });
    await remounted.check(requestId); await remounted.acknowledge(requestId); expect(f.values.has(key)).toBe(false);
  });
  it.each([
    '{bad', JSON.stringify([[oldKey, requestId], [oldKey, requestId]]),
    JSON.stringify([[oldKey, requestId], [JSON.stringify(['/api/todos/TODO-2', 'DELETE', null]), requestId]]),
    JSON.stringify([[JSON.stringify(['/api/other', 'POST', {}]), requestId]]),
  ])('retains corrupt or ambiguous storage byte for byte', async raw => {
    const f = fixture(); f.values.set(key, raw);
    expect(await f.service.pending()).toEqual({ status: 'unavailable', reason: 'invalid-storage' });
    expect(await f.service.check(requestId)).toEqual({ status: 'unavailable', reason: 'invalid-storage' });
    expect(f.values.get(key)).toBe(raw); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('keeps unrelated pending requests and rejects changed request identity', async () => {
    const f = fixture(); await f.service.check(requestId);
    const anotherId = '33333333-3333-4333-8333-333333333333';
    const anotherKey = JSON.stringify(['/api/todos/TODO-2', 'DELETE', null]);
    f.values.set(key, JSON.stringify([[oldKey, anotherId], [anotherKey, requestId]]));
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'confirmation-required' });
    f.values.set(key, JSON.stringify([[oldKey, requestId], [anotherKey, anotherId]]));
    await f.service.acknowledge(requestId);
    expect(JSON.parse(f.values.get(key)!)).toEqual([[anotherKey, anotherId]]);
  });
  it.each([
    { requestId: '33333333-3333-4333-8333-333333333333' }, { commandId: 'delete' }, { result: null },
    { result: { kind: 'changed', ref: { sourceId, externalId: 'TODO-9' }, repo: 'owner/destination', revision: 'r2' } },
    { result: { kind: 'changed', ref: { sourceId, externalId: 'TODO-1' }, repo: 'owner/wrong', revision: 'r2' } },
    { repo: null },
    { status: 'blocked', reason: ['original-authority-unavailable'], result: null },
    { status: 'pending', reason: 'mutation-unconfirmed' }, { status: 'rejected', result: null, message: null },
  ])('rejects malformed terminal evidence %j', async patch => {
    const f = fixture(); f.fetcher.mockImplementation(async () => Response.json({ ...receipt, ...patch }));
    expect(await f.service.check(requestId)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'confirmation-required' });
    expect(f.values.has(key)).toBe(true);
  });
  it('binds updates without a destination to the recorded origin', async () => {
    const f = fixture(); f.values.set(key, JSON.stringify([[JSON.stringify(['/api/todos/TODO-1', 'PUT', { title: 'Changed' }]), requestId]]));
    expect(await f.service.check(requestId)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    f.fetcher.mockImplementation(async () => Response.json({ ...receipt, result: { ...receipt.result, repo: receipt.repo } }));
    expect(await f.service.check(requestId)).toMatchObject({ status: 'available', value: { result: { repo: 'owner/origin' } } });
  });
  it('fences lost responses, scope changes, and fetchers that ignore cancellation', async () => {
    const f = fixture(); let deliver!: (response: Response) => void;
    f.fetcher.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const pending = f.service.check(requestId); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    f.activity.abort(); await rejected;
    deliver(Response.json(receipt)); await Promise.resolve();
    expect(f.values.has(key)).toBe(true); expect(f.storage.removeItem).not.toHaveBeenCalled();
    const changed = fixture(); changed.fetcher.mockImplementation(async () => { changed.setScope({ repo: 'owner/other', epoch: 2 }); return Response.json(receipt); });
    await expect(changed.service.check(requestId)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('reports unavailable storage without clearing a confirmed identity', async () => {
    const f = fixture(); await f.service.check(requestId);
    f.storage.removeItem.mockImplementation(() => { throw new Error('quota'); });
    expect(await f.service.acknowledge(requestId)).toEqual({ status: 'unavailable', reason: 'storage-unavailable' });
    expect(f.values.has(key)).toBe(true);
    f.storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(await f.service.pending()).toEqual({ status: 'unavailable', reason: 'storage-unavailable' });
  });
});
