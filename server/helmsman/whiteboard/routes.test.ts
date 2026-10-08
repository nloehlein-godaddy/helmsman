// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleWhiteboardApi } from './routes';
import type { WhiteboardServerService } from './service';
import type { WhiteboardSnapshotV1, WhiteboardTargetV1 } from '../../../src/plugins/whiteboard';

const target: WhiteboardTargetV1 = { kind: 'pull-request', repo: 'owner/two', number: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const snapshot: WhiteboardSnapshotV1 = { version: 1, target, status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null };
function fixture() {
  const service: WhiteboardServerService = { read: vi.fn(async () => snapshot), explain: vi.fn(async () => snapshot), open: vi.fn(async () => snapshot), dispose: vi.fn() };
  return { method: 'POST', path: '/api/whiteboard/explain', caller: 'helmsman.run-viewer/details', authorize: vi.fn(), repos: () => ['owner/one', 'owner/two'], body: { target, scopeRepo: 'owner/one' }, service };
}
describe('Whiteboard contribution scope', () => {
  it('permits explicit panel target without changing the configured header scope', async () => {
    const f = fixture(); expect(await handleWhiteboardApi(f)).toEqual({ status: 200, json: snapshot });
    expect(f.service.explain).toHaveBeenCalledWith(target); expect(f.body.scopeRepo).toBe('owner/one');
  });
  it('requires declared enabled contribution authorization', async () => {
    const f = fixture(); expect((await handleWhiteboardApi({ ...f, authorize: undefined }))?.status).toBe(403);
    expect(f.service.explain).not.toHaveBeenCalled();
  });
  it('rejects targets outside configured galleons and malformed target objects', async () => {
    const f = fixture();
    expect((await handleWhiteboardApi({ ...f, body: { target: { ...target, repo: 'elsewhere/project' }, scopeRepo: null } }))?.status).toBe(404);
    expect((await handleWhiteboardApi({ ...f, body: { target: { ...target, headSha: 'wrong' }, scopeRepo: null } }))?.status).toBe(400);
    expect(f.service.explain).not.toHaveBeenCalled();
  });
  it('rejects duplicate query parameters and extra request fields', async () => {
    const f = fixture();
    expect((await handleWhiteboardApi({ ...f, body: { ...f.body, document: {} } }))?.status).toBe(400);
    expect((await handleWhiteboardApi({ ...f, method: 'GET', path: '/api/whiteboard', query: new URLSearchParams([['target', JSON.stringify(target)], ['target', JSON.stringify(target)]]) }))?.status).toBe(400);
  });
});
