// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openOperationStore, type OperationDraft } from './operations';
import { dispatchOperation, type OperationAdapter } from './operation-dispatcher';

const roots: string[] = [];
const databases: Persistence[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function draft(key = 'run:1:review'): OperationDraft {
  return { version: 1, key, kind: 'github.review', origin: { kind: 'run-completion', id: 'run', revision: '1', runId: 'run', attempt: 1 },
    binding: { role: 'effect', capability: 'helmsman/review', contractVersion: 1, contributionId: 'helmsman.github/review', pluginId: 'helmsman.github', artifactHash: 'a'.repeat(64), connectionId: 'github:owner', credentialHandle: 'github-token:owner' },
    artifacts: [{ pluginId: 'helmsman.github', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] }],
    target: { repo: 'org/repo', prNumber: 1, headSha: 'b'.repeat(40) }, payload: { body: 'review body' }, retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 } };
}
function fixture(path = ':memory:') {
  const persistence = openPersistence(path); databases.push(persistence);
  const executions = openExecutionStore(persistence);
  let time = Date.parse('2026-09-20T00:00:00.000Z');
  const operations = openOperationStore(persistence, executions, { now: () => time });
  return { persistence, executions, operations, advance: (ms: number) => { time += ms; } };
}
function adapter(input: OperationDraft, overrides: Partial<OperationAdapter> = {}): OperationAdapter {
  return { kind: input.kind, binding: input.binding, delivery: 'reconcile',
    invoke: async () => ({ status: 'acknowledged', receipt: { remoteId: '123' } }),
    reconcile: async () => ({ status: 'unknown', reason: 'No reliable receipt', evidence: { checked: true } }), ...overrides };
}

describe('durable operation ledger', () => {
  it('keeps definite nonretryable failure blocked until explicit operator retry', async () => {
    const { operations } = fixture();
    const input = draft();
    const operation = operations.enqueue(input);
    const invoke = vi.fn(async () => ({ status: 'definitely-not-applied' as const, retryable: false, evidence: { conflict: true }, reason: 'External state changed' }));
    const provider = adapter(input, { invoke });
    await dispatchOperation(operations, operation.id, () => provider, { reconcile: true });
    await dispatchOperation(operations, operation.id, () => provider, { reconcile: true });
    expect(invoke).toHaveBeenCalledOnce();
    operations.retry(operation.id, { actor: 'operator', reason: 'Conflict resolved', evidence: { confirmed: true } });
    await dispatchOperation(operations, operation.id, () => provider, { reconcile: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('joins the origin transaction, preserves immutable identity, and rolls pins back with admission', () => {
    const { persistence, executions, operations } = fixture();
    expect(() => persistence.transaction(() => { operations.enqueue(draft()); throw new Error('origin rollback'); })).toThrow('origin rollback');
    expect(operations.list()).toEqual([]);
    expect(executions.pins()).toEqual([]);
    const operation = operations.enqueue(draft());
    expect(operations.enqueue({ ...draft(), payload: { body: 'review body' } })).toEqual(operation);
    expect(executions.pins()).toEqual([{ kind: 'operation', ownerId: operation.id, pluginId: 'helmsman.github', artifactHash: 'a'.repeat(64) }]);
    expect(() => operations.enqueue({ ...draft(), target: { repo: 'other/repo' } })).toThrow('different');
    expect(() => operations.enqueue({ ...draft(), binding: { ...draft().binding, connectionId: 'other' } })).toThrow('different');
    expect(() => executions.releasePins('operation', operation.id)).toThrow();
  });

  it('acquires transitive pins and rejects missing/cyclic dependencies', () => {
    const { operations, executions } = fixture();
    const input = draft();
    input.artifacts = [{ ...input.artifacts[0]!, requires: ['helmsman.transport'] }, { pluginId: 'helmsman.transport', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] }];
    operations.enqueue(input);
    expect(executions.pins()).toHaveLength(2);
    expect(() => operations.enqueue({ ...input, key: 'missing', artifacts: [input.artifacts[0]!] })).toThrow('missing');
    expect(() => operations.enqueue({ ...input, key: 'cycle', artifacts: [input.artifacts[0]!, { ...input.artifacts[1]!, requires: ['helmsman.github'] }] })).toThrow('cycle');
  });

  it('protects resources until a completed receipt settles the same pinned operation', () => {
    const { operations, executions } = fixture();
    const operation = operations.enqueue(draft());
    expect(executions.cleanupEligibility('run').allowed).toBe(false);
    const lease = operations.lease(operation.id, 100)!;
    operations.markInvoked(lease);
    operations.settle(lease, { status: 'acknowledged', receipt: { remoteId: 'review-1' } });
    expect(executions.pins()).toEqual([]);
    expect(operations.get(operation.id)).toMatchObject({ status: 'completed', receipt: { remoteId: 'review-1' }, deliveryAttempts: 1 });
    expect(operations.lease(operation.id, 100)).toBeNull();
  });

  it('fences stale receipts and requires reconciliation after invocation lease expiry', () => {
    const { operations, advance } = fixture();
    const operation = operations.enqueue(draft());
    const first = operations.lease(operation.id, 100)!;
    operations.markInvoked(first);
    advance(101);
    const second = operations.lease(operation.id, 100)!;
    expect(second).toMatchObject({ generation: 2, requiresReconciliation: true });
    expect(() => operations.settle(first, { status: 'acknowledged', receipt: { remoteId: 1 } })).toThrow('stale');
    expect(() => operations.markInvoked(second)).toThrow('reconciliation');
    operations.settle(second, { status: 'unknown', evidence: { remote: 'unavailable' }, reason: 'Cannot establish delivery' });
    expect(operations.get(operation.id)?.status).toBe('uncertain');
    expect(operations.attempts(operation.id).map(item => item.kind)).toEqual(['enqueued', 'leased', 'invoked', 'expired', 'leased', 'unknown']);
  });

  it('safely retries pre-invocation expiry and bounds definite non-delivery backoff', () => {
    const { operations, advance } = fixture();
    const operation = operations.enqueue(draft());
    operations.lease(operation.id, 100);
    advance(101);
    const lease = operations.lease(operation.id, 100)!;
    expect(lease.requiresReconciliation).toBe(false);
    operations.markInvoked(lease);
    operations.settle(lease, { status: 'definitely-not-applied', retryable: true, reason: 'Rejected before application', evidence: { status: 429 } });
    expect(operations.lease(operation.id, 100)).toBeNull();
    advance(100);
    const next = operations.lease(operation.id, 100)!;
    operations.markInvoked(next);
    expect(operations.settle(next, { status: 'definitely-not-applied', retryable: true, reason: 'Rejected again', evidence: { status: 429 } }).status).toBe('blocked');
  });

  it('requires dependencies completed and retains explicit operator evidence without rebinding', () => {
    const { operations, advance } = fixture();
    const first = operations.enqueue(draft());
    const second = operations.enqueue({ ...draft('dependent'), dependencies: [first.id] });
    expect(operations.lease(second.id, 100)).toBeNull();
    const lease = operations.lease(first.id, 100)!;
    operations.markInvoked(lease);
    expect(() => operations.resolve(first.id, { actor: 'operator', reason: 'receipt checked', evidence: { url: 'receipt' }, outcome: 'acknowledged' })).toThrow('live worker');
    advance(101);
    const done = operations.resolve(first.id, { actor: 'operator', reason: 'receipt checked', evidence: { url: 'receipt' }, outcome: 'acknowledged' });
    expect(done.binding).toEqual(first.binding);
    expect(operations.lease(second.id, 100)).not.toBeNull();
    expect(operations.attempts(first.id).at(-1)?.evidence).toMatchObject({ actor: 'operator', reason: 'receipt checked' });
  });

  it('preserves identities and uncertain effects across restart and rejects tampered content', () => {
    const root = mkdtempSync(join(tmpdir(), 'helmsman-operations-')); roots.push(root);
    const path = join(root, 'state.sqlite');
    const first = fixture(path);
    const operation = first.operations.enqueue(draft());
    const lease = first.operations.lease(operation.id, 100)!;
    first.operations.markInvoked(lease);
    first.persistence.close();
    const next = fixture(path);
    next.advance(101);
    expect(next.operations.lease(operation.id, 100)?.requiresReconciliation).toBe(true);
    expect(next.executions.pins()).toHaveLength(1);
    next.persistence.sql.prepare("UPDATE operations SET draft=json_set(draft,'$.target.repo','other/repo') WHERE id=?").run(operation.id);
    expect(() => next.operations.get(operation.id)).toThrow('invalid');
  });
});

describe('durable operation dispatcher', () => {
  it('does not dispatch until the originating transaction commits', async () => {
    const { persistence, operations } = fixture();
    const operation = operations.enqueue(draft());
    let pending: Promise<unknown> | undefined;
    persistence.transaction(() => { pending = dispatchOperation(operations, operation.id, () => adapter(draft())); });
    await expect(pending).rejects.toThrow('after');
    expect(operations.get(operation.id)?.status).toBe('pending');
  });

  it('blocks missing or changed connection binding and never calls current defaults', async () => {
    const { operations } = fixture();
    const operation = operations.enqueue(draft());
    const invoke = vi.fn();
    const result = await dispatchOperation(operations, operation.id, () => adapter(draft(), { invoke, binding: { ...draft().binding, connectionId: 'new-default' } }));
    expect(result.status).toBe('blocked');
    expect(invoke).not.toHaveBeenCalled();
    expect(result.deliveryAttempts).toBe(0);
  });

  it('reconciles remote success before acknowledgment without a second write', async () => {
    const { operations, advance } = fixture();
    const operation = operations.enqueue(draft());
    const first = operations.lease(operation.id, 100)!;
    operations.markInvoked(first);
    advance(101);
    const invoke = vi.fn();
    const reconcile = vi.fn(async () => ({ status: 'acknowledged' as const, receipt: { remoteId: 'already-created' } }));
    expect((await dispatchOperation(operations, operation.id, () => adapter(draft(), { invoke, reconcile }))).status).toBe('completed');
    expect(invoke).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('keeps timeout and late remote completion uncertain without repeating delivery', async () => {
    const { operations } = fixture();
    const operation = operations.enqueue(draft());
    let finish!: (value: { status: 'acknowledged'; receipt: { remoteId: string } }) => void;
    const invoke = vi.fn(() => new Promise<{ status: 'acknowledged'; receipt: { remoteId: string } }>(resolve => { finish = resolve; }));
    const provider = adapter(draft(), { invoke });
    expect((await dispatchOperation(operations, operation.id, () => provider, { timeoutMs: 10, leaseMs: 100 })).status).toBe('uncertain');
    finish({ status: 'acknowledged', receipt: { remoteId: 'late' } });
    await Promise.resolve();
    expect((await dispatchOperation(operations, operation.id, () => provider, { reconcile: true })).status).toBe('uncertain');
    expect(invoke).toHaveBeenCalledOnce();
  });
});
