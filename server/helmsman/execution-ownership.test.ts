// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exclusiveExecutionFootprint, parseExecutionFootprint } from './execution-footprint';
import { openAdmissionStore } from './admission-store';
import { openExecutionStore } from './execution-store';
import { openExecutionOwnership } from './execution-ownership';
import { openExecutionPolicy } from './execution-policy';
import { openPersistence, type Persistence } from './persistence';

const databases: Persistence[] = [];
afterEach(() => { databases.splice(0).forEach(value => value.close()); });
function setup(version: 1 | 2 = 2) {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const execution = openExecutionStore(persistence, Date.now, { preferSchema: version });
  return { persistence, execution, policy: openExecutionPolicy(persistence), ownership: version === 2 ? openExecutionOwnership(persistence) : null };
}
function footprint(runId: string, repo = 'org/repo', task = runId, branch = `agent/${runId}`) {
  return parseExecutionFootprint({ version: 1, runId, repo, completeness: 'verified', checkout: { path: '/tmp/repo', commonDirectory: '/tmp/repo/.git' },
    resources: [{ kind: 'task', namespace: 'jira', identity: task }, { kind: 'branch', namespace: 'github.com/org/repo', identity: branch },
      { kind: 'workspace', namespace: 'local', identity: `/tmp/repo/.worktrees/${runId}` }] });
}

it('allows independent footprints but rejects canonical task, branch and workspace collisions', () => {
  const { ownership } = setup(); ownership!.acquire(footprint('one')); ownership!.acquire(footprint('two'));
  expect(() => ownership!.acquire(footprint('three', 'org/other', 'one'))).toThrow('owned by one');
  expect(() => ownership!.acquire(footprint('three', 'org/repo', 'three', 'agent/one'))).toThrow('owned by one');
  const duplicate = footprint('three'); duplicate.resources = duplicate.resources.map(resource => resource.kind === 'workspace' ? { ...resource, identity: '/tmp/repo/.worktrees/one' } : resource);
  expect(() => ownership!.acquire(duplicate)).toThrow('owned by one'); expect(ownership!.held()).toHaveLength(2);
});

it('treats galleon and shared-checkout wildcards as conflicts with every verified owner', () => {
  const { ownership } = setup(); ownership!.acquire(footprint('one'));
  expect(() => ownership!.acquire(exclusiveExecutionFootprint('unknown', 'ORG/REPO'))).toThrow('owned by one');
  expect(() => ownership!.acquire(exclusiveExecutionFootprint('alias', 'org/alias', { path: '/tmp/alias', commonDirectory: '/tmp/repo/.git' }))).toThrow('owned by one');
});

it('preserves exact ownership during replay and fences cleanup against continuation', () => {
  const { ownership } = setup(); const input = footprint('one'); const original = ownership!.acquire(input);
  expect(ownership!.acquire(input)).toEqual(original);
  expect(() => ownership!.acquire(footprint('one', 'org/repo', 'different'))).toThrow('cannot change');
  expect(() => ownership!.beginCleanup('one', () => false)).toThrow('not eligible');
  const token = ownership!.beginCleanup('one', () => true);
  expect(ownership!.beginCleanup('one', () => true)).toBe(token);
  expect(() => ownership!.acquire(input)).toThrow('cleanup remains unresolved');
  expect(() => ownership!.completeCleanup('one', 'stale-owner', () => true)).toThrow('owner changed');
  expect(() => ownership!.acquire(footprint('two', 'org/repo', 'one'))).toThrow('owned by one');
  ownership!.completeCleanup('one', token, () => true);
  expect(ownership!.get('one')?.state).toBe('released'); ownership!.acquire(footprint('two', 'org/repo', 'one'));
  expect(() => ownership!.acquire(input)).toThrow('owned by two');
});

it('rejects missing or orphaned exact claims rather than claiming resources are free', () => {
  const { persistence, ownership } = setup(); ownership!.acquire(footprint('one'));
  persistence.sql.prepare("DELETE FROM execution_resource_claims WHERE kind='branch'").run();
  expect(() => ownership!.acquire(footprint('two'))).toThrow('ownership is incomplete');
});

it('defaults to one and refuses opt-in on a version 1 installation', () => {
  const { policy } = setup(1);
  expect(policy.read('ORG/REPO')).toEqual({ version: 1, repo: 'org/repo', revision: 0, maxConcurrentRuns: 1 });
  expect(() => policy.set({ caller: 'config', requestId: 'one', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 2 })).toThrow('compatible ownership schema');
  expect(policy.read('org/repo').revision).toBe(0);
});

it('journals exact policy requests and fences concurrent edits without cancelling reservations', () => {
  const { execution, policy } = setup();
  execution.reserveAdmission({ runId: 'one', repo: 'org/repo', maxConcurrency: 3, evidence: {} });
  const command = { caller: 'config', requestId: 'one', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 2 };
  const result = policy.set(command); expect(policy.set(command)).toEqual(result);
  expect(() => policy.set({ ...command, maxConcurrentRuns: 3 })).toThrow('different content');
  expect(() => policy.set({ ...command, requestId: 'two' })).toThrow('changed');
  policy.set({ ...command, requestId: 'three', expectedRevision: 1, maxConcurrentRuns: 1 });
  expect(execution.reservations()).toHaveLength(1);
});

it('admits independent work only after opt-in and rolls collisions back without pins', () => {
  const { persistence, execution, policy, ownership } = setup();
  const admissions = openAdmissionStore(persistence, execution);
  const admit = (id: string, task = id) => admissions.admit({ runId: id, repo: 'org/repo', request: {}, settings: {},
    artifacts: [{ pluginId: 'example.host', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] }], footprint: footprint(id, 'org/repo', task) }, 3);
  admit('one');
  expect(() => admit('two')).toThrow('capacity');
  policy.set({ caller: 'config', requestId: 'enable', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 3 });
  admit('two'); expect(admit('two')).toMatchObject({ runId: 'two' });
  expect(() => admit('three', 'one')).toThrow('owned by one');
  expect(admissions.get('three')).toBeNull(); expect(ownership!.get('three')).toBeNull();
  expect(execution.pins().some(pin => pin.ownerId === 'three')).toBe(false);
  execution.reserveAdmission({ runId: 'other', repo: 'org/other', maxConcurrency: 3, evidence: {} });
  expect(() => admit('three')).toThrow('capacity');
  policy.set({ caller: 'config', requestId: 'lower', repo: 'org/repo', expectedRevision: 1, maxConcurrentRuns: 1 });
  expect(execution.reservations()).toHaveLength(3);
  admissions.fail('one', 'cancelled before preparation');
  expect(ownership!.get('one')?.state).toBe('released');
  expect(() => admit('three')).toThrow('capacity');
});

it('counts legacy active rows without ownership and excludes conservative unknown identities', () => {
  const { persistence, execution, policy } = setup();
  policy.set({ caller: 'config', requestId: 'enable', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 3 });
  persistence.sql.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,repo TEXT,status TEXT); INSERT INTO runs VALUES('legacy','org/repo','running')");
  expect(execution.reservations()).toHaveLength(1);
  expect(() => execution.reserveAdmission({ runId: 'one', repo: 'org/repo', maxConcurrency: 3, evidence: {}, footprint: footprint('one') })).toThrow('exclusive');
  expect(() => execution.reserveAdmission({ runId: 'two', repo: 'org/other', maxConcurrency: 1, evidence: {} })).toThrow('capacity');
});

it('serializes capacity and exact resource claims across independent SQLite writers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-ownership-'));
  const first = openPersistence(join(directory, 'db.sqlite'));
  const one = openExecutionStore(first, Date.now, { preferSchema: 2 });
  const second = openPersistence(join(directory, 'db.sqlite'));
  const two = openExecutionStore(second);
  try {
    openExecutionPolicy(first).set({ caller: 'config', requestId: 'enable', repo: 'org/repo', expectedRevision: 0, maxConcurrentRuns: 3 });
    const reserve = (store: typeof one, id: string, task = id) => store.reserveAdmission({ runId: id, repo: 'org/repo', maxConcurrency: 2, evidence: {}, footprint: footprint(id, 'org/repo', task) });
    reserve(one, 'one'); expect(() => reserve(two, 'two', 'one')).toThrow('owned by one');
    reserve(two, 'two'); expect(() => reserve(one, 'three')).toThrow('capacity');
    expect(one.reservations()).toHaveLength(2); expect(two.reservations()).toEqual(one.reservations());
    expect(openExecutionOwnership(second).get('three')).toBeNull();
    one.abandonAdmission('one', { cancelled: true }); reserve(two, 'three', 'one');
    expect(one.reservations().map(row => row.runId).sort()).toEqual(['three', 'two']);
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('retires branch and task claims only after fenced detachment while preserving the inspection workspace', () => {
  const { ownership } = setup(); ownership!.acquire(footprint('one'));
  const token = ownership!.beginCleanup('one', () => true);
  const previous = ownership!.get('one')!.footprint;
  const detached = { ...previous, resources: previous.resources.filter(resource => resource.kind === 'workspace') };
  expect(() => ownership!.completeDetach('one', 'stale', detached, () => true)).toThrow('changed');
  ownership!.completeDetach('one', token, detached, () => true);
  expect(ownership!.get('one')).toMatchObject({ state: 'held', footprint: { resources: [{ kind: 'workspace' }] } });
  ownership!.acquire(footprint('retry', 'org/repo', 'one', 'agent/one'));
  expect(() => ownership!.acquire(footprint('conflict', 'org/repo', 'one', 'agent/one'))).toThrow('owned by retry');
  const replacedWorkspace = footprint('replacement'); replacedWorkspace.resources = replacedWorkspace.resources.map(resource => resource.kind === 'workspace' ? { ...resource, identity: '/tmp/repo/.worktrees/one' } : resource);
  expect(() => ownership!.acquire(replacedWorkspace)).toThrow('owned by one');
});
