// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDb } from './db';
import { openExecutionStore } from './execution-store';
import { openExecutionOwnership } from './execution-ownership';
import { openExecutionPolicy } from './execution-policy';
import { openLegacyExecutionAdoption } from './legacy-execution-adoption';
import { localExecutionFootprint } from './execution-local-footprint';
import { reconcileLegacyExecution } from './legacy-execution-reconciliation';
import { openPersistence, type Persistence } from './persistence';
import { describeLocalCheckout } from './worktree';

const roots: string[] = [];
const databases: Persistence[] = [];
afterEach(() => {
  databases.splice(0).forEach(database => database.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function fixture(orphan: boolean) {
  const agentsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-reconciliation-'))); roots.push(agentsRoot);
  const directory = join(agentsRoot, 'repo'); mkdirSync(directory);
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', 'https://github.com/org/repo.git']);
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const db = openDb(persistence.sql);
  const workspace = join(directory, '.worktrees', 'historical');
  db.insertRun({ id: 'historical', repo: 'org/repo', ticketId: 'TASK-1', adapter: 'claude-code', status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T01:00:00Z', costUsd: null, worktreePath: workspace });
  const executions = openExecutionStore(persistence, Date.now, { preferSchema: 2 });
  const legacy = openLegacyExecutionAdoption({ persistence, executions }); legacy.audit(db.listRuns(-1));
  const ownership = openExecutionOwnership(persistence);
  if (orphan) {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, '.git'), `gitdir: ${join(directory, '.git', 'worktrees', 'historical')}\n`);
    writeFileSync(join(workspace, 'retained.txt'), 'preserve this work');
  }
  openExecutionPolicy(persistence).set({ caller: 'config', requestId: 'enable', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 3 });
  const reserve = (runId: string) => executions.reserveAdmission({ runId, repo: 'org/repo', maxConcurrency: 3, evidence: {},
    footprint: localExecutionFootprint({ runId, repo: 'org/repo', mode: 'coding', trustedLocalHost: true, source: null, unknownTask: false, retry: false,
      checkout: describeLocalCheckout(agentsRoot, 'org/repo', runId) }) });
  return { agentsRoot, isolatedRoot: join(agentsRoot, '.helmsman-docker-workspaces'), persistence, ownership, executions, db, workspace, reserve };
}

it.each([false, true])('reconciles a historical allocation before admitting independent runs (orphan=%s)', async orphan => {
  const f = fixture(orphan);
  const original = f.db.getRun('historical');
  expect(() => f.reserve('first')).toThrow('owned by historical');
  expect(await reconcileLegacyExecution({ ...f, owner: f.ownership.get('historical')! })).toBe('reconciled');
  f.reserve('first'); f.reserve('second'); f.reserve('third');
  expect(f.executions.reservations()).toHaveLength(3);
  expect(() => f.reserve('fourth')).toThrow('capacity');
  expect(f.db.getRun('historical')).toEqual(original);
  if (orphan) {
    expect(readFileSync(join(f.workspace, 'retained.txt'), 'utf8')).toBe('preserve this work');
    expect(f.ownership.get('historical')?.footprint.resources).toEqual([{ kind: 'workspace', namespace: 'filesystem', identity: f.workspace }]);
  } else expect(f.ownership.get('historical')?.state).toBe('released');
});

it('preserves exclusive ownership when the retained process is alive', async () => {
  const f = fixture(false);
  f.db.updateRun('historical', { hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: process.pid }),
    taskJson: JSON.stringify({ repo: 'org/repo', ticketId: 'TASK-1', title: 'Task', jiraBaseUrl: '' }) });
  await expect(reconcileLegacyExecution({ ...f, owner: f.ownership.get('historical')! })).rejects.toThrow();
  expect(f.ownership.get('historical')?.footprint.completeness).toBe('exclusive');
  expect(() => f.reserve('first')).toThrow('owned by historical');
});
