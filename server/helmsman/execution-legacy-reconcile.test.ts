// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { openDb, type RunRow } from './db';
import { openExecutionStore } from './execution-store';
import { openExecutionOwnership } from './execution-ownership';
import { parseExecutionFootprint } from './execution-footprint';
import { openExecutionPolicy } from './execution-policy';
import { openLegacyExecutionAdoption } from './legacy-execution-adoption';
import { openPersistence, persistenceHash, type Persistence } from './persistence';

const connections: Persistence[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });
const checkout = { path: '/tmp/repo', commonDirectory: '/tmp/repo/.git' };
const workspace = '/tmp/repo/.worktrees/old';
function run(status: RunRow['status'], adapter = 'pre-pr:codex', task: Record<string, unknown> = {}): RunRow {
  return { id: 'old', repo: 'org/repo', ticketId: 'TASK-1', adapter, status, attempt: 1,
    prNumber: null, costUsd: null, startedAt: '2026-09-19T00:00:00Z', endedAt: status === 'running' ? null : '2026-09-19T01:00:00Z',
    worktreePath: workspace, logPath: '/tmp/old.log', exitPath: '/tmp/old.exit', specPath: '/tmp/old.json',
    hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 123 }),
    taskJson: JSON.stringify({ ticketId: 'TASK-1', repo: 'org/repo', title: 'task', jiraBaseUrl: 'https://jira.example', ...task }) };
}
function fixture(value: RunRow) {
  const persistence = openPersistence(':memory:'); connections.push(persistence);
  const db = openDb(persistence.sql); db.insertRun(value);
  const executions = openExecutionStore(persistence, Date.now, { preferSchema: 2 });
  const legacy = openLegacyExecutionAdoption({ persistence, executions }); legacy.audit([value]);
  const ownership = openExecutionOwnership(persistence);
  const owner = ownership.get(value.id)!;
  const input = { runId: value.id, expectedRunHash: persistenceHash(persistence.sql.prepare('SELECT * FROM runs WHERE id=?').get(value.id)),
    expectedFootprintHash: persistenceHash(owner.footprint), checkout, workspace };
  return { persistence, db, executions, legacy, ownership, input };
}

it('narrows a terminal retained checkpoint to exact workspace and branch claims without clearing its obligation', () => {
  const f = fixture(run('failed'));
  expect(f.legacy.list()[0]?.protected).toBe(true);
  const result = f.ownership.reconcileLegacyTerminal({ ...f.input, kind: 'registered', branchRef: 'refs/heads/agent/old' });
  expect(result).toMatchObject({ state: 'held', footprint: { completeness: 'verified', checkout,
    resources: expect.arrayContaining([
      { kind: 'workspace', namespace: 'filesystem', identity: workspace },
      { kind: 'branch', namespace: 'github.com/org/repo', identity: 'refs/heads/agent/old' },
      { kind: 'branch', namespace: 'git:/tmp/repo/.git', identity: 'refs/heads/agent/old' },
    ]) } });
  expect(f.legacy.list()[0]?.protected).toBe(true);
  expect(f.executions.cleanupEligibility('old').allowed).toBe(false);
  expect(() => f.executions.reserveAdmission({ runId: 'old', repo: 'org/repo', maxConcurrency: 2, evidence: {} })).toThrow('verified adoption');
  expect(() => f.ownership.acquire({ ...result.footprint, runId: 'other', resources: [
    { kind: 'workspace', namespace: 'filesystem', identity: '/tmp/repo/.worktrees/other' },
    { kind: 'branch', namespace: 'github.com/org/repo', identity: 'refs/heads/agent/other' },
  ] })).not.toThrow();
  expect(() => f.ownership.acquire({ ...result.footprint, runId: 'collision' })).toThrow('owned by old');
});

it('admits two independent new runs on the same galleon while rejecting retained branch and workspace collisions', () => {
  const f = fixture(run('failed'));
  f.ownership.reconcileLegacyTerminal({ ...f.input, kind: 'registered', branchRef: 'refs/heads/agent/old' });
  openExecutionPolicy(f.persistence).set({ caller: 'config', requestId: 'allow-independent', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 3 });
  const footprint = (runId: string, branch = runId, path = `/tmp/repo/.worktrees/${runId}`) => parseExecutionFootprint({
    version: 1, runId, repo: 'org/repo', completeness: 'verified', checkout,
    resources: [{ kind: 'workspace', namespace: 'filesystem', identity: path },
      { kind: 'branch', namespace: 'github.com/org/repo', identity: `refs/heads/agent/${branch}` },
      { kind: 'branch', namespace: 'git:/tmp/repo/.git', identity: `refs/heads/agent/${branch}` }],
  });
  const reserve = (runId: string, input = footprint(runId)) => f.executions.reserveAdmission({ runId, repo: 'org/repo',
    maxConcurrency: 3, evidence: {}, footprint: input });
  reserve('new-a'); reserve('new-b');
  expect(f.executions.reservations().map(item => item.runId)).toEqual(['new-a', 'new-b']);
  expect(() => reserve('branch-global', parseExecutionFootprint({ ...footprint('branch-global'), resources: [
    { kind: 'workspace', namespace: 'filesystem', identity: '/tmp/repo/.worktrees/branch-global' },
    { kind: 'branch', namespace: 'github.com/org/repo', identity: 'refs/heads/agent/old' },
  ] }))).toThrow('owned by old');
  expect(() => reserve('branch-local', parseExecutionFootprint({ ...footprint('branch-local'), resources: [
    { kind: 'workspace', namespace: 'filesystem', identity: '/tmp/repo/.worktrees/branch-local' },
    { kind: 'branch', namespace: 'git:/tmp/repo/.git', identity: 'refs/heads/agent/old' },
  ] }))).toThrow('owned by old');
  expect(() => reserve('workspace-clash', footprint('workspace-clash', 'workspace-clash', workspace))).toThrow('owned by old');
});

it('retains an unregistered terminal directory as workspace-only when the legacy record is historical', () => {
  const old = { ...run('failed', 'codex'), hostRef: null, hostKind: null, taskJson: null };
  const f = fixture(old);
  expect(f.legacy.list()[0]).toMatchObject({ protected: false, source: 'unknown', host: 'unknown' });
  const saved = f.db.getRun('old');
  const result = f.ownership.reconcileLegacyTerminal({ ...f.input, kind: 'orphan', branchRef: null });
  expect(result.footprint.resources).toEqual([{ kind: 'workspace', namespace: 'filesystem', identity: workspace }]);
  expect(f.db.getRun('old')).toEqual(saved);
  expect(() => f.executions.reserveAdmission({ runId: 'old', repo: 'org/repo', maxConcurrency: 2, evidence: {} }))
    .toThrow('verified adoption');
  expect(() => f.ownership.acquire({ ...result.footprint, runId: 'other', resources: [
    { kind: 'workspace', namespace: 'filesystem', identity: '/tmp/repo/.worktrees/other' },
  ] })).not.toThrow();
});

it('retains a moved orphan workspace when the original recorded path was proven absent', () => {
  const old = { ...run('failed', 'codex'), worktreePath: '/tmp/old-checkout/.worktrees/old',
    hostRef: null, hostKind: null, taskJson: null };
  const f = fixture(old);
  const original = f.db.getRun('old');
  const result = f.ownership.reconcileLegacyTerminal({ ...f.input, kind: 'orphan', branchRef: null });
  expect(result.footprint.resources).toEqual([{ kind: 'workspace', namespace: 'filesystem', identity: workspace }]);
  expect(f.db.getRun('old')).toEqual(original);
  const strict = fixture({ ...run('failed'), worktreePath: '/tmp/old-checkout/.worktrees/old' });
  expect(() => strict.ownership.reconcileLegacyTerminal({ ...strict.input, kind: 'registered', branchRef: 'refs/heads/agent/old' }))
    .toThrow('terminal run changed');
});

it('releases a physically absent succeeded checkpoint owner while preserving its original legacy protection', () => {
  const f = fixture(run('succeeded', 'pre-pr:codex', { prePrResume: { metadataPath: '/tmp/checkpoint' } }));
  expect(f.legacy.list()[0]?.protected).toBe(true);
  expect(f.ownership.reconcileLegacyTerminal({ ...f.input, kind: 'absent', branchRef: null }).state).toBe('released');
  expect(f.legacy.list()[0]?.protected).toBe(true);
  expect(f.executions.cleanupEligibility('old').allowed).toBe(false);
});

it('keeps protected failed checkpoints, active runs, changed rows and unresolved pins exclusive', () => {
  const protectedRun = fixture(run('failed'));
  expect(() => protectedRun.ownership.reconcileLegacyTerminal({ ...protectedRun.input, kind: 'unknown', branchRef: null } as never))
    .toThrow('Invalid legacy execution reconciliation evidence');
  expect(() => protectedRun.ownership.reconcileLegacyTerminal({ ...protectedRun.input, kind: 'absent', branchRef: null })).toThrow('identity remains unverified');
  expect(() => protectedRun.ownership.reconcileLegacyTerminal({ ...protectedRun.input, kind: 'orphan', branchRef: null })).toThrow('identity remains unverified');
  const active = fixture(run('running'));
  expect(() => active.ownership.reconcileLegacyTerminal({ ...active.input, kind: 'registered', branchRef: 'refs/heads/agent/old' })).toThrow('terminal run changed');
  const changed = fixture(run('failed'));
  changed.db.updateRun('old', { endedAt: '2026-09-20T00:00:00Z' });
  expect(() => changed.ownership.reconcileLegacyTerminal({ ...changed.input, kind: 'registered', branchRef: 'refs/heads/agent/old' })).toThrow('terminal run changed');
  const pinned = fixture(run('failed'));
  pinned.executions.retainPins([{ kind: 'admission', ownerId: 'old', pluginId: 'example.host', artifactHash: 'a'.repeat(64) }]);
  expect(() => pinned.ownership.reconcileLegacyTerminal({ ...pinned.input, kind: 'registered', branchRef: 'refs/heads/agent/old' })).toThrow('artifact pins');
  expect(pinned.ownership.get('old')?.footprint.completeness).toBe('exclusive');
});

it('refuses narrowing when modern checkpoints, operations, claims or unknown legacy identities remain', () => {
  const branchRef = 'refs/heads/agent/old';
  const unknown = fixture({ ...run('failed', 'codex'), taskJson: null, hostRef: null, hostKind: null });
  expect(() => unknown.ownership.reconcileLegacyTerminal({ ...unknown.input, kind: 'registered', branchRef })).toThrow('identity remains unverified');
  const checkpoint = fixture(run('failed'));
  checkpoint.persistence.sql.prepare('INSERT INTO execution_checkpoints VALUES (?,?,?,?,?,?)')
    .run('checkpoint', 'old', 1, 'snapshot', 'resumable', '{}');
  expect(() => checkpoint.ownership.reconcileLegacyTerminal({ ...checkpoint.input, kind: 'registered', branchRef })).toThrow('execution checkpoints');
  const operation = fixture(run('failed'));
  operation.persistence.sql.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,runId TEXT); INSERT INTO operations VALUES('op','old')");
  expect(() => operation.ownership.reconcileLegacyTerminal({ ...operation.input, kind: 'registered', branchRef })).toThrow('external operations');
  const claim = fixture(run('failed'));
  claim.persistence.sql.exec("CREATE TABLE work_claims(json TEXT); INSERT INTO work_claims VALUES('{\"runId\":\"old\"}')");
  expect(() => claim.ownership.reconcileLegacyTerminal({ ...claim.input, kind: 'registered', branchRef })).toThrow('task source claims');
  for (const f of [unknown, checkpoint, operation, claim]) expect(f.ownership.get('old')?.footprint.completeness).toBe('exclusive');
});
