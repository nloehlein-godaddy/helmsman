// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPersistence } from './persistence';
import { createRunInstructionService, type RunInstructionBinding } from './run-instruction-service';
import { openRunInstructionStore } from './run-instruction-store';
import { handleRunInstructionApi } from './run-instruction-routes';
import { InstructionError, InstructionDeliveryUnknownError, type InstructionRecord } from './instruction-channel';
import type { RunInstructionCommandV1 } from '../../src/plugins/run-instructions';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
const caller = 'example.viewer/panel';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'run-instruction-service-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const persistence = openPersistence(join(root, 'db.sqlite')); cleanups.push(() => persistence.close());
  const command: RunInstructionCommandV1 = { version: 1, repo: 'org/repo', runId: 'run-1', expectedAttempt: 1,
    expectedChannelId: randomUUID(), targetId: randomUUID(), text: 'Preserve the API contract 😀', requestId: randomUUID() };
  let binding: RunInstructionBinding = { repo: command.repo, attempt: 1, channelId: command.expectedChannelId, active: true, supported: true };
  const records: InstructionRecord[] = [];
  const send = vi.fn(async (_directory: string, raw: unknown) => {
    const input = raw as { id: string; targetId: string; text: string };
    const record: InstructionRecord = { ...input, provider: 'example.agent/main', protocol: 'codex-app-server', stage: 'implement', status: 'delivered', createdAt: new Date().toISOString() };
    records.push(record); return record;
  });
  const read = vi.fn(async () => ({ available: binding.active, targets: binding.active ? [{ id: command.targetId, provider: 'example.agent/main', protocol: 'codex-app-server' as const, stage: 'implement' }] : [], instructions: records }));
  const options = { persistence, runsDir: root, repos: () => ['org/repo', 'org/other'], authorize: (value: string) => { if (value !== caller && value !== 'example.other/panel') throw new Error('Forbidden'); }, resolve: () => binding, read, send };
  return { command, records, send, read, persistence, options, service: createRunInstructionService(options),
    change: (value: Partial<RunInstructionBinding>) => { binding = { ...binding, ...value }; } };
}
describe('durable live instructions', () => {
  it('delivers once across retries and service restart, fences caller receipts, and rejects changed intent', async () => {
    const f = fixture();
    expect((await f.service.submit(caller, f.command, null)).status).toBe('delivered');
    const restarted = createRunInstructionService(f.options);
    expect((await restarted.submit(caller, f.command, null)).status).toBe('delivered'); expect(f.send).toHaveBeenCalledTimes(1);
    expect(await restarted.receipt('example.other/panel', { repo: f.command.repo, requestId: f.command.requestId }, null)).toBeNull();
    await expect(restarted.submit(caller, { ...f.command, text: 'Changed instruction' }, null)).rejects.toThrow('content changed');
  });
  it('retains unknown delivery after a crash without resending and accepts a late acknowledgment', async () => {
    const f = fixture(); const { requestId, ...input } = f.command; const deliveryId = randomUUID();
    const store = openRunInstructionStore(f.persistence);
    f.persistence.transaction(() => store.save(caller, deliveryId, { version: 1, requestId, input, status: 'sending', message: null }));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('unknown'); expect(f.send).not.toHaveBeenCalled();
    f.change({ active: false });
    f.records.push({ id: deliveryId, targetId: input.targetId, text: input.text, provider: 'example.agent/main', protocol: 'codex-app-server', stage: 'implement', status: 'delivered', createdAt: new Date().toISOString() });
    expect((await f.service.receipt(caller, { repo: input.repo, requestId }, null))?.status).toBe('delivered');
  });
  it.each([{ attempt: 2 }, { channelId: randomUUID() }, { active: false }, { supported: false }])('rejects stale execution %j before delivery', async change => {
    const f = fixture(); f.change(change);
    expect((await f.service.submit(caller, f.command, null)).status).toBe('rejected'); expect(f.send).not.toHaveBeenCalled();
  });
  it('distinguishes a definite endpoint rejection from a lost response', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new InstructionError('Stage finished'));
    expect((await f.service.submit(caller, f.command, null)).status).toBe('rejected');
    f.send.mockRejectedValueOnce(new InstructionDeliveryUnknownError('Disconnected'));
    expect((await f.service.submit(caller, { ...f.command, requestId: randomUUID() }, null)).status).toBe('unknown');
  });
  it('does not leak protocol internals, paths, or receipts through the public target snapshot', async () => {
    const f = fixture(); const { version, repo, runId, expectedAttempt } = f.command;
    const snapshot = await f.service.read(caller, { version, repo, runId, expectedAttempt }, null);
    expect(snapshot.targets).toEqual([{ id: f.command.targetId, provider: 'example.agent/main', stage: 'implement' }]);
    f.change({ attempt: 2 }); expect((await f.service.read(caller, { version, repo, runId, expectedAttempt }, null)).available).toBe(false);
  });
  it('does not dispatch twice when the first transport response is still pending', async () => {
    const f = fixture(); let release!: () => void;
    f.send.mockImplementationOnce(async (_dir, input) => { await new Promise<void>(done => { release = done; }); return { ...(input as InstructionRecord), provider: 'p', protocol: 'codex-app-server', stage: 's', status: 'sending', createdAt: new Date().toISOString() }; });
    const first = f.service.submit(caller, f.command, null);
    expect((await f.service.submit(caller, f.command, null)).status).toBe('sending'); expect(f.send).toHaveBeenCalledTimes(1);
    release(); expect((await first).status).toBe('unknown');
  });
  it('requires the contribution header, exact command shape, and matching scope at the route boundary', async () => {
    const f = fixture(); const base = { method: 'POST', path: '/api/run-instructions', query: new URLSearchParams(), service: f.service, body: { command: f.command, scopeRepo: null } };
    expect((await handleRunInstructionApi(base))?.status).toBe(403);
    expect((await handleRunInstructionApi({ ...base, caller, body: { command: { ...f.command, directory: '/tmp/other' }, scopeRepo: null } }))?.status).toBe(400);
    expect((await handleRunInstructionApi({ ...base, caller, body: { command: f.command, scopeRepo: 'org/other' } }))?.status).toBe(404);
    expect(f.send).not.toHaveBeenCalled();
  });
});
