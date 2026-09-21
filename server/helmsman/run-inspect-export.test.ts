// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { openDb, type Db } from './db';
import { createRunInspectService, type RunInspectServerService } from './run-inspect-service';
import { handleRunInspectExport } from './run-inspect-export';

const repo = 'owner/project'; const at = '2026-09-20T12:00:00Z';
let db: Db; let server: Server; let service: RunInspectServerService; let base: string;
beforeEach(async () => {
  db = openDb(':memory:'); db.insertRun({ id: 'run-1', repo, ticketId: 'TASK-1', adapter: 'local', status: 'running', attempt: 1, prNumber: null, startedAt: at, endedAt: null, costUsd: null, worktreePath: null });
  service = createRunInspectService({ db, repos: () => [repo] });
  server = createServer((req, res) => { void handleRunInspectExport(req, res, new URL(req.url ?? '/', 'http://localhost'), service).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
const path = `/api/run-inspect/run-1/export?repo=${repo}&scopeRepo=${repo}&expectedAttempt=1`;
describe('public run inspection export transport', () => {
  it('streams safe metadata and complete Unicode including NUL to the captured watermark', async () => {
    const text = '🛟'.repeat(80000) + '\0done'; db.appendEvent('run-1', 'log', text, at);
    const original = service.openExport.bind(service);
    service = { ...service, openExport(input) { const snapshot = original(input); db.appendEvent('run-1', 'log', 'later', at); return snapshot; } };
    const response = await fetch(base + path); expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toBe('attachment; filename="helmsman-run-1.log"');
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-helmsman-run-inspect')!))).toMatchObject({ provenance: 'run-wide', throughSequence: 1, target: { repo, runId: 'run-1', expectedAttempt: 1 } });
    expect(await response.text()).toBe(`[${at}] log: ${text}\n`);
  });
  it('rejects stale attempts, foreign identities, unsupported methods and malformed bounds before bytes', async () => {
    expect((await fetch(base + path.replace('expectedAttempt=1', 'expectedAttempt=2'))).status).toBe(409);
    expect((await fetch(base + path.replace('expectedAttempt=1', 'expectedAttempt=0'))).status).toBe(400);
    expect((await fetch(base + path.replace('run-1', 'missing'))).status).toBe(404);
    expect((await fetch(base + path, { method: 'POST' })).status).toBe(405);
    expect((await fetch(base + '/unrelated')).status).toBe(404);
  });
  it('respects destination backpressure and cancels the producer on disconnect', async () => {
    let produced = 0; let completed = false; let aborted = false;
    const snapshot = service.openExport({ version: 1, target: { repo, runId: 'run-1', expectedAttempt: 1 }, scopeRepo: repo });
    const fake = { ...service, openExport: () => ({ metadata: snapshot.metadata, async *chunks(signal?: AbortSignal) {
      try { for (let index = 0; index < 10000; index++) { signal?.throwIfAborted(); produced++; yield new Uint8Array(65536); } completed = true; }
      finally { aborted = signal?.aborted ?? false; }
    } }) };
    let written = 0;
    const res = Object.assign(new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { written++; } }), { writeHead: vi.fn(), headersSent: true });
    const req = Object.assign(new EventEmitter(), { method: 'GET' });
    const pending = handleRunInspectExport(req as IncomingMessage, res as unknown as ServerResponse, new URL(base + path), fake);
    await vi.waitFor(() => expect(written).toBe(1)); expect(produced).toBeLessThanOrEqual(3);
    res.destroy(); await pending; expect(completed).toBe(false); expect(aborted).toBe(true);
  });
});
