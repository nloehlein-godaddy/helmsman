import { describe, expect, it, vi } from 'vitest';
import { createHostWhiteboardService } from './whiteboard-service';
import type { WhiteboardTargetV1 } from './whiteboard';
const target: WhiteboardTargetV1 = { kind: 'pull-request', repo: 'owner/repo', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const snapshot = { version: 1, target, status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null };
describe('Whiteboard host transport', () => {
  it('preserves explicit panel scope without changing header scope', async () => {
    const signal = new AbortController().signal;
    const scope = { repo: 'other/repo', epoch: 1, active: true, signal };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot));
    const service = createHostWhiteboardService(signal, { caller: 'helmsman.run-viewer/panel', scope: () => scope, fetch: fetcher });
    expect((await service.explain(target)).status).toBe('available');
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ target, scopeRepo: 'other/repo' });
    expect(scope.repo).toBe('other/repo');
  });
  it('rejects late responses after scope changes', async () => {
    const signal = new AbortController().signal;
    let scope = { repo: null as string | null, epoch: 1, active: true, signal };
    const fetcher = vi.fn(async () => { scope = { ...scope, epoch: 2 }; return Response.json(snapshot); });
    const service = createHostWhiteboardService(signal, { caller: 'helmsman.run-viewer/panel', scope: () => scope, fetch: fetcher });
    await expect(service.read(target)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('fails closed on mismatched comparison and oversized output', async () => {
    const signal = new AbortController().signal;
    const scope = () => ({ repo: null, epoch: 1, active: true, signal });
    const wrong = createHostWhiteboardService(signal, { caller: 'helmsman.run-viewer/panel', scope, fetch: async () => Response.json({ ...snapshot, target: { ...target, headSha: 'c'.repeat(40) } }) });
    expect(await wrong.read(target)).toMatchObject({ status: 'unavailable', code: 502 });
    const huge = createHostWhiteboardService(signal, { caller: 'helmsman.run-viewer/panel', scope, fetch: async () => new Response(' '.repeat(40_000)) });
    expect((await huge.read(target)).status).toBe('unavailable');
  });
});
