import { describe, expect, it, vi } from 'vitest';
import { createPullRequestInspectService } from './pull-request-inspect-service';
import type { PullRequestInspectProvider } from './pull-request-inspect-service';
import { inspectDetail as detail, inspectDiff as diff, inspectQuery as query, inspectTarget as target } from '../../src/plugins/pull-request-inspect.test-fixture';

function fixture(timeoutMs = 30_000) {
  let repos = [query.repo]; const provider = { detail: vi.fn<PullRequestInspectProvider['detail']>(async () => detail), diff: vi.fn<PullRequestInspectProvider['diff']>(async () => diff) };
  const service = createPullRequestInspectService({ repos: () => repos, provider, timeoutMs });
  return { service, provider, set repos(value: string[]) { repos = value; } };
}
describe('PR inspection server authority and lifecycle', () => {
  it('requires configured galleon authority before provider access', async () => {
    const f = fixture(); await expect(f.service.detail({ ...query, repo: 'private/project' })).rejects.toMatchObject({ status: 403 }); expect(f.provider.detail).not.toHaveBeenCalled();
    expect(await f.service.diff({ version: 1, target })).toEqual(diff);
  });
  it('does not release mismatched or secret provider fields', async () => {
    const f = fixture(); f.provider.detail.mockResolvedValue({ ...detail, private: 'secret' } as typeof detail);
    expect(await f.service.detail(query)).toEqual(detail);
    f.provider.detail.mockResolvedValue({ ...detail, target: { ...target, repo: 'other/project' } }); await expect(f.service.detail(query)).rejects.toMatchObject({ reason: 'invalid-response' });
  });
  it('fences changed configured scope while a read is pending', async () => {
    const f = fixture(); let finish!: (value: typeof detail) => void; f.provider.detail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.detail(query); await vi.waitFor(() => expect(f.provider.detail).toHaveBeenCalled()); f.repos = [query.repo, 'other/project']; finish(detail);
    await expect(pending).rejects.toMatchObject({ reason: 'selection-changed' });
  });
  it('preserves provider head-change outcomes for callers to refresh', async () => {
    const f = fixture(); f.provider.detail.mockRejectedValue(Object.assign(new Error('head-changed'), { reason: 'head-changed' }));
    await expect(f.service.detail(query)).rejects.toMatchObject({ status: 409, reason: 'head-changed' });
  });
  it('shares identical concurrent reads without letting one cancelled caller abort another', async () => {
    const f = fixture(); let finish!: (value: typeof detail) => void; f.provider.detail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const caller = new AbortController(); const first = f.service.detail(query, caller.signal); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' }); const second = f.service.detail(query);
    await vi.waitFor(() => expect(f.provider.detail).toHaveBeenCalledOnce()); const signal = f.provider.detail.mock.calls[0]![1]; caller.abort(); await rejected; expect(signal.aborted).toBe(false);
    finish(detail); expect(await second).toEqual(detail);
  });
  it('last-interest cancellation aborts the provider and releases the entry even when it ignores cancellation', async () => {
    const f = fixture(); f.provider.detail.mockImplementation(() => new Promise(() => {})); const caller = new AbortController();
    const first = f.service.detail(query, caller.signal); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' }); await vi.waitFor(() => expect(f.provider.detail).toHaveBeenCalledOnce());
    const signal = f.provider.detail.mock.calls[0]![1]; caller.abort(); await rejected; expect(signal.aborted).toBe(true);
    f.provider.detail.mockResolvedValue(detail); expect(await f.service.detail(query)).toEqual(detail); expect(f.provider.detail).toHaveBeenCalledTimes(2);
  });
  it('provider timeout releases capacity and permits a new read despite an abandoned promise', async () => {
    const f = fixture(5); f.provider.detail.mockImplementation(() => new Promise(() => {}));
    await expect(f.service.detail(query)).rejects.toMatchObject({ reason: 'timeout' }); expect(f.provider.detail.mock.calls[0]?.[1].aborted).toBe(true);
    f.provider.detail.mockResolvedValue(detail); expect(await f.service.detail(query)).toEqual(detail); expect(f.provider.detail).toHaveBeenCalledTimes(2);
  });
});
