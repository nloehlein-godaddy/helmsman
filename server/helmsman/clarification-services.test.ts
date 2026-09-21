// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, persistedJson } from './persistence';
import { openDb } from './db';
import { openExecutionStore } from './execution-store';
import { openExecutionControls } from './execution-controls';
import { openClarificationStore } from './clarifications';
import { createClarificationChannel, type ClarificationChannel } from './clarification-protocol-store';
import { openClarificationReceiptStore } from './clarification-receipt-store';
import { createClarificationReadService } from './clarification-read-service';
import { createClarificationCommandService } from './clarification-command-service';
import { createSuggestedContactAdminService } from './suggested-contact-admin-service';
import { handleClarificationServiceApi } from './clarification-service-routes';
import { CLARIFICATION_READ_LIMITS, type ClarificationReadListQueryV1 } from '../../src/plugins/clarification-read';
import { parseClarificationCommandReceiptV1, type ClarificationCommandV1 } from '../../src/plugins/clarification-command';
import type { SuggestedContactAdminCommandV1 } from '../../src/plugins/suggested-contact-admin';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const caller = 'example.viewer/main'; const otherCaller = 'example.other/main'; const repo = 'org/galleon'; const foreignRepo = 'org/other';
const at = '2026-09-20T12:00:00.000Z';
const query: ClarificationReadListQueryV1 = { version: 1, repo, runId: null, states: [], limit: 25, cursor: null };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clarification-services-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let clock = at; let repos = [repo, foreignRepo];
  const authorize = vi.fn((value: string) => { if (value !== caller && value !== otherCaller) throw new Error('Unrecognized caller'); });
  const open = () => {
    const persistence = openPersistence(join(root, 'state.sqlite')); cleanups.push(() => persistence.close());
    const db = openDb(persistence.sql); const executions = openExecutionStore(persistence); const controls = openExecutionControls(persistence);
    const clarifications = openClarificationStore(persistence.sql, { getRun: db.getRun }, () => clock);
    const receipts = openClarificationReceiptStore(persistence);
    const options = { persistence, clarifications, executions, controls, repos: () => repos, authorize, now: () => clock };
    const reads = createClarificationReadService(options); const commands = createClarificationCommandService({ ...options, receipts });
    const contacts = createSuggestedContactAdminService({ ...options, receipts });
    function seed(runId = 'run-1', attempt = 1, galleon = repo) {
      const channel = createClarificationChannel(root, { runId, attempt });
      const task = { clarification: channel };
      const row = { id: runId, ticketId: 'task', repo: galleon, adapter: 'test', status: 'running' as const, attempt,
        prNumber: null, startedAt: clock, endedAt: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(task) };
      if (db.getRun(runId)) db.updateRun(runId, row); else db.insertRun(row);
      const artifact = { pluginId: 'example.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
      const execution = executions.prepare({ snapshot: { version: 1, runId, attempt, repo: galleon,
        logicalWork: { source: 'test', instance: 'test', taskId: runId }, task: persistedJson(task), workflowSnapshotId: null,
        artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
        bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId,
          artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] }, launchId: `${runId}-${attempt}`,
        maxConcurrency: 1000, paths: { worktree: root, log: join(root, `${runId}.log`), exit: join(root, `${runId}.exit`), spec: join(root, `${runId}.spec`) } });
      clarifications.protocol.bind(executions.snapshot(execution.snapshotId)!); return channel;
    }
    function question(channel: ClarificationChannel, id = 'question', changes: Record<string, unknown> = {}, bound = true) {
      return clarifications.ingestQuestion(channel.runId, { kind: 'question', id, prompt: 'Proceed?', required: true, ...changes }, bound ? channel : undefined);
    }
    function command(channel: ClarificationChannel, id = 'question', changes: Partial<ClarificationCommandV1> = {}): ClarificationCommandV1 {
      return { version: 1, requestId: randomUUID(), repo, runId: channel.runId, questionId: id, expectedAttempt: channel.attempt,
        expectedChannelId: channel.channelId, expectedQuestionRevision: clarifications.protocol.provenance(id)?.revision ?? 1, answer: 'Yes', ...changes };
    }
    return { persistence, db, executions, controls, clarifications, receipts, reads, commands, contacts, options, seed, question, command };
  };
  return { root, open, authorize, time(value: string) { clock = value; }, repos(value: string[]) { repos = value; } };
}
const load = (id = 'question') => ({ version: 1 as const, repo, runId: 'run-1', questionId: id });
const createContact = (changes: Partial<SuggestedContactAdminCommandV1> = {}): SuggestedContactAdminCommandV1 => ({ version: 1, scope: 'global', kind: 'create',
  requestId: randomUUID(), id: randomUUID(), name: ' Person ', address: ' slack:person ', enabled: false, ...changes } as SuggestedContactAdminCommandV1);

describe('bounded public clarification reads', () => {
  it('preserves unknown and prior required obligations without inventing answer authority', () => {
    const f = fixture(); const s = f.open(); const channel = s.seed();
    s.question(channel, 'known'); s.question(channel, 'legacy', {}, false);
    expect(s.reads.load(caller, load('known'), repo)).toMatchObject({ revision: 1, answerability: { available: true }, provenance: { attempt: 1, channelId: channel.channelId } });
    expect(s.reads.load(caller, load('legacy'), repo)).toMatchObject({ blocksPublication: true, provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { reason: 'provenance-unknown' } });
    s.db.updateRun('run-1', { attempt: 2 });
    expect(s.reads.load(caller, load('known'), repo)).toMatchObject({ currentAttempt: 2, blocksPublication: true, answerability: { reason: 'different-attempt' } });
    s.clarifications.cancelForChannel(channel);
    expect(s.reads.list(caller, query, repo).items.every(item => item.blocksPublication && !item.answerability.available)).toBe(true);
    expect(s.clarifications.hasRequiredUnanswered('run-1')).toBe(true);
    expect(JSON.stringify(s.reads.list(caller, query, repo))).not.toContain(f.root);
  });

  it('counts the full filtered scope and keeps keyset boundaries separate from totals', () => {
    const s = fixture().open(); const channel = s.seed();
    for (const id of ['a', 'b', 'c']) s.question(channel, id);
    const foreign = s.seed('foreign', 1, foreignRepo); s.question(foreign, 'foreign');
    const first = s.reads.list(caller, { ...query, limit: 1 }, repo);
    expect(first).toMatchObject({ total: 3, items: [{ id: 'c' }] });
    const second = s.reads.list(caller, { ...query, limit: 1, cursor: first.nextCursor }, repo);
    expect(second).toMatchObject({ total: 3, items: [{ id: 'b' }] });
    s.commands.submit(caller, s.command(channel, 'a'), repo);
    expect(s.reads.list(caller, { ...query, states: ['answered'] }, repo)).toMatchObject({ total: 1, items: [{ id: 'a', blocksPublication: false }] });
    expect(s.reads.list(caller, { ...query, repo: null }, repo).total).toBe(3);
    expect(() => s.reads.list(caller, { ...query, repo: foreignRepo }, repo)).toThrow('not-found');
    expect(() => s.reads.load(caller, { ...load('foreign'), runId: 'foreign', repo: foreignRepo }, repo)).toThrow('not-found');
    expect(() => s.reads.load(caller, load('missing'), repo)).toThrow('not-found');
  });

  it('binds cursors to caller, effective scope, permitted galleons, filters and service lifetime', () => {
    const f = fixture(); const s = f.open(); const channel = s.seed(); s.question(channel, 'a'); s.question(channel, 'b');
    const q = { ...query, limit: 1 }; const first = s.reads.list(caller, q, null);
    for (const [who, request, scope] of [[otherCaller, q, null], [caller, { ...q, states: ['pending'] }, null], [caller, q, repo]] as const) {
      expect(() => s.reads.list(who, { ...request, cursor: first.nextCursor }, scope)).toThrow('cursor-invalid');
    }
    expect(() => s.reads.list(caller, { ...q, cursor: `${first.nextCursor}x` }, null)).toThrow('cursor-invalid');
    expect(() => createClarificationReadService(s.options).list(caller, { ...q, cursor: first.nextCursor }, null)).toThrow('cursor-invalid');
    f.repos([repo]); expect(() => s.reads.list(caller, { ...q, cursor: first.nextCursor }, null)).toThrow('cursor-invalid');
  });

  it('fails answerability closed for missing retained snapshot evidence without hiding the question', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel);
    s.persistence.sql.prepare('DELETE FROM clarification_channels').run();
    expect(s.reads.load(caller, load(), repo)).toMatchObject({ answerability: { available: false, reason: 'channel-unavailable' }, blocksPublication: true });
    expect(s.commands.submit(caller, s.command(channel), repo)).toMatchObject({ status: 'rejected', reason: 'channel-unavailable' });
  });

  it('paginates maximum escaped text within the public response byte budget without truncation', () => {
    const f = fixture(); f.repos(Array.from({ length: 4 }, (_, index) => `org/galleon-${index}`));
    const s = f.open(); const prompt = 'x' + '\u0001'.repeat(2000); const answer = 'x' + '\u0001'.repeat(3999);
    for (let run = 0; run < 4; run++) {
      const galleon = `org/galleon-${run}`; const channel = s.seed(`run-${run}`, 1, galleon);
      for (let index = 0; index < 25; index++) {
        const id = `q-${run}-${index}`; s.question(channel, id, { prompt }); s.commands.submit(caller, s.command(channel, id, { repo: galleon, answer }), galleon);
      }
    }
    const first = s.reads.list(caller, { ...query, repo: null, limit: 100 }, null);
    expect(first.total).toBe(100); expect(first.items.length).toBeLessThan(100); expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(CLARIFICATION_READ_LIMITS.responseBytes);
    const second = s.reads.list(caller, { ...query, repo: null, limit: 100, cursor: first.nextCursor }, null);
    expect([...first.items, ...second.items]).toHaveLength(100);
    expect([...first.items, ...second.items].every(item => item.prompt === prompt && item.answer === answer)).toBe(true);
  });
});

describe('durable clarification answer admission', () => {
  it('replays exact receipts before eligibility after response loss, stop, expiry, attempt change and restart', () => {
    const f = fixture(); let s = f.open(); const channel = s.seed(); s.question(channel, 'question', { timeoutAt: '2026-09-21T00:00:00Z' });
    const command = s.command(channel, 'question', { answer: '  Yes  ' });
    const result = s.commands.submit(caller, command, repo);
    expect(result).toMatchObject({ status: 'succeeded', result: { questionId: 'question', revision: 2, answer: 'Yes', answeredAt: at } });
    s.controls.requestStop({ runId: 'run-1', attempt: 1 }); s.db.updateRun('run-1', { status: 'failed', attempt: 2 }); f.time('2026-09-22T00:00:00Z');
    s.persistence.close(); s = f.open();
    expect(s.commands.submit(caller, command, repo)).toEqual(result);
    expect(s.commands.receipt(caller, { repo, requestId: command.requestId }, repo)).toEqual(result);
    expect(s.commands.receipt(otherCaller, { repo, requestId: command.requestId }, repo)).toBeNull();
    expect(s.clarifications.protocol.provenance('question')?.revision).toBe(2);
    expect(() => s.commands.submit(caller, { ...command, answer: 'No' }, repo)).toThrow('content changed');
    expect(() => s.commands.receipt(caller, { repo: foreignRepo, requestId: command.requestId }, null)).toThrow('not-found');
  });

  it('serializes competing connections with one accepted answer and one durable stale rejection', async () => {
    const f = fixture(); const first = f.open(); const channel = first.seed(); first.question(channel); const second = f.open();
    const a = first.command(channel); const b = first.command(channel, 'question', { answer: 'No' });
    const module = (name: string) => JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href);
    const script = `
      import { openPersistence } from ${module('persistence')};
      import { openDb } from ${module('db')};
      import { openExecutionStore } from ${module('execution-store')};
      import { openExecutionControls } from ${module('execution-controls')};
      import { openClarificationStore } from ${module('clarifications')};
      import { openClarificationReceiptStore } from ${module('clarification-receipt-store')};
      import { createClarificationCommandService } from ${module('clarification-command-service')};
      const input = JSON.parse(process.argv[1]);
      const persistence = openPersistence(input.path); const db = openDb(persistence.sql);
      const executions = openExecutionStore(persistence); const controls = openExecutionControls(persistence);
      const clarifications = openClarificationStore(persistence.sql, { getRun: db.getRun });
      const receipts = openClarificationReceiptStore(persistence); const save = receipts.saveAnswer;
      receipts.saveAnswer = (...args) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); return save(...args); };
      const service = createClarificationCommandService({ persistence, clarifications, executions, controls, receipts,
        repos: () => [input.command.repo], authorize() {}, now: () => input.now });
      process.once('message', () => {
        try { process.send({ receipt: service.submit(input.caller, input.command, input.command.repo) }); }
        finally { persistence.close(); process.disconnect(); }
      });
      process.send({ ready: true });
    `;
    const children = [a, b].map((command, index) => {
      const child = spawn(process.execPath, ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname,
        '--input-type=module', '-e', script, JSON.stringify({ path: join(f.root, 'state.sqlite'), caller: index ? otherCaller : caller, command, now: at })],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      cleanups.push(() => { if (child.exitCode === null) child.kill(); });
      let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); });
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', value => { if (value && typeof value === 'object' && 'ready' in value) resolve(); });
        child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(stderr)); });
      });
      const result = new Promise<ReturnType<typeof parseClarificationCommandReceiptV1>>((resolve, reject) => {
        child.on('message', value => { if (value && typeof value === 'object' && 'receipt' in value) { try { resolve(parseClarificationCommandReceiptV1(value.receipt, command)); } catch (error) { reject(error); } } });
        child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(stderr)); });
      });
      return { child, ready, result };
    });
    await Promise.all(children.map(child => child.ready)); for (const item of children) item.child.send('start');
    const results = await Promise.all(children.map(child => child.result));
    expect(results.map(result => result.status).sort()).toEqual(['rejected', 'succeeded']);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: 'revision-changed' });
    expect(first.commands.submit(caller, a, repo)).toEqual(results[0]); expect(second.commands.submit(otherCaller, b, repo)).toEqual(results[1]);
    expect(first.clarifications.list()[0]).toMatchObject({ state: 'answered', answer: results.find(result => result.status === 'succeeded')?.result?.answer });
    expect(first.clarifications.protocol.provenance('question')?.revision).toBe(2);
  }, 15000);

  it('denies persisted stop intent while the worker projection still reports running', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel); s.controls.requestStop({ runId: 'run-1', attempt: 1 });
    expect(s.db.getRun('run-1')?.status).toBe('running');
    expect(s.commands.submit(caller, s.command(channel), repo)).toMatchObject({ status: 'rejected', reason: 'stop-requested' });
    expect(s.reads.load(caller, load(), repo)).toMatchObject({ answerability: { reason: 'stop-requested' } });
    expect(s.clarifications.protocol.provenance('question')?.revision).toBe(1);
  });

  it.each(['deadline', 'inactive', 'missing'] as const)('commits %s lifecycle rejection with its receipt and rolls both back on receipt failure', kind => {
    const f = fixture(); const s = f.open(); const channel = s.seed();
    s.question(channel, 'question', { timeoutAt: '2026-09-21T00:00:00Z' }); const command = s.command(channel);
    if (kind === 'deadline') f.time('2026-09-22T00:00:00Z');
    else if (kind === 'inactive') s.db.updateRun('run-1', { status: 'succeeded' });
    else s.persistence.sql.prepare('DELETE FROM runs WHERE id=?').run('run-1');
    const save = vi.spyOn(s.receipts, 'saveAnswer').mockImplementationOnce(() => { throw new Error('Receipt write failed'); });
    expect(() => s.commands.submit(caller, command, repo)).toThrow('Receipt write failed');
    expect(s.clarifications.list()[0]?.state).toBe('pending'); expect(s.clarifications.protocol.provenance('question')?.revision).toBe(1);
    expect(s.receipts.answer(caller, command.requestId)).toBeNull(); save.mockRestore();
    const result = s.commands.submit(caller, command, repo);
    expect(result).toMatchObject({ status: 'rejected', reason: kind === 'deadline' ? 'deadline-expired' : kind === 'inactive' ? 'run-inactive' : 'run-unavailable' });
    expect(s.clarifications.list()[0]?.state).toBe(kind === 'deadline' ? 'timed-out' : 'cancelled');
    expect(s.clarifications.protocol.provenance('question')?.revision).toBe(2); expect(s.commands.submit(caller, command, repo)).toEqual(result);
  });

  it('rolls answer/revision back when durable receipt storage fails', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel); const command = s.command(channel);
    vi.spyOn(s.receipts, 'saveAnswer').mockImplementationOnce(() => { throw new Error('Disk full'); });
    expect(() => s.commands.submit(caller, command, repo)).toThrow('Disk full');
    expect(s.clarifications.list()[0]).toMatchObject({ state: 'pending', answer: null, answeredAt: null });
    expect(s.clarifications.protocol.provenance('question')?.revision).toBe(1); expect(s.receipts.answer(caller, command.requestId)).toBeNull();
    expect(s.commands.submit(caller, command, repo).status).toBe('succeeded');
  });

  it('rejects unknown provenance, foreign identity and changed channels without changing obligations', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel, 'legacy', {}, false); s.question(channel);
    expect(s.commands.submit(caller, s.command(channel, 'legacy'), repo)).toMatchObject({ status: 'rejected', reason: 'provenance-unknown' });
    expect(s.commands.submit(caller, s.command(channel, 'question', { runId: 'missing' }), repo)).toMatchObject({ status: 'rejected', reason: 'not-found' });
    expect(s.commands.submit(caller, s.command(channel, 'question', { expectedChannelId: randomUUID() }), repo)).toMatchObject({ status: 'rejected', reason: 'channel-unavailable' });
    expect(s.clarifications.list().every(item => item.state === 'pending')).toBe(true);
  });
});

describe('global suggested contact administration', () => {
  it('retains reserved create identity and terminal receipts through restart and concurrent same-name creates', () => {
    const f = fixture(); let s = f.open(); const command = createContact(); const first = s.contacts.submit(caller, command);
    expect(first).toMatchObject({ status: 'succeeded', result: { id: command.id, name: 'Person', address: 'slack:person', enabled: false, revision: 1, createdAt: at } });
    s.persistence.close(); s = f.open(); expect(s.contacts.submit(caller, command)).toEqual(first);
    expect(s.contacts.list(caller, { version: 1, scope: 'global', limit: 25, cursor: null }).items).toHaveLength(1);
    const second = s.contacts.submit(otherCaller, createContact()); expect(second.status).toBe('succeeded'); expect(second.result?.id).not.toBe(command.id);
    expect(s.contacts.receipt(caller, { scope: 'global', requestId: command.requestId })).toEqual(first);
    expect(() => s.contacts.submit(caller, { ...command, name: 'Changed' })).toThrow('content changed');
    expect(s.contacts.submit(otherCaller, { ...command, requestId: randomUUID() })).toMatchObject({ status: 'rejected', reason: 'conflict' });
  });

  it('preserves creation time, rejects stale updates and rolls metadata/revision back with receipts', () => {
    const f = fixture(); const s = f.open(); const command = createContact(); s.contacts.submit(caller, command); f.time('2026-09-21T00:00:00Z');
    const update: SuggestedContactAdminCommandV1 = { ...command, kind: 'update', requestId: randomUUID(), expectedRevision: 1, name: 'Updated', enabled: true };
    vi.spyOn(s.receipts, 'saveContact').mockImplementationOnce(() => { throw new Error('Disk full'); });
    expect(() => s.contacts.submit(caller, update)).toThrow('Disk full');
    expect(s.contacts.load(caller, { version: 1, scope: 'global', id: command.id })).toMatchObject({ name: 'Person', revision: 1 });
    expect(s.contacts.submit(caller, update)).toMatchObject({ status: 'succeeded', result: { name: 'Updated', revision: 2, createdAt: at } });
    expect(s.contacts.submit(otherCaller, { ...update, requestId: randomUUID(), name: 'Stale' })).toMatchObject({ status: 'rejected', reason: 'revision-changed' });
  });

  it('supports legacy contact IDs, bounded global pagination and question operation during contact failure', () => {
    const s = fixture().open(); s.clarifications.saveContact({ id: 'Legacy_CONTACT', name: 'Legacy', address: 'phone:123', enabled: false });
    const value = s.contacts.load(caller, { version: 1, scope: 'global', id: 'Legacy_CONTACT' }); expect(value.revision).toBe(1);
    s.contacts.submit(caller, { version: 1, scope: 'global', kind: 'update', id: value.id, expectedRevision: 1, requestId: randomUUID(), name: value.name, address: value.address, enabled: true });
    s.contacts.submit(caller, createContact());
    const first = s.contacts.list(caller, { version: 1, scope: 'global', limit: 1, cursor: null });
    const next = s.contacts.list(caller, { version: 1, scope: 'global', limit: 1, cursor: first.nextCursor });
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id); expect(next.nextCursor).toBeNull();
    const channel = s.seed(); s.question(channel);
    vi.spyOn(s.receipts, 'saveContact').mockImplementation(() => { throw new Error('Contact store unavailable'); });
    expect(() => s.contacts.submit(caller, createContact())).toThrow('unavailable');
    expect(s.reads.load(caller, load(), repo).answerability.available).toBe(true);
    expect(s.commands.submit(caller, s.command(channel), repo).status).toBe('succeeded');
  });
});

describe('public clarification routes and persistence integrity', () => {
  it('validates transport scope/caller/methods and exposes sanitized errors', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel);
    const route = (path: string, query = '', method = 'GET', body?: unknown, who: string | undefined = caller) => handleClarificationServiceApi({ path, query: new URLSearchParams(query), method, body, caller: who, reads: s.reads, commands: s.commands, contacts: s.contacts });
    expect(route('/unrelated')).toBeNull();
    expect(route('/api/clarification-read', `repo=${repo}&scopeRepo=${repo}`)).toMatchObject({ status: 200, json: { total: 1 } });
    expect(route('/api/clarification-read/question', `repo=${repo}&runId=run-1&scopeRepo=${foreignRepo}`)).toMatchObject({ status: 404, json: { reason: 'not-found' } });
    expect(route('/api/clarification-read', 'states=broken')).toMatchObject({ status: 400 });
    expect(route('/api/clarification-read', 'limit=1&limit=2')).toMatchObject({ status: 400 });
    expect(route('/api/clarification-read', '', 'POST')).toMatchObject({ status: 405 });
    expect(route('/api/clarification-command', '', 'POST', { command: s.command(channel), scopeRepo: repo })).toMatchObject({ status: 200, json: { status: 'succeeded' } });
    expect(route('/api/suggested-contact-admin', '')).toMatchObject({ status: 400 });
    expect(route('/api/suggested-contact-admin/commands', '', 'POST', createContact())).toMatchObject({ status: 200, json: { status: 'succeeded' } });
    expect(route('/api/suggested-contact-admin', 'scope=global')).toMatchObject({ status: 200, json: { scope: 'global' } });
    expect(route('/api/clarification-read', '', 'GET', undefined, '')).toMatchObject({ status: 403 });
    vi.spyOn(s.reads, 'list').mockImplementation(() => { throw new Error('/private/credential'); });
    expect(route('/api/clarification-read')).toEqual({ status: 503, json: { reason: 'service-unavailable' } });
  });

  it('preserves published schema checksums and rejects tampered receipts', () => {
    const s = fixture().open(); const channel = s.seed(); s.question(channel);
    const schemas = s.persistence.sql.prepare("SELECT owner,checksum FROM migration_ledger WHERE owner IN ('compat.clarifications','core.clarification-protocol') ORDER BY owner").all();
    openClarificationReceiptStore(s.persistence);
    expect(s.persistence.sql.prepare("SELECT owner,checksum FROM migration_ledger WHERE owner IN ('compat.clarifications','core.clarification-protocol') ORDER BY owner").all()).toEqual(schemas);
    const command = s.command(channel); s.commands.submit(caller, command, repo);
    s.persistence.sql.prepare("UPDATE public_clarification_receipts SET hash='tampered'").run();
    expect(() => s.commands.receipt(caller, { repo, requestId: command.requestId }, repo)).toThrow('integrity');
  });
});
