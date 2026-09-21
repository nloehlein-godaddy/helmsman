import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunCommandV1 } from '../../src/plugins/run-command';
import { openPersistence, persistenceHash } from './persistence';
import { openRunCommandStore } from './run-command-store';

const opened: ReturnType<typeof openPersistence>[] = [];
const directories: string[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const caller = 'example.running/panel';
const command = parseRunCommandV1({ version: 1, requestId: '00000000-0000-4000-8000-000000000001', repo: 'owner/repo', action: 'launch', launch: { mode: 'freeform', task: 'Implement' } });
function setup() { const persistence = openPersistence(':memory:'); opened.push(persistence); return { persistence, store: openRunCommandStore(persistence) }; }
describe('durable run command store', () => {
  it('persists immutable caller/request content with one host assigned execution ID', () => {
    const { persistence, store } = setup();
    const first = store.put(caller, command);
    expect(openRunCommandStore(persistence).put(caller, command)).toEqual(first);
    expect(store.put('example.other/panel', command).assignedRunId).not.toBe(first.assignedRunId);
    expect(() => store.put(caller, { ...command, repo: 'owner/other' })).toThrow('different command');
    expect(() => store.put(caller, { ...command, action: 'launch', launch: { mode: 'freeform', task: 'Changed' } })).toThrow('different command');
  });
  it('fences live dispatchers and transfers only a proven dead owner', () => {
    const { store } = setup(); store.put(caller, command);
    const owner = { token: 'one', pid: 100 }; const other = { token: 'two', pid: 200 };
    expect(store.claim(caller, command.requestId, owner, () => true)?.owner).toEqual(owner);
    expect(store.claim(caller, command.requestId, owner, () => true)).toBeNull();
    expect(store.claim(caller, command.requestId, other, () => true)).toBeNull();
    const claimed = store.claim(caller, command.requestId, other, () => false)!;
    expect(claimed.owner).toEqual(other);
    expect(() => store.settle(caller, { ...claimed.receipt, status: 'accepted' }, owner)).toThrow('ownership');
    expect(store.settle(caller, { ...claimed.receipt, status: 'accepted' }, other).status).toBe('accepted');
    expect(store.claim(caller, command.requestId, owner, () => false)).toBeNull();
  });
  it('protects terminal receipts, execution scope and attempts', () => {
    const { store } = setup(); const row = store.put(caller, command);
    expect(() => store.settle(caller, { ...row.receipt, runId: 'wrong', status: 'accepted' })).toThrow('identity');
    expect(() => store.settle(caller, { ...row.receipt, attempt: 2, status: 'accepted' })).toThrow('identity');
    const receipt = store.settle(caller, { ...row.receipt, status: 'accepted' });
    expect(store.settle(caller, receipt)).toEqual(receipt);
    expect(() => store.settle(caller, { ...row.receipt, status: 'rejected' })).toThrow('settled');
  });
  it('rolls back durable stop evidence and receipt together', () => {
    const { persistence, store } = setup(); const row = store.put(caller, command);
    persistence.sql.exec('CREATE TABLE stop_evidence (runId TEXT PRIMARY KEY)');
    expect(() => store.transaction(() => {
      persistence.sql.prepare('INSERT INTO stop_evidence VALUES(?)').run(row.assignedRunId);
      store.settle(caller, { ...row.receipt, status: 'accepted' });
      throw new Error('crash');
    })).toThrow('crash');
    expect(store.get(caller, command.requestId)?.receipt.status).toBe('pending');
    expect(persistence.sql.prepare('SELECT * FROM stop_evidence').all()).toEqual([]);
  });
  it('detects persisted command corruption before dispatch', () => {
    const { persistence, store } = setup(); store.put(caller, command);
    persistence.sql.prepare('UPDATE run_commands SET assignedRunId=?').run('tampered');
    expect(() => store.get(caller, command.requestId)).toThrow('integrity');
  });
  it('retains ambiguous commands without redispatch and allows only evidence based acceptance', () => {
    const { store } = setup(); const row = store.put(caller, command);
    store.settle(caller, { ...row.receipt, status: 'recovery-required', message: 'Ambiguous' });
    expect(store.claim(caller, command.requestId, { token: 'new', pid: 123 }, () => false)).toBeNull();
    expect(() => store.settle(caller, { ...row.receipt, status: 'rejected' })).toThrow('transition');
    expect(store.settle(caller, { ...row.receipt, status: 'accepted' }).status).toBe('accepted');
  });
  it('retains pending identity and accepted receipts across closed database connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-run-commands-')); directories.push(directory);
    const path = join(directory, 'commands.sqlite');
    const first = openPersistence(path); opened.push(first);
    const store = openRunCommandStore(first); const row = store.put(caller, command);
    store.claim(caller, command.requestId, { token: 'old-process', pid: 456 }, () => false); first.close();
    const next = openPersistence(path); opened.push(next);
    const reopened = openRunCommandStore(next);
    expect(reopened.get(caller, command.requestId)).toMatchObject({ assignedRunId: row.assignedRunId, command, owner: { token: 'old-process', pid: 456 } });
    const accepted = reopened.settle(caller, { ...row.receipt, status: 'accepted' }); next.close();
    const final = openPersistence(path); opened.push(final);
    expect(openRunCommandStore(final).get(caller, command.requestId)?.receipt).toEqual(accepted);
  });
  it('enforces active retry uniqueness even if a caller bypasses the coordinator', () => {
    const { persistence, store } = setup();
    const retry = parseRunCommandV1({ version: 1, repo: command.repo, requestId: command.requestId, action: 'retry', target: { runId: 'original', expectedAttempt: 2 } });
    store.put(caller, retry);
    const other = { ...retry, requestId: '00000000-0000-4000-8000-000000000002' };
    const blocked = store.put('example.other/panel', other);
    expect(blocked.receipt.status).toBe('rejected');
    expect(() => persistence.sql.prepare('UPDATE run_commands SET receipt=? WHERE caller=?')
      .run(JSON.stringify({ ...blocked.receipt, status: 'pending' }), 'example.other/panel')).toThrow('UNIQUE');
  });
});

function resolutionInput(receipt: ReturnType<ReturnType<typeof openRunCommandStore>['settle']>) {
  return { caller, requestId: command.requestId, repo: command.repo, receiptHash: persistenceHash(receipt),
    actor: 'operator', reason: 'Verified admission is absent', evidence: { note: 'Checked durable state' } };
}
it('persists an audited rejection across restart and replays a lost resolution response exactly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-command-resolution-')); directories.push(directory);
  const path = join(directory, 'commands.sqlite'); const first = openPersistence(path); opened.push(first);
  const store = openRunCommandStore(first); const record = store.put(caller, command);
  const pending = store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const input = resolutionInput(pending);
  const receipt = store.resolveNotAdmitted(input, () => { expect(first.sql.inTransaction).toBe(true); });
  expect(receipt).toMatchObject({ status: 'rejected', runId: null, attempt: null,
    resolution: { version: 1, kind: 'not-admitted', runId: record.assignedRunId, attempt: 1 } });
  first.close(); const next = openPersistence(path); opened.push(next); const restarted = openRunCommandStore(next);
  expect(restarted.get(caller, command.requestId)?.receipt).toEqual(receipt);
  expect(restarted.resolveNotAdmitted(input, () => { throw new Error('Must not inspect after successful resolution'); })).toEqual(receipt);
  expect(() => restarted.resolveNotAdmitted({ ...input, evidence: { note: 'Changed' } }, () => {})).toThrow('proof changed');
  expect(restarted.recovery()).toEqual([]);
  expect(next.sql.prepare('SELECT actor,reason,evidence FROM run_command_resolutions').all()).toEqual([
    { actor: input.actor, reason: input.reason, evidence: JSON.stringify(input.evidence) },
  ]);
});
it('requires current proof, non-admission and an audit for recovery rejection', () => {
  const { persistence, store } = setup(); const record = store.put(caller, command);
  const receipt = store.settle(caller, { ...record.receipt, status: 'recovery-required' }); const input = resolutionInput(receipt);
  expect(() => store.resolveNotAdmitted({ ...input, receiptHash: 'a'.repeat(64) }, () => {})).toThrow('changed before resolution');
  expect(() => store.resolveNotAdmitted(input, () => { throw new Error('Admission retained'); })).toThrow('Admission retained');
  expect(() => store.settle(caller, { ...receipt, status: 'rejected', runId: null, attempt: null,
    resolution: { version: 1, kind: 'not-admitted', id: '00000000-0000-4000-8000-000000000099', runId: record.assignedRunId, attempt: 1 } })).toThrow('operator audit');
  expect(persistence.sql.prepare('SELECT * FROM run_command_resolutions').all()).toEqual([]);
  store.settle(caller, { ...receipt, message: 'New evidence' });
  expect(() => store.resolveNotAdmitted(input, () => {})).toThrow('changed before resolution');
});
it.each(['audit', 'marker'] as const)('rejects corrupted %s on a resolved command', kind => {
  const { persistence, store } = setup(); const record = store.put(caller, command);
  const receipt = store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const resolved = store.resolveNotAdmitted(resolutionInput(receipt), () => {});
  if (kind === 'audit') persistence.sql.prepare('UPDATE run_command_resolutions SET actor=?').run('tampered');
  else { const { resolution: _resolution, ...stripped } = resolved; persistence.sql.prepare('UPDATE run_commands SET receipt=?').run(JSON.stringify(stripped)); }
  expect(() => store.get(caller, command.requestId)).toThrow('audit integrity');
});
it('fences receipt changes made during an absence check atomically', () => {
  const { store } = setup(); const record = store.put(caller, command);
  const receipt = store.settle(caller, { ...record.receipt, status: 'recovery-required' });
  expect(() => store.resolveNotAdmitted(resolutionInput(receipt), () => store.settle(caller, { ...receipt, status: 'accepted' }))).toThrow('changed during resolution');
  expect(store.get(caller, command.requestId)?.receipt).toEqual(receipt);
});
