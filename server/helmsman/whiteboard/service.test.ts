// @vitest-environment node
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWhiteboardService } from './service';
import type { WhiteboardClient, WhiteboardDocument } from './client';
import type { PullRequestInspectDetailV1, PullRequestInspectDiffV1 } from '../../../src/plugins/pull-request-inspect';
import type { WhiteboardTargetV1 } from '../../../src/plugins/whiteboard';
import type { RunRow } from '../db';

const baseSha = 'a'.repeat(40); const headSha = 'b'.repeat(40);
const target: WhiteboardTargetV1 = { kind: 'pull-request', repo: 'owner/project', number: 7, baseSha, headSha };
const document: WhiteboardDocument = { summary: 'Changes input handling.', requirements: [], design: 'Validates incoming data.', implementation: ['parser.ts validates input.'], diagram: { nodes: [{ id: 'parser', label: 'Input parser' }], edges: [] } };
const databases: Database.Database[] = [];
afterEach(() => { for (const sql of databases.splice(0)) sql.close(); });
function fixture() {
  const sql = new Database(':memory:'); databases.push(sql);
  const detail = vi.fn(async () => ({ target: { repo: target.repo, number: 7, baseSha, headSha }, title: 'Validate input' } as PullRequestInspectDetailV1));
  const diff = vi.fn(async () => ({ version: 1, target: { repo: target.repo, number: 7, baseSha, headSha }, files: [], quality: 'complete', truncated: false } as unknown as PullRequestInspectDiffV1));
  const client = { check: vi.fn<WhiteboardClient['check']>(async () => {}), create: vi.fn<WhiteboardClient['create']>(async () => 'a3dd14b8-f1a2-40ff-9770-5e3043ca44b9'), write: vi.fn<WhiteboardClient['write']>(async () => {}), open: vi.fn<WhiteboardClient['open']>(async () => {}) };
  const generate = vi.fn(async () => document);
  const getRun = vi.fn(() => null as RunRow | null);
  const options = { sql, getRun, repos: () => ['owner/project'], inspect: { detail, diff }, repositoryPath: () => '/checkout', client, generate };
  return { ...options, detail, diff, service: createWhiteboardService(options) };
}
describe('Whiteboard durable sessions', () => {
  it('creates once and keeps the exact comparison when repeatedly explained and opened', async () => {
    const f = fixture();
    expect((await f.service.read(target)).status).toBe('absent');
    const first = await f.service.explain(target);
    expect(first).toMatchObject({ status: 'ready', baseSha, headSha });
    expect(await f.service.explain(target)).toEqual(first);
    await f.service.open(target);
    expect(f.client.create).toHaveBeenCalledTimes(1);
    expect(f.client.create).toHaveBeenCalledWith({ title: 'Validate input', repositoryPath: '/checkout', baseSha, headSha }, expect.any(AbortSignal));
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('blocks stale run attempts before spending or starting a companion', async () => {
    const f = fixture(); f.getRun.mockReturnValue({ id: 'run-1', repo: target.repo, attempt: 2 } as RunRow);
    await expect(f.service.explain({ kind: 'run', repo: target.repo, runId: 'run-1', expectedAttempt: 1 })).rejects.toMatchObject({ reason: 'attempt-changed' });
    expect(f.client.check).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it('blocks a head that moved while the explanation was generated', async () => {
    const f = fixture();
    f.generate.mockImplementation(async () => { f.detail.mockResolvedValue({ target: { repo: target.repo, number: 7, baseSha, headSha: 'c'.repeat(40) }, title: 'Changed' } as PullRequestInspectDetailV1); return document; });
    expect((await f.service.explain(target)).status).toBe('failed');
    expect(f.client.create).not.toHaveBeenCalled();
  });
  it('never blindly retries creation whose response was lost', async () => {
    const f = fixture(); f.client.create.mockRejectedValue(new Error('lost response'));
    expect((await f.service.explain(target)).status).toBe('recovery-required');
    expect((await f.service.explain(target)).status).toBe('recovery-required');
    expect(f.client.create).toHaveBeenCalledTimes(1);
  });
  it('retains the session before a failed document write and retries the same document', async () => {
    const f = fixture(); f.client.write.mockRejectedValueOnce(new Error('write failed'));
    const failed = await f.service.explain(target);
    expect(failed).toMatchObject({ status: 'failed', sessionId: 'a3dd14b8-f1a2-40ff-9770-5e3043ca44b9' });
    expect((await f.service.explain(target)).status).toBe('ready');
    expect(f.client.create).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('checks the installed companion before model generation', async () => {
    const f = fixture(); f.client.check.mockRejectedValue(new Error('not installed'));
    await expect(f.service.explain(target)).rejects.toThrow('not installed');
    expect(f.generate).not.toHaveBeenCalled(); expect(f.client.create).not.toHaveBeenCalled();
  });
  it('does not lose a successful creation when cancellation prevents the document write', async () => {
    const f = fixture(); const controller = new AbortController();
    f.client.create.mockImplementation(async () => { controller.abort(); return 'a3dd14b8-f1a2-40ff-9770-5e3043ca44b9'; });
    f.client.write.mockImplementation(async (_id, _document, signal) => { signal?.throwIfAborted(); });
    expect(await f.service.explain(target, controller.signal)).toMatchObject({ status: 'failed', sessionId: 'a3dd14b8-f1a2-40ff-9770-5e3043ca44b9' });
    expect(f.client.create).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a malformed session creation response', async () => {
    const f = fixture(); f.client.create.mockResolvedValue('');
    expect((await f.service.explain(target)).status).toBe('recovery-required');
    expect(f.client.write).not.toHaveBeenCalled();
  });
  it('never reuses a failed run board against a changed PR base', async () => {
    const f = fixture(); const runTarget: WhiteboardTargetV1 = { kind: 'run', repo: target.repo, runId: 'run-1', expectedAttempt: 1 };
    f.getRun.mockReturnValue({ id: 'run-1', repo: target.repo, attempt: 1, prNumber: 7, taskJson: JSON.stringify({ prHeadSha: headSha }) } as RunRow);
    f.client.write.mockRejectedValueOnce(new Error('write failed'));
    expect((await f.service.explain(runTarget)).status).toBe('failed');
    const moved = { repo: target.repo, number: 7, baseSha: 'c'.repeat(40), headSha };
    f.detail.mockResolvedValue({ target: moved, title: 'Moved base' } as PullRequestInspectDetailV1);
    f.diff.mockResolvedValue({ version: 1, target: moved, files: [], quality: 'complete', truncated: false } as unknown as PullRequestInspectDiffV1);
    await expect(f.service.explain(runTarget)).rejects.toMatchObject({ reason: 'comparison-changed' });
    expect(await f.service.read(runTarget)).toMatchObject({ status: 'failed', baseSha, headSha });
    expect(f.client.create).toHaveBeenCalledTimes(1); expect(f.client.write).toHaveBeenCalledTimes(1);
  });
  it('recovers interrupted writes using the known board instead of creating another', async () => {
    const f = fixture(); await f.service.explain(target);
    f.sql.prepare("UPDATE whiteboard_sessions SET status='creating'").run();
    const recovered = createWhiteboardService(f);
    expect((await recovered.read(target)).status).toBe('failed');
    expect((await recovered.explain(target)).status).toBe('ready');
    expect(f.client.create).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('retries a saved document against its persisted evidence when preview budgets change', async () => {
    const f = fixture();
    const full = { version: 1 as const, target: { repo: target.repo, number: 7, baseSha, headSha }, files: [{ filename: 'parser.ts', previousFilename: null, status: 'modified', additions: 0, deletions: 0, patchStatus: 'preview' as const, patch: '@@ -1,2 +1,2 @@\n first\n second' }], quality: 'complete' as const, truncated: false } as unknown as PullRequestInspectDiffV1;
    f.diff.mockResolvedValue(full);
    const cited = { ...document, implementation: ['[parser.ts:2](review-source:head/parser.ts#L2) validates input.'] };
    f.generate.mockResolvedValue(cited); f.client.write.mockRejectedValueOnce(new Error('write interrupted'));
    expect((await f.service.explain(target)).status).toBe('failed');
    const saved = f.sql.prepare('SELECT evidence, document FROM whiteboard_sessions').get();
    f.diff.mockResolvedValue({ ...full, files: full.files.map(file => ({ ...file, patch: '@@ -1,1 +1,1 @@\n first', patchStatus: 'truncated' })) });
    expect((await f.service.explain(target)).status).toBe('ready');
    expect(f.sql.prepare('SELECT evidence, document FROM whiteboard_sessions').get()).toEqual(saved);
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.client.create).toHaveBeenCalledTimes(1);
    expect(f.client.write).toHaveBeenLastCalledWith('a3dd14b8-f1a2-40ff-9770-5e3043ca44b9', cited, expect.any(AbortSignal));
  });
});
