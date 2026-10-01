// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createExecutionCleanup } from './execution-cleanup';
import { openExecutionOwnership } from './execution-ownership';
import { exclusiveExecutionFootprint } from './execution-footprint';
import { openExecutionStore, type ExecutionSnapshotInput } from './execution-store';
import { openPersistence, type Persistence } from './persistence';
const databases: Persistence[] = [];
afterEach(() => { databases.splice(0).forEach(value => value.close()); });
function setup() {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const executions = openExecutionStore(persistence, Date.now, { preferSchema: 2 });
  const ownership = openExecutionOwnership(persistence);
  const snapshot: ExecutionSnapshotInput = { version: 1, runId: 'one', attempt: 1, repo: 'org/repo',
    logicalWork: { source: 'freeform', instance: 'local', taskId: 'one' }, task: {}, workflowSnapshotId: null,
    artifacts: [{ pluginId: 'example.host', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] }],
    bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'local', pluginId: 'example.host', artifactHash: 'a'.repeat(64), connectionId: null, credentialHandle: null }],
    settings: {}, schemas: [], provenance: { kind: 'admission', evidence: {} } };
  executions.prepare({ snapshot, launchId: 'launch', paths: { worktree: '/tmp/repo/.worktrees/one', log: '/tmp/log', exit: '/tmp/exit', spec: '/tmp/spec' }, maxConcurrency: 3,
    footprint: exclusiveExecutionFootprint('one', 'org/repo', { path: '/tmp/repo', commonDirectory: '/tmp/repo/.git' }) });
  const lease = executions.lease({ runId: 'one', attempt: 1 }, 60_000)!;
  const finish = () => { executions.recordOutcome(lease, { status: 'failed', endedAt: new Date().toISOString(), evidence: { kind: 'never-launched' } }); executions.releaseReservation('one', { terminal: true }); };
  const verifyAbsent = vi.fn(async () => undefined); const remove = vi.fn(async () => undefined);
  const cleanup = createExecutionCleanup({ persistence, executions, verifyAbsent, withMaintenance: async (_repo, operation) => operation() });
  const input = { runId: 'one', repoDirectory: '/tmp/repo', commonDirectory: '/tmp/repo/.git', workspace: '/tmp/repo/.worktrees/one', remove };
  return { persistence, executions, ownership, snapshot, finish, cleanup, input, verifyAbsent, remove };
}
it('retains resource ownership after terminal capacity release and only retires after verified removal', async () => {
  const { executions, ownership, finish, cleanup, input, remove, verifyAbsent } = setup();
  await expect(cleanup.remove(input)).rejects.toThrow('not eligible'); expect(remove).not.toHaveBeenCalled();
  finish(); expect(executions.reservations()).toEqual([]); expect(ownership.get('one')?.state).toBe('held');
  await cleanup.remove(input); expect(remove).toHaveBeenCalledOnce(); expect(verifyAbsent).toHaveBeenCalledOnce();
  expect(ownership.get('one')?.state).toBe('released');
});
it('keeps claims fenced when removal or absence proof fails and recovers with the same cleanup token', async () => {
  const { persistence, ownership, finish, cleanup, input, verifyAbsent } = setup(); finish();
  verifyAbsent.mockRejectedValueOnce(new Error('still registered'));
  await expect(cleanup.remove(input)).rejects.toThrow('still registered');
  const token = ownership.get('one')?.cleanupToken; expect(token).toBeTruthy();
  expect(openExecutionOwnership(persistence).get('one')?.cleanupToken).toBe(token);
  expect(() => ownership.acquire(exclusiveExecutionFootprint('two', 'org/repo'))).toThrow('owned by one');
  await cleanup.remove(input); expect(ownership.get('one')?.state).toBe('released');
});
it('rejects changed checkout identity without starting filesystem mutation', async () => {
  const { finish, cleanup, input, remove } = setup(); finish();
  await expect(cleanup.remove({ ...input, commonDirectory: '/tmp/other/.git' })).rejects.toThrow('differs'); expect(remove).not.toHaveBeenCalled();
});

it('reacquires capacity for the same owner and next attempt without replacing retained workspace ownership', () => {
  const { executions, ownership, snapshot, finish } = setup(); finish();
  const retained = ownership.get('one');
  executions.prepare({ snapshot: { ...snapshot, attempt: 2 }, launchId: 'continue', paths: { worktree: '/tmp/repo/.worktrees/one', log: '/tmp/log2', exit: '/tmp/exit2', spec: '/tmp/spec2' }, maxConcurrency: 1 });
  expect(executions.reservations()).toEqual([{ runId: 'one', repo: 'org/repo', reason: 'prepared' }]);
  expect(ownership.get('one')).toEqual(retained);
});
