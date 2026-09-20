// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type RunRow } from './db';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { openOperationStore } from './operations';
import { openLegacyExecutionAdoption } from './legacy-execution-adoption';
import { createRecoveryService, readRecoverySnapshot } from './recovery-service';

const roots: string[] = [];
const connections = new Set<Persistence>();
afterEach(() => { for (const connection of connections) connection.close(); connections.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hosts = { detached: { kind: 'detached', pid: 123 }, cmux: { kind: 'cmux', workspace: 'workspace:1' },
  wezterm: { kind: 'wezterm', paneId: '1', socket: '/private/socket' }, docker: { kind: 'docker', containerId: 'a'.repeat(64) } };
const sources = { jira: {}, todos: { todoId: 'todo-1' }, freeform: { task: 'private freeform task' }, 'github-review': { review: true, prNumber: 3, prBranch: 'feature' } };
function row(source: keyof typeof sources, host: keyof typeof hosts, status: RunRow['status'] = 'running'): RunRow {
  const id = `${source}-${host}-${status}`;
  return { id, repo: `org/${id}`, ticketId: 'TASK-1', adapter: source === 'github-review' ? 'codex' : 'pre-pr:codex', status, attempt: 1,
    prNumber: source === 'github-review' ? 3 : null, costUsd: 4, startedAt: '2026-09-19T00:00:00Z', endedAt: status === 'running' ? null : '2026-09-19T01:00:00Z',
    worktreePath: `/private/${id}`, logPath: `/private/${id}.log`, exitPath: `/private/${id}.exit`, specPath: `/private/${id}.json`,
    hostKind: host, hostRef: JSON.stringify(hosts[host]), taskJson: JSON.stringify({ ticketId: 'TASK-1', repo: `org/${id}`, title: 'private title', jiraBaseUrl: 'https://jira.private', ...sources[source] }) };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-adoption-')); roots.push(root);
  const path = join(root, 'state.sqlite');
  function open() {
    const persistence = openPersistence(path); connections.add(persistence);
    const db = openDb(persistence.sql); const executions = openExecutionStore(persistence);
    const legacy = openLegacyExecutionAdoption({ persistence, executions });
    return { persistence, db, executions, legacy, close() { persistence.close(); connections.delete(persistence); } };
  }
  return { root, path, open };
}

it.each(Object.keys(sources) as (keyof typeof sources)[])('preserves legacy %s identity across every host and terminal state without inventing executable provenance', source => {
  const f = fixture(); const state = f.open(); const rows: RunRow[] = [];
  for (const host of Object.keys(hosts) as (keyof typeof hosts)[]) {
    for (const status of ['running', 'succeeded', 'failed', 'stopped'] as const) rows.push(row(source, host, status));
  }
  for (const item of rows) state.db.insertRun(item);
  const before = rows.map(item => state.db.getRun(item.id));
  const records = state.legacy.audit(rows);
  expect(records).toHaveLength(16);
  for (const record of records) {
    expect(record.source).toBe(source); expect(record.host).not.toBe('unknown');
    const protectedResources = record.status === 'running' || source !== 'github-review' && record.status !== 'succeeded';
    expect(record.protected).toBe(protectedResources);
    expect(record.state).toBe(protectedResources ? 'blocked' : 'historical');
    expect(state.executions.cleanupEligibility(record.runId).allowed).toBe(!protectedResources);
  }
  expect(state.executions.reservations()).toHaveLength(4);
  expect(rows.map(item => state.db.getRun(item.id))).toEqual(before);
  expect(state.executions.pins()).toEqual([]); expect(state.executions.recoverable()).toEqual([]);
  expect(JSON.stringify(records)).not.toMatch(/private title|jira.private|\/private\//);
  state.close();
  const reopened = f.open(); expect(reopened.legacy.audit(rows)).toEqual(records);
  expect(reopened.executions.reservations()).toHaveLength(4);
});

it('preserves checkpoint files and durable reservations when legacy row projections change after the audit', () => {
  const f = fixture(); const state = f.open(); const active = row('jira', 'detached');
  const checkpoint = join(f.root, 'pre-pr-checkpoint.json'); writeFileSync(checkpoint, '{"private":"retained checkpoint"}');
  state.db.insertRun(active); state.legacy.audit([active]);
  state.db.updateRun(active.id, { status: 'failed', endedAt: '2026-09-20T00:00:00Z' });
  state.legacy.audit([state.db.getRun(active.id)!]);
  expect(state.legacy.list()[0]).toMatchObject({ status: 'running', protected: true, diagnosticCodes: expect.arrayContaining(['legacy-record-changed']) });
  expect(state.executions.reservations()).toHaveLength(1);
  expect(() => state.executions.abandonAdmission(active.id, { actor: 'operator', reason: 'looks stopped' })).toThrow('verified adoption');
  expect(state.executions.cleanupEligibility(active.id).allowed).toBe(false);
  expect(readFileSync(checkpoint, 'utf8')).toBe('{"private":"retained checkpoint"}');
});

it('keeps malformed nullable task and host metadata blocked while preserving all original rows', () => {
  const f = fixture(); const state = f.open(); const first = { ...row('todos', 'wezterm'), taskJson: null, hostRef: null };
  const second = { ...row('freeform', 'docker'), taskJson: 'null', hostRef: '{"kind":"docker","containerId":null}' };
  for (const item of [first, second]) state.db.insertRun(item);
  const result = state.legacy.audit([first, second]);
  expect(result).toHaveLength(2); expect(result.every(item => item.state === 'blocked')).toBe(true);
  expect(result.flatMap(item => item.diagnosticCodes)).toEqual(expect.arrayContaining(['legacy-task-missing', 'legacy-task-invalid', 'legacy-host-missing', 'legacy-host-invalid']));
  expect(state.db.getRun(first.id)?.taskJson).toBeNull(); expect(state.db.getRun(second.id)?.taskJson).toBe('null');
  expect(state.executions.reservations()).toHaveLength(2);
});

it('fails the complete audit transaction on invalid legacy identities instead of admitting around unknown records', () => {
  const f = fixture(); const state = f.open();
  expect(() => state.legacy.audit([row('jira', 'detached'), { ...row('todos', 'cmux'), repo: '' }])).toThrow('identity is invalid');
  expect(state.legacy.list()).toEqual([]);
});

it('exposes terminal resumable legacy records as protected core recovery entries in normal and safe start', () => {
  const f = fixture(); const state = f.open(); const failed = row('freeform', 'detached', 'failed');
  state.db.insertRun(failed); state.legacy.audit([failed]);
  const admissions = openAdmissionStore(state.persistence, state.executions); const operations = openOperationStore(state.persistence, state.executions);
  const service = createRecoveryService({ db: state.db, executions: state.executions, admissions, operations, lifecycle: { list: () => [] }, legacy: state.legacy });
  expect(service.snapshot(failed.repo).runs).toMatchObject([{ id: failed.id, status: 'failed', attachment: 'blocked', protected: true, actions: [] }]);
  expect(readRecoverySnapshot(f.path, failed.repo).runs).toMatchObject([{ id: failed.id, status: 'failed', protected: true, actions: [] }]);
  expect(service.snapshot('org/elsewhere').runs).toEqual([]);
});

it('preserves explicit resumable checkpoint evidence even on a completed legacy projection', () => {
  const f = fixture(); const state = f.open(); const completed = row('freeform', 'detached', 'succeeded');
  const task = JSON.parse(completed.taskJson!);
  completed.taskJson = JSON.stringify({ ...task, prePrResume: { metadataPath: '/private/checkpoint' } });
  state.db.insertRun(completed);
  expect(state.legacy.audit([completed])[0]).toMatchObject({ status: 'succeeded', protected: true, state: 'blocked',
    diagnosticCodes: expect.arrayContaining(['legacy-checkpoint-unverified']) });
  expect(state.executions.cleanupEligibility(completed.id).allowed).toBe(false);
  expect(state.executions.reservations()).toEqual([]);
});
