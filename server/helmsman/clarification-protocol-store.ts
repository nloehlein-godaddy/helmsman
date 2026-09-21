import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateOwned, validateTableColumns } from './migrations';
import { immediateTransaction, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { ExecutionSnapshot } from './execution-store';

export interface ClarificationChannel {
  version: 1;
  runId: string;
  attempt: number;
  channelId: string;
  questionsPath: string;
  answersPath: string;
  gateUrl?: string;
}
export interface ClarificationProvenance {
  revision: number;
  attempt: number | null;
  channelId: string | null;
  kind: 'attempt-channel' | 'legacy-unproven';
}
export interface ClarificationProtocolStore {
  bind(snapshot: ExecutionSnapshot): ClarificationChannel | null;
  channel(runId: string, attempt: number): ClarificationChannel | null;
  verify(snapshot: ExecutionSnapshot): ClarificationChannel | null;
  provenance(questionId: string): ClarificationProvenance | null;
  recordQuestion(questionId: string, channel: ClarificationChannel): void;
  contactRevision(contactId: string): number | null;
}

function identity(runId: unknown, attempt: unknown): void {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)
    || !Number.isSafeInteger(attempt) || Number(attempt) < 1) throw new PersistenceValidationError('Invalid clarification attempt');
}
export function createClarificationChannel(runsDir: string, input: { runId: string; attempt: number; gateUrl?: string }): ClarificationChannel {
  identity(input.runId, input.attempt);
  const channelId = randomUUID();
  const base = join(resolve(runsDir), `${input.runId}.attempt-${input.attempt}.${channelId}`);
  const gate = input.gateUrl ? new URL(input.gateUrl) : null;
  if (gate) { gate.searchParams.set('attempt', String(input.attempt)); gate.searchParams.set('channel', channelId); }
  return { version: 1, runId: input.runId, attempt: input.attempt, channelId,
    questionsPath: `${base}.clarifications.jsonl`, answersPath: `${base}.clarification-answers.jsonl`, ...(gate ? { gateUrl: gate.href } : {}) };
}
export function parseClarificationChannel(value: unknown): ClarificationChannel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const channel = value as Partial<ClarificationChannel>;
  if (channel.version === undefined && channel.channelId === undefined && channel.attempt === undefined && channel.runId === undefined) return null;
  identity(channel.runId, channel.attempt);
  if (channel.version !== 1 || typeof channel.channelId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(channel.channelId)
    || typeof channel.questionsPath !== 'string' || typeof channel.answersPath !== 'string'
    || resolve(channel.questionsPath) !== channel.questionsPath || resolve(channel.answersPath) !== channel.answersPath
    || basename(channel.questionsPath) !== `${channel.runId}.attempt-${channel.attempt}.${channel.channelId}.clarifications.jsonl`
    || dirname(channel.questionsPath) !== dirname(channel.answersPath)
    || channel.answersPath !== channel.questionsPath.replace(/\.clarifications\.jsonl$/, '.clarification-answers.jsonl')) throw new PersistenceValidationError('Invalid clarification channel');
  if (channel.gateUrl !== undefined) {
    if (typeof channel.gateUrl !== 'string') throw new PersistenceValidationError('Invalid clarification gate');
    const gate = new URL(channel.gateUrl);
    if (gate.searchParams.get('attempt') !== String(channel.attempt) || gate.searchParams.get('channel') !== channel.channelId) throw new PersistenceValidationError('Clarification gate is not attempt bound');
  }
  return { version: 1, runId: channel.runId!, attempt: channel.attempt!, channelId: channel.channelId,
    questionsPath: channel.questionsPath, answersPath: channel.answersPath, ...(channel.gateUrl === undefined ? {} : { gateUrl: channel.gateUrl }) };
}

const TRIGGERS: Readonly<Record<string, string>> = {
  clarification_question_insert: `CREATE TRIGGER clarification_question_insert AFTER INSERT ON clarifications BEGIN
    INSERT INTO clarification_question_metadata VALUES (NEW.id, 1, NULL, NULL); END`,
  clarification_question_update: `CREATE TRIGGER clarification_question_update AFTER UPDATE ON clarifications BEGIN
    UPDATE clarification_question_metadata SET revision = revision + 1 WHERE questionId = NEW.id; END`,
  clarification_contact_insert: `CREATE TRIGGER clarification_contact_insert AFTER INSERT ON trusted_contacts BEGIN
    INSERT INTO clarification_contact_metadata VALUES (NEW.id, 1); END`,
  clarification_contact_update: `CREATE TRIGGER clarification_contact_update AFTER UPDATE ON trusted_contacts BEGIN
    UPDATE clarification_contact_metadata SET revision = revision + 1 WHERE contactId = NEW.id; END`,
};
const DDL = `
CREATE TABLE clarification_channels (
  runId TEXT NOT NULL, attempt INTEGER NOT NULL, channelId TEXT NOT NULL UNIQUE,
  snapshotId TEXT NOT NULL, repo TEXT NOT NULL, json TEXT NOT NULL, contentHash TEXT NOT NULL,
  PRIMARY KEY(runId, attempt)
);
CREATE TABLE clarification_question_metadata (
  questionId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1), attempt INTEGER, channelId TEXT
);
CREATE TABLE clarification_contact_metadata (
  contactId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1)
);
INSERT INTO clarification_question_metadata SELECT id, 1, NULL, NULL FROM clarifications;
INSERT INTO clarification_contact_metadata SELECT id, 1 FROM trusted_contacts;
${Object.values(TRIGGERS).join(';\n')};
`;

export function openClarificationProtocolStore(sql: Database.Database): ClarificationProtocolStore {
  migrateOwned(sql, { owner: 'core.clarification-protocol', version: 1, checksum: persistenceHash(DDL),
    tables: ['clarification_channels', 'clarification_question_metadata', 'clarification_contact_metadata'],
    validateLegacy: () => null, apply: () => sql.exec(DDL), validateCurrent() {
      validateTableColumns(sql, 'clarification_channels', ['runId', 'attempt', 'channelId', 'snapshotId', 'repo', 'json', 'contentHash']);
      validateTableColumns(sql, 'clarification_question_metadata', ['questionId', 'revision', 'attempt', 'channelId']);
      validateTableColumns(sql, 'clarification_contact_metadata', ['contactId', 'revision']);
      for (const [name, definition] of Object.entries(TRIGGERS)) {
        const row = sql.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
        if (row?.sql !== definition) throw new PersistenceValidationError('Clarification revision trigger is missing or changed');
      }
    } });
  interface ChannelRow { runId: string; attempt: number; channelId: string; snapshotId: string; repo: string; json: string; contentHash: string }
  const read = (runId: string, attempt: number) => sql.prepare('SELECT * FROM clarification_channels WHERE runId=? AND attempt=?').get(runId, attempt) as ChannelRow | undefined;
  function decode(row: ChannelRow): ClarificationChannel {
    const channel = parseClarificationChannel(JSON.parse(row.json));
    if (!channel || channel.runId !== row.runId || channel.attempt !== row.attempt || channel.channelId !== row.channelId
      || persistenceHash({ channel, snapshotId: row.snapshotId, repo: row.repo }) !== row.contentHash) throw new PersistenceValidationError('Clarification channel integrity failed');
    return channel;
  }
  function snapshotChannel(snapshot: ExecutionSnapshot): ClarificationChannel | null {
    const task = snapshot.task && typeof snapshot.task === 'object' && !Array.isArray(snapshot.task) ? snapshot.task as Record<string, unknown> : null;
    const channel = parseClarificationChannel(task?.clarification);
    if (channel && (channel.runId !== snapshot.runId || channel.attempt !== snapshot.attempt)) throw new PersistenceConflictError('Clarification channel differs from execution attempt');
    return channel;
  }
  const provenance = (questionId: string): ClarificationProvenance | null => {
    const row = sql.prepare('SELECT revision,attempt,channelId FROM clarification_question_metadata WHERE questionId=?').get(questionId) as Omit<ClarificationProvenance, 'kind'> | undefined;
    if (!row) return null;
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || (row.attempt === null) !== (row.channelId === null)
      || row.attempt !== null && (!Number.isSafeInteger(row.attempt) || row.attempt < 1)
      || row.channelId !== null && !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(row.channelId)) throw new PersistenceValidationError('Clarification provenance is invalid');
    return { ...row, kind: row.channelId === null ? 'legacy-unproven' : 'attempt-channel' };
  };
  const store: ClarificationProtocolStore = {
    bind(snapshot) {
      const channel = snapshotChannel(snapshot); if (!channel) return null;
      return immediateTransaction(sql, () => {
        const prior = read(snapshot.runId, snapshot.attempt);
        if (prior) return store.verify(snapshot);
        sql.prepare('INSERT INTO clarification_channels VALUES (?,?,?,?,?,?,?)').run(channel.runId, channel.attempt, channel.channelId,
          snapshot.id, snapshot.repo, stableJson(channel), persistenceHash({ channel, snapshotId: snapshot.id, repo: snapshot.repo }));
        return channel;
      });
    },
    channel(runId, attempt) { identity(runId, attempt); const row = read(runId, attempt); return row ? decode(row) : null; },
    verify(snapshot) {
      const expected = snapshotChannel(snapshot); const row = read(snapshot.runId, snapshot.attempt);
      if (!expected && !row) return null;
      if (!expected || !row || row.snapshotId !== snapshot.id || row.repo !== snapshot.repo || stableJson(decode(row)) !== stableJson(expected)) throw new PersistenceConflictError('Retained clarification channel is unavailable or changed');
      return expected;
    },
    provenance,
    recordQuestion(questionId, channel) {
      const bound = store.channel(channel.runId, channel.attempt);
      const question = sql.prepare('SELECT runId,repo FROM clarifications WHERE id=?').get(questionId) as { runId: string; repo: string } | undefined;
      const row = read(channel.runId, channel.attempt);
      if (!bound || !question || stableJson(bound) !== stableJson(channel) || question.runId !== channel.runId || question.repo !== row?.repo) throw new PersistenceConflictError('Question channel binding is invalid');
      const prior = provenance(questionId);
      if (!prior || prior.channelId !== null) throw new PersistenceConflictError('Question provenance is already recorded');
      sql.prepare('UPDATE clarification_question_metadata SET attempt=?,channelId=? WHERE questionId=?').run(channel.attempt, channel.channelId, questionId);
    },
    contactRevision(contactId) { return (sql.prepare('SELECT revision FROM clarification_contact_metadata WHERE contactId=?').get(contactId) as { revision: number } | undefined)?.revision ?? null; },
  };
  return store;
}
