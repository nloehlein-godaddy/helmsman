import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, persistedJson } from './persistence';
import { openExecutionStore, type ExecutionSnapshot } from './execution-store';
import { openClarificationStore } from './clarifications';
import { createClarificationChannel, parseClarificationChannel, type ClarificationChannel } from './clarification-protocol-store';
import { clarificationPaths, createClarificationRuntime } from './clarification-runtime';
import { handleApi, type RouterDeps } from './router';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'clarification-protocol-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  let persistence = openPersistence(path); cleanups.push(() => persistence.close());
  const executions = openExecutionStore(persistence);
  if (legacy) persistence.sql.exec(`
    CREATE TABLE clarifications (id TEXT PRIMARY KEY, runId TEXT NOT NULL, repo TEXT NOT NULL, question TEXT NOT NULL,
      required INTEGER NOT NULL, owner TEXT NOT NULL, contactId TEXT, state TEXT NOT NULL, answer TEXT,
      createdAt TEXT NOT NULL, timeoutAt TEXT, answeredAt TEXT);
    CREATE TABLE trusted_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, enabled INTEGER NOT NULL, createdAt TEXT NOT NULL);
    INSERT INTO clarifications VALUES ('old','run-1','org/galleon','Old question',1,'local',NULL,'pending',NULL,'2026-01-01T00:00:00Z',NULL,NULL);
    INSERT INTO trusted_contacts VALUES ('person','Person','person@example.test',1,'2026-01-01T00:00:00Z');
  `);
  const run = { repo: 'org/galleon', status: 'running', attempt: 1 };
  let store = openClarificationStore(persistence.sql, { getRun: id => id === 'run-1' ? run : null });
  function channel(attempt = run.attempt) { return createClarificationChannel(root, { runId: 'run-1', attempt, gateUrl: 'http://127.0.0.1:8080/api/runs/run-1/clarification-gate' }); }
  function bind(value: ClarificationChannel | null, attempt = value?.attempt ?? 1): ExecutionSnapshot {
    const prepared = executions.prepare({ snapshot: { version: 1, runId: 'run-1', attempt, repo: run.repo,
      logicalWork: { source: 'test', instance: 'test', taskId: 'test' }, task: persistedJson({ clarification: value ?? clarificationPaths(root, 'run-1') }),
      workflowSnapshotId: null, artifacts: [{ pluginId: 'example.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] }],
      bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: 'example.runtime',
        artifactHash: 'a'.repeat(64), connectionId: null, credentialHandle: null }], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null } },
      launchId: `launch-${attempt}`, maxConcurrency: 1, paths: { worktree: root, log: join(root, `${attempt}.log`), exit: join(root, `${attempt}.exit`), spec: join(root, `${attempt}.spec`) } });
    const snapshot = executions.snapshot(prepared.snapshotId)!; store.protocol.bind(snapshot); return snapshot;
  }
  function runtime() { return createClarificationRuntime(store, root, { resolve: (id, expectedAttempt) => {
    if (id !== 'run-1' || expectedAttempt !== undefined && expectedAttempt !== run.attempt) throw new Error('Attempt changed');
    return { attempt: run.attempt, channel: store.protocol.channel(id, run.attempt) };
  } }); }
  return { root, run, channel, bind, runtime, executions, get store() { return store; }, get persistence() { return persistence; },
    reopen() { persistence.close(); persistence = openPersistence(path); store = openClarificationStore(persistence.sql, { getRun: () => run }); } };
}
const question = (id: string, required = true) => ({ kind: 'question', id, prompt: 'Proceed?', required, owner: 'local' });
const line = (id: string, required = true) => `${JSON.stringify(question(id, required))}\n`;

describe('attempt-bound clarification protocol', () => {
  it('retains legacy rows as unknown through restart without changing the compatibility checksum or state', () => {
    const f = fixture(true);
    const contact = f.store.contacts()[0]!;
    const before = f.store.list(); const ledger = f.persistence.sql.prepare("SELECT checksum FROM migration_ledger WHERE owner='compat.clarifications'").get();
    f.reopen();
    expect(f.store.list()).toEqual(before); expect(f.store.protocol.provenance('old')).toEqual({ revision: 1, attempt: null, channelId: null, kind: 'legacy-unproven' });
    expect(f.store.protocol.contactRevision(contact.id)).toBe(1);
    expect(f.persistence.sql.prepare("SELECT checksum FROM migration_ledger WHERE owner='compat.clarifications'").get()).toEqual(ledger);
  });

  it('pins distinct attempt paths and gate identities and rejects changed retained bindings', () => {
    const f = fixture(); const channel = f.channel(); const snapshot = f.bind(channel);
    expect(parseClarificationChannel(channel)).toEqual(channel);
    expect(new URL(channel.gateUrl!).searchParams.get('channel')).toBe(channel.channelId);
    expect(f.store.protocol.verify(snapshot)).toEqual(channel);
    expect(() => f.store.protocol.bind({ ...snapshot, task: persistedJson({ clarification: f.channel() }) })).toThrow('changed');
    expect(f.channel(2).questionsPath).not.toBe(channel.questionsPath);
    f.reopen(); expect(f.store.protocol.verify(snapshot)).toEqual(channel);
  });

  it('does not assign current attempt provenance to stale shared lines and publishes only bound answers', () => {
    const f = fixture(); f.run.attempt = 2; const channel = f.channel(); f.bind(channel);
    const shared = clarificationPaths(f.root, 'run-1'); writeFileSync(shared.questionsPath, line('stale'));
    writeFileSync(channel.questionsPath, line('current'));
    const runtime = f.runtime(); runtime.poll('run-1', 2, channel.channelId);
    expect(f.store.list().map(value => value.id).sort()).toEqual(['current', 'stale']);
    expect(f.store.protocol.provenance('stale')).toEqual({ revision: 1, attempt: null, channelId: null, kind: 'legacy-unproven' });
    expect(runtime.hasUnanswered('run-1', 2)).toBe(true);
    expect(f.store.protocol.provenance('current')).toEqual({ revision: 1, attempt: 2, channelId: channel.channelId, kind: 'attempt-channel' });
    f.store.answer('current', { answer: 'Yes' }); runtime.poll('run-1', 2, channel.channelId);
    expect(readFileSync(channel.answersPath, 'utf8')).toContain('Yes');
    expect(() => readFileSync(shared.answersPath, 'utf8')).toThrow();
    expect(() => runtime.poll('run-1', 1)).toThrow('Attempt changed');
    expect(() => runtime.hasUnanswered('run-1', 2, f.channel().channelId)).toThrow('binding changed');
  });

  it('rejects cross-channel and unknown question ID replay instead of relabeling it', () => {
    const f = fixture(); f.store.ingestQuestion('run-1', question('legacy'));
    const channel = f.channel(); f.bind(channel);
    expect(() => f.store.ingestQuestion('run-1', question('legacy'), channel)).toThrow('another clarification channel');
    f.store.ingestQuestion('run-1', question('current'), channel);
    expect(() => f.store.ingestQuestion('run-1', question('current'))).toThrow('another clarification channel');
    f.run.attempt = 2;
    expect(() => f.store.ingestQuestion('run-1', question('other'), channel)).toThrow('active clarification channel');
    expect(() => f.store.answer('current', { answer: 'Old answer' })).toThrow('another attempt');
    expect(f.store.protocol.provenance('legacy')?.kind).toBe('legacy-unproven');
  });

  it('keeps unknown and prior required obligations blocking while cancellation is channel scoped', () => {
    const f = fixture(); f.store.ingestQuestion('run-1', question('legacy'));
    const channel = f.channel(); f.bind(channel); f.store.ingestQuestion('run-1', question('current', false), channel);
    f.runtime().complete('run-1', 1);
    expect(f.store.list().find(value => value.id === 'legacy')?.state).toBe('pending');
    expect(f.store.list().find(value => value.id === 'current')?.state).toBe('cancelled');
    expect(f.runtime().hasUnanswered('run-1', 1)).toBe(true);
  });

  it('ignores partial lines until complete and retains exact bound provenance on repeated polls', () => {
    const f = fixture(); const channel = f.channel(); f.bind(channel); const runtime = f.runtime();
    writeFileSync(channel.questionsPath, line('one') + JSON.stringify(question('two'))); runtime.poll('run-1', 1);
    expect(f.store.list()).toHaveLength(1);
    writeFileSync(channel.questionsPath, line('one') + line('two')); runtime.poll('run-1', 1); runtime.poll('run-1', 1);
    expect(f.store.list()).toHaveLength(2); expect(f.store.protocol.provenance('one')?.revision).toBe(1);
  });

  it('increments compatibility lifecycle and contact revisions atomically and rolls them back with their records', () => {
    const f = fixture(); const channel = f.channel(); f.bind(channel); f.store.ingestQuestion('run-1', question('answer'), channel);
    const contact = f.store.saveContact({ name: 'Person', address: 'address' });
    expect(() => f.persistence.transaction(() => {
      f.store.answer('answer', { answer: 'Yes' }); f.store.saveContact({ ...contact, name: 'Changed' }); throw new Error('receipt failure');
    })).toThrow('receipt failure');
    expect(f.store.list()[0]?.state).toBe('pending'); expect(f.store.protocol.provenance('answer')?.revision).toBe(1);
    expect(f.store.protocol.contactRevision(contact.id)).toBe(1); expect(f.store.contacts()[0]?.name).toBe('Person');
    f.store.answer('answer', { answer: 'Yes' }); expect(f.store.protocol.provenance('answer')?.revision).toBe(2);
    f.store.saveContact({ ...contact, enabled: false }); expect(f.store.protocol.contactRevision(contact.id)).toBe(2);
    f.store.ingestQuestion('run-1', { ...question('expired'), timeoutAt: '2000-01-01T00:00:00Z' });
    expect(() => f.store.answer('expired', { answer: 'No' })).toThrow('timed out');
    expect(f.store.protocol.provenance('expired')?.revision).toBe(2);
  });

  it('leaves legacy immutable snapshots unchanged and fails closed when new channel evidence disappears', () => {
    const f = fixture(); const legacy = f.bind(null); const before = JSON.stringify(legacy);
    expect(f.store.protocol.verify(legacy)).toBeNull(); expect(JSON.stringify(legacy)).toBe(before);
    const next = fixture(); const snapshot = next.bind(next.channel());
    next.persistence.sql.prepare('DELETE FROM clarification_channels').run();
    expect(() => next.store.protocol.verify(snapshot)).toThrow('unavailable');
  });

  it('rejects replaced revision triggers on restart', () => {
    const f = fixture();
    f.persistence.sql.exec(`DROP TRIGGER clarification_question_update;
      CREATE TRIGGER clarification_question_update AFTER UPDATE ON clarifications BEGIN SELECT 1; END;`);
    expect(() => f.reopen()).toThrow('trigger is missing or changed');
  });

  it('keeps unknown provenance read-only through the legacy HTTP answer route', async () => {
    const f = fixture(true);
    expect(() => f.store.answer('old', { answer: 'Unsafe guess' })).toThrow('read-only');
    const result = await handleApi('POST', '/api/clarifications/old/answer', new URLSearchParams({ repo: f.run.repo }), { answer: 'Unsafe guess' },
      { clarifications: f.store, db: { getRun: () => f.run } } as unknown as RouterDeps);
    expect(result).toMatchObject({ status: 400, json: { error: expect.stringContaining('read-only') } });
    expect(f.store.list()[0]).toMatchObject({ state: 'pending', answer: null }); expect(f.store.protocol.provenance('old')?.revision).toBe(1);
    expect(f.store.hasRequiredUnanswered('run-1')).toBe(true);
  });
});
