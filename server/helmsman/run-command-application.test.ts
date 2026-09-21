import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPersistence, persistenceHash } from './persistence';
import { openDb, type RunRow } from './db';
import { openExecutionStore } from './execution-store';
import { openExecutionControls } from './execution-controls';
import { openAdmissionStore } from './admission-store';
import { openRunCommandStore } from './run-command-store';
import { createApplicationRunCommands, runCommandAdmissionBinding } from './run-command-application';
import { parseRunCommandV1 } from '../../src/plugins/run-command';
import { parsePluginPackage } from '../../src/plugins/package';
import type { PluginCatalog } from '../../src/plugins/runtime';
import type { Todo } from '../../src/data/todos';

const opened: ReturnType<typeof openPersistence>[] = [];
afterEach(() => { for (const value of opened.splice(0)) value.close(); });
const caller = 'example.runs/panel';
const command = parseRunCommandV1({ version: 1, requestId: '00000000-0000-4000-8000-000000000001', repo: 'org/project', action: 'launch', launch: { mode: 'freeform', task: 'Work' } });
const artifact = { pluginId: 'helmsman.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
function run(overrides: Partial<RunRow> = {}): RunRow {
  return { id: 'original', repo: command.repo, ticketId: 'freeform', adapter: 'codex', status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-09-20T00:00:00.000Z', endedAt: '2026-09-20T00:01:00.000Z', costUsd: null, worktreePath: null,
    launchJson: JSON.stringify({ repo: command.repo, mode: 'freeform', task: 'Original' }), ...overrides };
}
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const db = openDb(persistence.sql); const executions = openExecutionStore(persistence);
  const admissions = openAdmissionStore(persistence, executions); const controls = openExecutionControls(persistence);
  const store = openRunCommandStore(persistence);
  let catalog: PluginCatalog = { version: 1, safeMode: false, bindings: {}, plugins: [{ hash: 'a'.repeat(64), package: parsePluginPackage({
    packageVersion: 1, manifest: { manifestVersion: 2, id: 'example.runs', version: '1.0.0', sdkVersion: 1, pages: [],
      panels: [{ id: 'panel', title: 'Runs', contract: { id: 'helmsman/helm-panel', version: 1 }, requires: [{ id: 'helmsman/run-command', version: 1 }] }] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, panelEntries: { panel: 'panel.js' },
  }) }] };
  let repos = [command.repo]; const canStart = vi.fn(() => ({ ok: true })); const jiraEnabled = vi.fn(() => true);
  const get = vi.fn<() => Todo | null | Promise<Todo | null>>(() => null); const stop = vi.fn(() => false);
  const launch = vi.fn<Parameters<typeof createApplicationRunCommands>[0]['launch']>(input => {
    admissions.admit({ runId: input.runId, repo: input.repo, request: { commandBinding: { ...input.commandBinding } }, settings: {}, artifacts: [artifact] }, 10);
    return input.runId;
  });
  const options = { store, db, admissions, executions, controls, catalog: () => catalog, repos: () => repos,
    canStart, jiraEnabled, launch, stop, todos: { get, list: () => [], create: () => { throw new Error('unused'); }, update: () => null, remove: () => false } };
  return { persistence, db, admissions, executions, controls, store, launch, stop, get, canStart, jiraEnabled, options,
    service: createApplicationRunCommands(options), disable: () => { catalog = { ...catalog, safeMode: true }; }, removeRepo: () => { repos = []; } };
}
describe('application run command authority', () => {
  it('replays accepted commands after disablement, removed configuration and exhausted capacity', async () => {
    const f = setup(); const receipt = await f.service.submit(caller, command);
    expect(receipt.status).toBe('accepted'); expect(f.launch).toHaveBeenCalledOnce();
    f.disable(); f.removeRepo(); f.canStart.mockReturnValue({ ok: false });
    expect(await f.service.submit(caller, command)).toEqual(receipt);
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it('recovers command acceptance from its exact durable admission after a crash', async () => {
    const f = setup(); const record = f.store.put(caller, command);
    f.admissions.admit({ runId: record.assignedRunId, repo: command.repo, request: { commandBinding: { ...runCommandAdmissionBinding(record) } }, settings: {}, artifacts: [artifact] }, 3);
    expect(f.service.receipt(caller, { repo: command.repo, requestId: command.requestId })?.status).toBe('accepted'); expect(f.launch).not.toHaveBeenCalled();
  });
  it('never adopts or redispatches an unrelated admission', async () => {
    const f = setup(); const record = f.store.put(caller, command);
    f.admissions.admit({ runId: record.assignedRunId, repo: command.repo, request: {}, settings: {}, artifacts: [artifact] }, 3);
    expect((await f.service.submit(caller, command)).status).toBe('recovery-required'); expect(f.launch).not.toHaveBeenCalled();
  });
  it.each(['matching', 'unrelated'] as const)('rechecks %s admission evidence created during asynchronous preparation', async kind => {
    const f = setup();
    const pending = f.service.submit(caller, command);
    const record = f.store.get(caller, command.requestId)!;
    f.admissions.admit({ runId: record.assignedRunId, repo: kind === 'matching' ? command.repo : 'org/other',
      request: kind === 'matching' ? { commandBinding: { ...runCommandAdmissionBinding(record) } } : {}, settings: {}, artifacts: [artifact] }, 3);
    f.launch.mockImplementation(input => input.runId);
    expect((await pending).status).toBe(kind === 'matching' ? 'accepted' : 'recovery-required');
    expect(f.launch).not.toHaveBeenCalled();
    expect((await f.service.submit(caller, command)).status).toBe(kind === 'matching' ? 'accepted' : 'recovery-required');
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('persists stop intent without an attached process and fences later attempts', async () => {
    const f = setup(); f.db.insertRun(run({ status: 'running', endedAt: null }));
    const input = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'stop', target: { runId: 'original', expectedAttempt: 1 } });
    const receipt = await f.service.submit(caller, input);
    expect(receipt.status).toBe('accepted'); expect(f.controls.isStopRequested({ runId: 'original', attempt: 1 })).toBe(true);
    f.db.updateRun('original', { attempt: 2 });
    expect(await f.service.submit(caller, input)).toEqual(receipt); expect(f.stop).toHaveBeenCalledOnce();
    expect(f.controls.isStopRequested({ runId: 'original', attempt: 2 })).toBe(false);
  });
  it('rejects spoofed target scope and stale attempts without stop effects', async () => {
    for (const target of [{ runId: 'original', expectedAttempt: 2 }, { runId: 'foreign', expectedAttempt: 1 }]) {
      const f = setup(); f.db.insertRun(run({ status: 'running' })); f.db.insertRun(run({ id: 'foreign', repo: 'org/other', status: 'running' }));
      const input = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'stop', target });
      expect((await f.service.submit(caller, input)).status).toBe('rejected'); expect(f.stop).not.toHaveBeenCalled();
    }
  });
  it('does not adopt another galleon stop evidence during replay inspection', async () => {
    const f = setup(); f.db.insertRun(run({ repo: 'org/other', status: 'running' }));
    f.controls.requestStop({ runId: 'original', attempt: 1 });
    const input = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'stop', target: { runId: 'original', expectedAttempt: 1 } });
    expect((await f.service.submit(caller, input)).status).toBe('rejected'); expect(f.stop).not.toHaveBeenCalled();
  });
  it('rechecks launch gates after asynchronous preparation', async () => {
    const f = setup(); f.db.insertRun(run());
    const input = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'retry', target: { runId: 'original', expectedAttempt: 1 } });
    const pending = f.service.submit(caller, input); f.canStart.mockReturnValue({ ok: false });
    expect((await pending).status).toBe('rejected'); expect(f.launch).not.toHaveBeenCalled();
  });
  it('preserves Jira and Todo retry gates', async () => {
    const f = setup(); f.db.insertRun(run({ ticketId: 'PROJ-1', launchJson: JSON.stringify({ repo: command.repo, mode: 'ticket', ticketId: 'PROJ-1' }) }));
    const input = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'retry', target: { runId: 'original', expectedAttempt: 1 } });
    f.jiraEnabled.mockReturnValue(false); expect((await f.service.submit(caller, input)).status).toBe('rejected');
    f.db.updateRun('original', { launchJson: JSON.stringify({ repo: command.repo, mode: 'todo', todoId: 'TODO-1' }) });
    expect((await f.service.submit(caller, { ...input, requestId: '00000000-0000-4000-8000-000000000002' })).status).toBe('rejected');
    expect(f.get).toHaveBeenCalledWith('TODO-1'); expect(f.launch).not.toHaveBeenCalled();
  });
});

function resolveInput(f: ReturnType<typeof setup>, request = command) {
  const record = f.store.get(caller, request.requestId)!;
  return { caller, requestId: request.requestId, repo: request.repo, receiptHash: persistenceHash(record.receipt),
    actor: 'operator', reason: 'Checked authoritative state', evidence: { note: 'No admission' } };
}
it('core recovery reconciles a matching admission after the contribution is disabled', () => {
  const f = setup(); const record = f.store.put(caller, command);
  f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  f.admissions.admit({ runId: record.assignedRunId, repo: command.repo, request: { commandBinding: { ...runCommandAdmissionBinding(record) } }, settings: {}, artifacts: [artifact] }, 3);
  f.disable(); f.removeRepo();
  expect(f.service.recovery(command.repo)).toEqual([]);
  expect(f.store.get(caller, command.requestId)?.receipt.status).toBe('accepted'); expect(f.launch).not.toHaveBeenCalled();
});
it('never resolves an unrelated retained admission as non-admission', () => {
  const f = setup(); const record = f.store.put(caller, command);
  f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  f.admissions.admit({ runId: record.assignedRunId, repo: command.repo, request: {}, settings: {}, artifacts: [artifact] }, 3);
  expect(f.service.recovery()[0]?.canResolve).toBe(false);
  expect(() => f.service.resolveNotAdmitted(resolveInput(f))).toThrow('retained'); expect(f.launch).not.toHaveBeenCalled();
});
it.each(['missing', 'foreign'] as const)('refuses Stop non-admission with durable control and %s galleon evidence', kind => {
  const f = setup(); const input = parseRunCommandV1({ version: 1, requestId: command.requestId, repo: command.repo, action: 'stop', target: { runId: 'original', expectedAttempt: 2 } });
  const record = f.store.put(caller, input); f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  if (kind === 'foreign') f.db.insertRun(run({ repo: 'org/other', attempt: 2 }));
  f.controls.requestStop({ runId: 'original', attempt: 2 });
  expect(f.service.recovery()[0]?.canResolve).toBe(false);
  expect(() => f.service.resolveNotAdmitted(resolveInput(f, input))).toThrow('retained');
  expect(f.store.get(caller, input.requestId)?.receipt.status).toBe('recovery-required'); expect(f.stop).not.toHaveBeenCalled();
});
it('resolves an unrecorded Stop without signaling, recording intent or losing its exact attempt', () => {
  const f = setup(); const input = parseRunCommandV1({ version: 1, requestId: command.requestId, repo: command.repo, action: 'stop', target: { runId: 'original', expectedAttempt: 2 } });
  const record = f.store.put(caller, input); f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const receipt = f.service.resolveNotAdmitted(resolveInput(f, input));
  expect(receipt.resolution).toMatchObject({ runId: 'original', attempt: 2 });
  expect(f.controls.isStopRequested({ runId: 'original', attempt: 2 })).toBe(false); expect(f.stop).not.toHaveBeenCalled();
});
it.each(['attempt', 'snapshot', 'checkpoint', 'evidence', 'control', 'pin', 'claim', 'operation'] as const)('refuses non-admission with retained %s evidence even without attempt one', kind => {
  const f = setup(); const record = f.store.put(caller, command); const runId = record.assignedRunId;
  f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const sql = f.persistence.sql;
  if (kind === 'attempt') sql.prepare('INSERT INTO execution_attempts(runId,attempt,snapshotId,launchId,json) VALUES(?,2,?,?,?)').run(runId, 'snapshot', 'launch', '{}');
  else if (kind === 'snapshot') sql.prepare('INSERT INTO execution_snapshots VALUES(?,?,2,?,?,?)').run('snapshot', runId, 'a'.repeat(64), '{}', new Date().toISOString());
  else if (kind === 'checkpoint') sql.prepare('INSERT INTO execution_checkpoints VALUES(?,?,2,?,?,?)').run('checkpoint', runId, 'snapshot', 'retired', '{}');
  else if (kind === 'evidence') sql.prepare('INSERT INTO execution_evidence(runId,attempt,kind,payload,createdAt) VALUES(?,2,?,?,?)').run(runId, 'outcome', '{}', new Date().toISOString());
  else if (kind === 'control') f.controls.requestStop({ runId, attempt: 2 });
  else if (kind === 'pin') f.executions.retainPins([{ kind: 'admission', ownerId: runId, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash }]);
  else if (kind === 'claim') { sql.exec('CREATE TABLE work_claims(json TEXT)'); sql.prepare('INSERT INTO work_claims VALUES(?)').run(JSON.stringify({ runId })); }
  else { sql.exec('CREATE TABLE operations(draft TEXT)'); sql.prepare('INSERT INTO operations VALUES(?)').run(JSON.stringify({ origin: { runId } })); }
  expect(f.service.recovery()[0]?.canResolve).toBe(false);
  expect(() => f.service.resolveNotAdmitted(resolveInput(f))).toThrow('retained'); expect(f.launch).not.toHaveBeenCalled();
});
