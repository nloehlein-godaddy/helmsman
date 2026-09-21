import type { SchedulingPageV1 } from '@helmsman/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { roundRobinSchedulingProvider } from './provider';

const source = (instanceId: string, sourceId = instanceId) => ({ instanceId, sourceId, label: instanceId });
const item = (candidateId: string, sourceId: string) => ({ candidateId, ref: { sourceId, externalId: candidateId }, revision: 'r1', displayKey: candidateId, title: candidateId, priority: null });
const input = (sources = [source('a'), source('b')], lastInstanceId: string | null = null) => ({ version: 1 as const, repo: 'org/repo', sources, lastInstanceId });

describe('round-robin scheduling provider', () => {
  it('rotates sorted sources after the last selected instance', async () => {
    const list = vi.fn(async ({ instanceId }: { instanceId: string }) => ({ items: [item(instanceId, instanceId)], nextCursor: null }));
    await expect(roundRobinSchedulingProvider.select(input([source('b'), source('a')], 'a'), { signal: new AbortController().signal, list })).resolves.toEqual({ candidateId: 'b' });
    expect(list.mock.calls.map(([value]) => value.instanceId)).toEqual(['b']);
  });

  it('accepts task-source revision bounds and preserved whitespace', async () => {
    const list = vi.fn(async () => ({ items: [{ ...item('candidate', 'a'), revision: 'r'.repeat(512), title: 'Multi\nline\ttitle', displayKey: 'T\t1' }], nextCursor: null }));
    await expect(roundRobinSchedulingProvider.select(input([source('a')]), { signal: new AbortController().signal, list })).resolves.toEqual({ candidateId: 'candidate' });
  });

  it('scans pages and skips unavailable sources', async () => {
    const list = vi.fn(async ({ instanceId, cursor }: { instanceId: string; cursor: string | null }) => {
      if (instanceId === 'a') throw new Error('unavailable');
      return cursor === null ? { items: [], nextCursor: 'next' } : { items: [item('b-1', 'b')], nextCursor: null };
    });
    await expect(roundRobinSchedulingProvider.select(input(), { signal: new AbortController().signal, list })).resolves.toEqual({ candidateId: 'b-1' });
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    const list = vi.fn(async () => { controller.abort(); return { items: [], nextCursor: null }; });
    await expect(roundRobinSchedulingProvider.select(input(), { signal: controller.signal, list })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns null when no candidate is available', async () => {
    const list = vi.fn(async () => ({ items: [null, item('wrong', 'other')], nextCursor: null } as unknown as SchedulingPageV1));
    await expect(roundRobinSchedulingProvider.select(input(), { signal: new AbortController().signal, list })).resolves.toBeNull();
  });
});
