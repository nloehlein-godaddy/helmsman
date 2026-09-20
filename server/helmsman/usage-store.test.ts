// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderUsage } from '../../src/plugins/usage';
import type { RunRow } from './db';
import { openRunTelemetry } from './run-telemetry';
import { openUsageStore, UsageConflictError, UsageValidationError } from './usage-store';

const usage: ProviderUsage = { runId: 'run_1', attempt: 1, eventId: 'event_1', provider: 'codex', model: 'test',
  inputTokens: 12, cachedInputTokens: null, outputTokens: null, totalTokens: null, costUsd: 2 };
const run: RunRow = { id: usage.runId, ticketId: 'TASK-1', repo: 'org/a', adapter: 'codex', status: 'running', attempt: 1,
  prNumber: null, startedAt: '2026-09-01T00:00:00Z', endedAt: null, costUsd: null, worktreePath: null };
let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'helmsman-core-usage-')); path = join(root, 'state.sqlite'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('core usage storage', () => {
  it('records durable telemetry and reported budget costs without an Outcomes store or assessment sink', () => {
    const store = openUsageStore(path);
    const telemetry = openRunTelemetry(path, store);
    try {
      const task = { ticketId: run.ticketId, repo: run.repo, title: 'work', jiraBaseUrl: '' };
      const event = { kind: 'usage' as const, text: 'usage', usage: { inputTokens: 12 }, costUsd: 2 };
      expect(telemetry.record(run, task, event, 0)).toBe(2);
      expect(telemetry.record(run, task, event, 0)).toBe(2);
      expect(telemetry.record(run, task, { kind: 'usage', text: 'unpriced', usage: { outputTokens: 4 } }, 1)).toBe(2);
      telemetry.complete({ ...run, status: 'succeeded' });
    } finally { telemetry.close(); store.close(); }
    const reopened = openUsageStore(path);
    try {
      expect(reopened.listUsage([run.id])).toHaveLength(2);
      expect(reopened.listUsage([run.id]).map(record => record.costUsd)).toEqual([2, null]);
      const sql = new Database(path, { readonly: true });
      try {
        expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
          .toEqual([{ name: 'migration_ledger' }, { name: 'migration_steps' }, { name: 'outcome_usage' },
            { name: 'persistence_intents' }, { name: 'persistence_writers' }, { name: 'run_lifecycle' }]);
      } finally { sql.close(); }
    } finally { reopened.close(); }
  });

  it('adopts the existing usage table without rewriting records or unrelated assessments', () => {
    const sql = new Database(path);
    const payload = JSON.stringify(usage);
    sql.exec('CREATE TABLE outcome_usage (runId TEXT NOT NULL, attempt INTEGER NOT NULL, eventId TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(runId, attempt, eventId)); CREATE TABLE outcome_assessments(runId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    sql.prepare('INSERT INTO outcome_usage VALUES (?, ?, ?, ?)').run(usage.runId, usage.attempt, usage.eventId, payload);
    sql.prepare('INSERT INTO outcome_assessments VALUES (?, ?)').run(usage.runId, 'preserved assessment payload');
    sql.close();
    const store = openUsageStore(path);
    try {
      expect(store.listUsage([usage.runId])).toEqual([usage]);
      expect(store.recordUsage(usage)).toBe(false);
      expect(() => store.recordUsage({ ...usage, costUsd: 3 })).toThrow(UsageConflictError);
      expect(store.recordUsage({ ...usage, eventId: 'event_2', costUsd: 0 })).toBe(true);
    } finally { store.close(); }
    const check = new Database(path, { readonly: true });
    try {
      expect(check.prepare('SELECT payload FROM outcome_usage WHERE eventId = ?').get(usage.eventId)).toEqual({ payload });
      expect(check.prepare('SELECT payload FROM outcome_assessments').get()).toEqual({ payload: 'preserved assessment payload' });
    } finally { check.close(); }
  });

  it('rejects corrupted stored event identities rather than charging another run or double counting', () => {
    const store = openUsageStore(path);
    const sql = new Database(path);
    try {
      sql.prepare('INSERT INTO outcome_usage VALUES (?, ?, ?, ?)').run(usage.runId, usage.attempt, 'different', JSON.stringify(usage));
      expect(() => store.listUsage([usage.runId])).toThrow(UsageValidationError);
    } finally { sql.close(); store.close(); }
  });
});
