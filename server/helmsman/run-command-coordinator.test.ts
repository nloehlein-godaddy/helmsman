import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunCommandV1, type RunCommandV1 } from '../../src/plugins/run-command';
import { openPersistence, persistenceHash } from './persistence';
import { createRunCommandCoordinator, RunCommandError, RunCommandRejection, type RunCommandCoordinatorOptions, type RunCommandEvidence } from './run-command-coordinator';
import { openRunCommandStore, type StoredRunCommand } from './run-command-store';

const opened: ReturnType<typeof openPersistence>[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
const caller = 'example.running/panel';
const requestId = '00000000-0000-4000-8000-000000000001';
function launchCommand(): RunCommandV1 { return parseRunCommandV1({ version: 1, requestId, repo: 'owner/repo', action: 'launch', launch: { mode: 'freeform', task: 'Implement' } }); }
function targetCommand(action: 'stop' | 'retry'): RunCommandV1 { return parseRunCommandV1({ version: 1, requestId, repo: 'owner/repo', action, target: { runId: 'original', expectedAttempt: 2 } }); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const store = openRunCommandStore(persistence);
  persistence.sql.exec('CREATE TABLE test_admissions (runId TEXT PRIMARY KEY,repo TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE test_stops (runId TEXT, attempt INTEGER, PRIMARY KEY(runId,attempt))');
  const state = { allowed: true, capacity: true, repo: 'owner/repo', attempt: 2 };
  const validateTarget = vi.fn((command: Exclude<RunCommandV1, { action: 'launch' }>) => {
    if (command.target.runId !== 'original' || command.repo !== state.repo || command.target.expectedAttempt !== state.attempt) throw new RunCommandRejection('Voyage scope or attempt changed.');
  });
  const inspect = vi.fn((record: StoredRunCommand): RunCommandEvidence => {
    if (record.command.action === 'stop') {
      const stopped = persistence.sql.prepare('SELECT 1 FROM test_stops WHERE runId=? AND attempt=?').get(record.assignedRunId, record.command.target.expectedAttempt);
      return stopped ? { status: 'accepted', runId: record.assignedRunId, attempt: record.command.target.expectedAttempt, message: null } : { status: 'absent' };
    }
    const row = persistence.sql.prepare('SELECT * FROM test_admissions WHERE runId=?').get(record.assignedRunId) as { repo: string; status: 'accepted' | 'recovery-required' } | undefined;
    if (row && row.repo !== record.command.repo) throw new Error('Evidence scope mismatch');
    return row ? { status: row.status, runId: record.assignedRunId, attempt: 1, message: null } : { status: 'absent' };
  });
  const options: RunCommandCoordinatorOptions<RunCommandV1> = {
    store, owner: { token: 'current', pid: 123 }, ownerAlive: owner => owner.pid === 123,
    authorizeRead: vi.fn((_caller, repo) => { if (repo !== 'owner/repo' && repo !== 'owner/other') throw new RunCommandError(403, 'Scope unavailable'); }),
    authorizeWrite: vi.fn(() => { if (!state.allowed) throw new RunCommandRejection('Contribution disabled.'); }),
    validateTarget,
    prepareLaunch: vi.fn(async command => { if (!state.capacity) throw new RunCommandRejection('Capacity exhausted.'); return command; }),
    launch: vi.fn((_prepared, record) => {
      expect(persistence.sql.inTransaction).toBe(false);
      persistence.transaction(() => persistence.sql.prepare('INSERT INTO test_admissions VALUES(?,?,?)').run(record.assignedRunId, record.command.repo, 'accepted'));
      return { runId: record.assignedRunId, attempt: 1 };
    }),
    recordStop: vi.fn(command => {
      expect(persistence.sql.inTransaction).toBe(true);
      persistence.sql.prepare('INSERT INTO test_stops VALUES(?,?) ON CONFLICT DO NOTHING').run(command.target.runId, command.target.expectedAttempt);
    }),
    signalStop: vi.fn(), inspect,
  };
  return { persistence, store, state, options, service: createRunCommandCoordinator(options) };
}
describe('run command coordinator', () => {
  it('replays a lost accepted response before current capacity or contribution gates', async () => {
    const f = setup(); const command = launchCommand();
    const receipt = await f.service.submit(caller, command);
    expect(receipt.status).toBe('accepted');
    f.state.allowed = false; f.state.capacity = false;
    const restarted = createRunCommandCoordinator(f.options);
    expect(await restarted.submit(caller, command)).toEqual(receipt);
    expect(restarted.receipt(caller, { repo: command.repo, requestId })).toEqual(receipt);
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous dispatch and rejects different content under its request ID', async () => {
    const f = setup(); const wait = deferred(); const command = launchCommand();
    f.options.prepareLaunch = vi.fn(async value => { await wait.promise; return value; });
    const service = createRunCommandCoordinator(f.options);
    const first = service.submit(caller, command);
    expect((await service.submit(caller, command)).status).toBe('pending');
    await expect(service.submit(caller, { ...command, repo: 'owner/other' })).rejects.toThrow('different command');
    wait.resolve(); expect((await first).status).toBe('accepted');
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('rechecks exact attempt after async retry preparation', async () => {
    const f = setup(); const wait = deferred();
    f.options.prepareLaunch = vi.fn(async command => { await wait.promise; return command; });
    const pending = createRunCommandCoordinator(f.options).submit(caller, targetCommand('retry'));
    f.state.attempt = 3; wait.resolve();
    expect(await pending).toMatchObject({ status: 'rejected', message: 'Voyage scope or attempt changed.' });
    expect(f.options.launch).not.toHaveBeenCalled();
  });
  it('rechecks contribution authority after async preparation', async () => {
    const f = setup(); const wait = deferred();
    f.options.prepareLaunch = vi.fn(async command => { await wait.promise; return command; });
    const pending = createRunCommandCoordinator(f.options).submit(caller, launchCommand());
    f.state.allowed = false; wait.resolve();
    expect(await pending).toMatchObject({ status: 'rejected', message: 'Contribution disabled.' });
    expect(f.options.launch).not.toHaveBeenCalled();
  });
  it('rejects a Stop targeting another galleon before durable control or signaling', async () => {
    const f = setup(); f.state.repo = 'owner/other';
    expect((await f.service.submit(caller, targetCommand('stop'))).status).toBe('rejected');
    expect(f.options.recordStop).not.toHaveBeenCalled(); expect(f.options.signalStop).not.toHaveBeenCalled();
  });
  it('persists Stop acceptance before signaling and replays without stopping a newer attempt', async () => {
    const f = setup(); const command = targetCommand('stop');
    f.options.signalStop = vi.fn(() => { expect(f.store.get(caller, requestId)?.receipt.status).toBe('accepted'); throw new Error('No attachment'); });
    const service = createRunCommandCoordinator(f.options);
    const receipt = await service.submit(caller, command);
    expect(receipt).toMatchObject({ status: 'accepted', runId: 'original', attempt: 2 });
    f.state.attempt = 3;
    expect(await service.submit(caller, command)).toEqual(receipt);
    expect(f.options.signalStop).toHaveBeenCalledTimes(1);
    expect(f.persistence.sql.prepare('SELECT * FROM test_stops').all()).toEqual([{ runId: 'original', attempt: 2 }]);
  });
  it('rolls back Stop evidence when its transactional callback rejects', async () => {
    const f = setup(); const record = f.options.recordStop;
    f.options.recordStop = command => { record(command); throw new RunCommandRejection('Control rejected.'); };
    const receipt = await createRunCommandCoordinator(f.options).submit(caller, targetCommand('stop'));
    expect(receipt.status).toBe('rejected');
    expect(f.persistence.sql.prepare('SELECT * FROM test_stops').all()).toEqual([]);
    expect(f.options.signalStop).not.toHaveBeenCalled();
  });
  it('reclaims a dead dispatcher before admission using its originally assigned run ID', async () => {
    const f = setup(); const command = launchCommand(); const row = f.store.put(caller, command);
    f.store.claim(caller, requestId, { token: 'dead', pid: 456 }, () => false);
    const receipt = await f.service.submit(caller, command);
    expect(receipt).toMatchObject({ status: 'accepted', runId: row.assignedRunId });
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('does not reclaim a live dispatcher or dispatch from a receipt read', async () => {
    const f = setup(); const command = launchCommand(); f.store.put(caller, command);
    f.store.claim(caller, requestId, { token: 'another-live', pid: 123 }, () => false);
    expect(f.service.receipt(caller, { repo: command.repo, requestId })?.status).toBe('pending');
    expect((await f.service.submit(caller, command)).status).toBe('pending');
    expect(f.options.prepareLaunch).not.toHaveBeenCalled(); expect(f.options.launch).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'recovery-required'])('reconciles a crash after admission as %s without another launch', async status => {
    const f = setup(); const command = launchCommand(); const row = f.store.put(caller, command);
    f.store.claim(caller, requestId, { token: 'dead', pid: 456 }, () => false);
    f.persistence.sql.prepare('INSERT INTO test_admissions VALUES(?,?,?)').run(row.assignedRunId, command.repo, status);
    expect(await f.service.submit(caller, command)).toMatchObject({ status, runId: row.assignedRunId });
    expect(f.options.launch).not.toHaveBeenCalled();
  });
  it('reconstructs acceptance when launch returns no response after committing admission', async () => {
    const f = setup(); const launch = f.options.launch;
    f.options.launch = (prepared, record) => { launch(prepared, record); throw new Error('Response lost'); };
    const service = createRunCommandCoordinator(f.options);
    expect((await service.submit(caller, launchCommand())).status).toBe('accepted');
    expect((await service.submit(caller, launchCommand())).status).toBe('accepted');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('retains unknown delivery failures without issuing another command', async () => {
    const f = setup(); f.options.launch = vi.fn(() => { throw new Error('Unexpected dispatch failure'); });
    const service = createRunCommandCoordinator(f.options);
    expect((await service.submit(caller, launchCommand())).status).toBe('recovery-required');
    const restart = createRunCommandCoordinator({ ...f.options, owner: { token: 'restart', pid: 789 }, ownerAlive: () => false });
    expect((await restart.submit(caller, launchCommand())).status).toBe('recovery-required');
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('records definite gate rejection without dispatching', async () => {
    const f = setup(); f.state.capacity = false;
    const receipt = await f.service.submit(caller, launchCommand());
    expect(receipt).toMatchObject({ status: 'rejected', message: 'Capacity exhausted.' });
    f.state.capacity = true;
    expect(await f.service.submit(caller, launchCommand())).toEqual(receipt);
    expect(f.options.launch).not.toHaveBeenCalled();
  });
  it('does not expose receipts to a different scope or contribution', async () => {
    const f = setup(); await f.service.submit(caller, launchCommand());
    expect(f.service.receipt('example.other/panel', { repo: 'owner/repo', requestId })).toBeNull();
    expect(() => f.service.receipt(caller, { repo: 'owner/other', requestId })).toThrow('not found');
    expect(() => f.service.receipt(caller, { repo: 'denied/repo', requestId })).toThrow('Scope unavailable');
  });
  it('fences an old preparation callback if ownership changed before it returned', async () => {
    const f = setup(); const wait = deferred(); const prepare = f.options.prepareLaunch;
    f.options.prepareLaunch = vi.fn(async command => { await wait.promise; return command; });
    const old = createRunCommandCoordinator(f.options).submit(caller, launchCommand());
    const replacement = createRunCommandCoordinator({ ...f.options, prepareLaunch: prepare, owner: { token: 'new', pid: 999 }, ownerAlive: () => false });
    const receipt = await replacement.submit(caller, launchCommand());
    wait.resolve(); expect(await old).toEqual(receipt);
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('refuses mismatched recovered evidence instead of accepting another execution', async () => {
    const f = setup(); f.store.put(caller, launchCommand());
    f.options.inspect = () => ({ status: 'accepted', runId: 'wrong', attempt: 1, message: null });
    await expect(createRunCommandCoordinator(f.options).submit(caller, launchCommand())).rejects.toThrow('identity');
    expect(f.options.launch).not.toHaveBeenCalled();
  });
  it('reserves one retry per original attempt across concurrent request IDs and callers', async () => {
    const f = setup(); const wait = deferred(); const command = targetCommand('retry');
    f.options.prepareLaunch = vi.fn(async value => { await wait.promise; return value; });
    const service = createRunCommandCoordinator(f.options);
    const first = service.submit(caller, command);
    const duplicate = await service.submit('example.other/panel', { ...command, requestId: '00000000-0000-4000-8000-000000000002' });
    expect(duplicate).toMatchObject({ status: 'rejected', runId: null, attempt: null });
    expect(duplicate.message).toContain(f.store.get(caller, requestId)?.assignedRunId);
    wait.resolve(); expect((await first).status).toBe('accepted');
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('preserves retry uniqueness after response loss and coordinator restart', async () => {
    const f = setup(); const command = targetCommand('retry');
    const first = await f.service.submit(caller, command);
    const restart = createRunCommandCoordinator({ ...f.options, store: openRunCommandStore(f.persistence) });
    const duplicate = await restart.submit(caller, { ...command, requestId: '00000000-0000-4000-8000-000000000002' });
    expect(duplicate.status).toBe('rejected'); expect(duplicate.message).toContain(first.runId);
    expect(await restart.submit(caller, command)).toEqual(first);
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('retains retry uniqueness while delivery needs recovery', async () => {
    const f = setup(); const command = targetCommand('retry');
    f.options.launch = vi.fn(() => { throw new Error('Unknown dispatch'); });
    const service = createRunCommandCoordinator(f.options);
    expect((await service.submit(caller, command)).status).toBe('recovery-required');
    expect((await service.submit('example.other/panel', { ...command, requestId: '00000000-0000-4000-8000-000000000002' })).status).toBe('rejected');
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
  it('permits a fresh retry request after definite rejection', async () => {
    const f = setup(); const command = targetCommand('retry'); f.state.capacity = false;
    expect((await f.service.submit(caller, command)).status).toBe('rejected');
    f.state.capacity = true;
    expect((await f.service.submit('example.other/panel', { ...command, requestId: '00000000-0000-4000-8000-000000000002' })).status).toBe('accepted');
    expect((await f.service.submit(caller, command)).status).toBe('rejected');
    expect(f.options.launch).toHaveBeenCalledTimes(1);
  });
});

function resolution(service: ReturnType<typeof createRunCommandCoordinator>) {
  const entry = service.recovery('owner/repo')[0]!;
  return { caller: entry.caller, requestId: entry.requestId, repo: entry.repo, receiptHash: entry.receiptHash,
    actor: 'operator', reason: 'No admission exists', evidence: { note: 'Verified retained state' } };
}
it('resolves a failed pre-admission retry without launching and releases the original-attempt reservation', async () => {
  const f = setup(); const originalLaunch = f.options.launch;
  f.options.launch = vi.fn(() => { throw new Error('Unexpected launch failure'); });
  const service = createRunCommandCoordinator(f.options); const command = targetCommand('retry');
  expect((await service.submit(caller, command)).status).toBe('recovery-required');
  expect(service.recovery('owner/other')).toEqual([]);
  expect(service.recovery('OWNER/REPO')[0]).toMatchObject({ canResolve: true, targetRunId: 'original', targetAttempt: 2 });
  f.state.allowed = false;
  const input = resolution(service); const receipt = service.resolveNotAdmitted(input);
  expect(await service.submit(caller, command)).toEqual(receipt);
  expect(f.options.launch).toHaveBeenCalledTimes(1);
  f.state.allowed = true; f.options.launch = originalLaunch;
  const restarted = createRunCommandCoordinator({ ...f.options, store: openRunCommandStore(f.persistence) });
  expect(restarted.resolveNotAdmitted(input)).toEqual(receipt);
  expect((await restarted.submit(caller, { ...command, requestId: '00000000-0000-4000-8000-000000000002' })).status).toBe('accepted');
  expect(originalLaunch).toHaveBeenCalledTimes(1);
});
it('fences late asynchronous preparation after an operator resolves the command', async () => {
  const f = setup(); const wait = deferred();
  f.options.prepareLaunch = vi.fn(async value => { await wait.promise; return value; });
  const service = createRunCommandCoordinator(f.options); const pending = service.submit(caller, launchCommand());
  const record = f.store.get(caller, requestId)!;
  f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const receipt = service.resolveNotAdmitted(resolution(service));
  wait.resolve(); expect(await pending).toEqual(receipt); expect(f.options.launch).not.toHaveBeenCalled();
});
it('rechecks newly retained evidence transactionally against the original operator proof', () => {
  const f = setup(); const record = f.store.put(caller, launchCommand());
  f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const input = resolution(f.service);
  f.persistence.sql.prepare('INSERT INTO test_admissions VALUES(?,?,?)').run(record.assignedRunId, record.command.repo, 'accepted');
  expect(() => f.service.resolveNotAdmitted(input)).toThrow('retained');
  expect(f.service.recovery()).toEqual([]);
  expect(f.store.get(caller, requestId)?.receipt.status).toBe('accepted');
  expect(f.options.launch).not.toHaveBeenCalled();
});
it('does not offer resolution when the stricter absence proof fails', () => {
  const f = setup(); const record = f.store.put(caller, launchCommand());
  const receipt = f.store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  f.options.assertNotAdmitted = () => { throw new Error('Control evidence exists'); };
  const service = createRunCommandCoordinator(f.options);
  expect(service.recovery()[0]?.canResolve).toBe(false);
  expect(() => service.resolveNotAdmitted({ ...resolution(service), receiptHash: persistenceHash(receipt) })).toThrow('Control evidence');
});
