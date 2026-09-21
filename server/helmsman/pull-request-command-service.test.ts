// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestCommandV1 } from '../../src/plugins/pull-request-command';
import { openExecutionStore, type ProviderBinding } from './execution-store';
import { openOperationStore, type DurableOperation, type OperationResult } from './operations';
import { openPersistence, type Persistence } from './persistence';
import { createPullRequestCommandService, type PullRequestCommandServerOptions } from './pull-request-command-service';

const databases: Persistence[] = []; const directories: string[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const command: PullRequestCommandV1 = { version: 1, requestId: '12345678-1234-4123-8123-123456789abc', repo: 'org/repo', number: 12,
  expectedHeadSha: 'a'.repeat(40), event: 'COMMENT', body: '  My review.\n\n_Helmsman · not reported - not reported_\n' };
const caller = 'example.reviews/review';
const artifact = { pluginId: 'example.provider', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] };
const binding: ProviderBinding = { role: 'effect', capability: 'helmsman/pull-request', contractVersion: 1, contributionId: 'example.provider/pr',
  pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: 'connection-a', credentialHandle: 'credential-a' };
const target = { repo: command.repo, prNumber: command.number, headSha: command.expectedHeadSha, actor: 'reviewer' };
function fixture(path = ':memory:') {
  const persistence = openPersistence(path); databases.push(persistence);
  const executions = openExecutionStore(persistence); const operations = openOperationStore(persistence, executions);
  const remote = { available: true, admission: true, loseReceipt: false, deny: false, malformed: false, observed: [] as string[], reviews: new Map<string, object>() };
  const invoke = vi.fn(async (operation: DurableOperation): Promise<OperationResult> => {
    expect(operations.get(operation.id)?.payload).toMatchObject({ caller, command });
    expect(executions.pins().some(pin => pin.ownerId === operation.id)).toBe(true);
    if (remote.deny) return { status: 'definitely-not-applied', retryable: false, evidence: { status: 422 }, reason: 'Head changed.' };
    const receipt = { ...target, reviewId: 42, marker: operation.id };
    remote.reviews.set(operation.id, receipt);
    if (remote.loseReceipt) throw new Error('Response lost');
    return { status: 'acknowledged', receipt: remote.malformed ? { reviewId: 42 } : receipt };
  });
  const reconcile = vi.fn(async (operation: DurableOperation): Promise<OperationResult> => {
    remote.observed.push(operation.id);
    const receipt = remote.reviews.get(operation.id);
    return receipt ? { status: 'acknowledged', receipt: receipt as never } : { status: 'unknown', evidence: null, reason: 'Review not yet found.' };
  });
  const prepareReview = vi.fn(async () => ({ binding, artifacts: [artifact], target }));
  const options: PullRequestCommandServerOptions = { persistence, operations, repos: () => ['org/repo', 'other/repo'],
    authorize: authorized => { if (authorized !== caller && authorized !== 'other.reviews/review') throw new Error('forbidden'); },
    assertAdmission: () => { if (!remote.admission) throw new Error('Admission disabled'); }, prepareReview,
    resolve: async operation => remote.available ? { kind: 'pull-request.review', binding: operation.binding, delivery: 'reconcile', invoke, reconcile } : null };
  return { persistence, executions, operations, remote, invoke, reconcile, prepareReview, options, service: createPullRequestCommandService(options) };
}
describe('durable public review commands', () => {
  it('binds exact caller, content, actor, head and provider before sending once', async () => {
    const f = fixture();
    const receipt = await f.service.submit(caller, command, command.repo);
    expect(receipt).toEqual({ version: 1, requestId: command.requestId, input: { version: 1, repo: command.repo, number: command.number, expectedHeadSha: command.expectedHeadSha, event: command.event, body: command.body }, status: 'succeeded', reason: null,
      result: { repo: command.repo, number: command.number, headSha: command.expectedHeadSha, actor: target.actor, reviewId: 42 } });
    expect(await f.service.submit(caller, command, null)).toEqual(receipt);
    expect(f.prepareReview).toHaveBeenCalledTimes(1); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.operations.list()[0]).toMatchObject({ binding, artifacts: [artifact], target, payload: { caller, command } });
    expect(f.executions.pins()).toEqual([]);
  });
  it('never authorizes another caller or galleon to query an existing command', async () => {
    const f = fixture(); await f.service.submit(caller, command, null);
    expect(f.service.receipt('other.reviews/review', { repo: command.repo, requestId: command.requestId }, null)).toBeNull();
    expect(() => f.service.receipt(caller, { repo: 'other/repo', requestId: command.requestId }, null)).toThrow('not-found');
    await expect(f.service.submit(caller, { ...command, body: 'changed' }, null)).rejects.toThrow('content changed');
    await expect(f.service.submit(caller, command, 'other/repo')).rejects.toThrow('not-found');
    await expect(f.service.retry('bad', { repo: command.repo, requestId: command.requestId }, null)).rejects.toThrow('forbidden');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('never creates a fresh operation for an unknown retry ID', async () => {
    const f = fixture();
    await expect(f.service.retry(caller, { repo: command.repo, requestId: command.requestId }, null)).rejects.toThrow('not-found');
    expect(f.operations.list()).toEqual([]); expect(f.prepareReview).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('coalesces concurrent submissions through the durable lease', async () => {
    const f = fixture();
    const receipts = await Promise.all([f.service.submit(caller, command, null), f.service.submit(caller, command, null)]);
    expect(receipts.some(receipt => receipt.status === 'succeeded')).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.operations.list()).toHaveLength(1);
  });
  it('reconciles lost replies through a closed database and restart without replaying a write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-command-')); directories.push(directory); const path = join(directory, 'state.sqlite');
    const f = fixture(path); f.remote.loseReceipt = true;
    const receipt = await f.service.submit(caller, command, null);
    expect(receipt.status).toBe('recovery-required'); expect(f.invoke).toHaveBeenCalledTimes(1);
    const operation = f.operations.list()[0]!;
    f.persistence.close(); databases.splice(databases.indexOf(f.persistence), 1);
    const restarted = fixture(path); restarted.remote.reviews = f.remote.reviews;
    restarted.remote.admission = false;
    expect(await restarted.service.retry(caller, { repo: command.repo, requestId: command.requestId }, null)).toMatchObject({ status: 'succeeded', result: { reviewId: 42 } });
    expect(restarted.remote.observed).toEqual([operation.id]); expect(restarted.invoke).not.toHaveBeenCalled(); expect(restarted.prepareReview).not.toHaveBeenCalled();
    expect(restarted.operations.list()[0]?.binding).toEqual(binding);
  });
  it('retains unavailable and replaced provider obligations without selecting a new provider', async () => {
    const f = fixture(); f.remote.loseReceipt = true;
    await f.service.submit(caller, command, null); f.remote.available = false;
    const query = { repo: command.repo, requestId: command.requestId };
    expect((await f.service.retry(caller, query, null)).status).toBe('recovery-required');
    expect(f.operations.list()[0]?.requiresReconciliation).toBe(true);
    const replacement = createPullRequestCommandService({ ...f.options, resolve: async () => ({ kind: 'pull-request.review',
      binding: { ...binding, artifactHash: 'c'.repeat(64) }, delivery: 'reconcile', invoke: f.invoke, reconcile: f.reconcile }) });
    expect((await replacement.retry(caller, query, null)).status).toBe('recovery-required');
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.reconcile).not.toHaveBeenCalled(); expect(f.prepareReview).toHaveBeenCalledTimes(1);
    f.remote.available = true;
    expect((await f.service.retry(caller, query, null)).status).toBe('succeeded');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps missing reconciliation evidence unresolved and never invokes again', async () => {
    const f = fixture(); f.remote.loseReceipt = true;
    await f.service.submit(caller, command, null); f.remote.reviews.clear();
    await f.service.drainPending(); await f.service.drainPending();
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.service.receipt(caller, { repo: command.repo, requestId: command.requestId }, null)?.status).toBe('recovery-required');
  });
  it('keeps definite denials unresolved while the operation can be reopened by an operator', async () => {
    const f = fixture(); f.remote.deny = true;
    expect((await f.service.submit(caller, command, null)).status).toBe('recovery-required');
    expect((await f.service.retry(caller, { repo: command.repo, requestId: command.requestId }, null)).status).toBe('recovery-required');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched preparation before enqueue or remote mutation', async () => {
    const f = fixture(); f.prepareReview.mockResolvedValue({ binding, artifacts: [artifact], target: { ...target, headSha: 'c'.repeat(40) } });
    await expect(f.service.submit(caller, command, null)).rejects.toThrow('target changed');
    expect(f.operations.list()).toEqual([]); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('allows the retained original command to be delivered after preparation failed before admission', async () => {
    const f = fixture(); f.prepareReview.mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(f.service.submit(caller, command, null)).rejects.toThrow('Read unavailable');
    expect(f.operations.list()).toEqual([]); expect(f.invoke).not.toHaveBeenCalled();
    expect((await f.service.submit(caller, command, null)).status).toBe('succeeded');
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.operations.list()).toHaveLength(1);
  });
  it('rechecks admission after asynchronous preparation before persisting', async () => {
    const f = fixture();
    f.prepareReview.mockImplementation(async () => { f.remote.admission = false; return { binding, artifacts: [artifact], target }; });
    await expect(f.service.submit(caller, command, null)).rejects.toThrow('Admission disabled');
    expect(f.operations.list()).toEqual([]); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('does not call malformed completions or operator notes successful reviews', async () => {
    const f = fixture(); f.remote.malformed = true;
    expect((await f.service.submit(caller, command, null)).status).toBe('recovery-required');
    expect(f.service.receipt(caller, { repo: command.repo, requestId: command.requestId }, null)?.status).toBe('recovery-required');
    const uncertain = fixture(); uncertain.remote.loseReceipt = true;
    await uncertain.service.submit(caller, command, null);
    uncertain.operations.resolve(uncertain.operations.list()[0]!.id, { outcome: 'acknowledged', actor: 'operator', reason: 'Reviewed manually', evidence: { reviewId: 42 } });
    expect(uncertain.service.receipt(caller, { repo: command.repo, requestId: command.requestId }, null)?.status).toBe('recovery-required');
  });
});
