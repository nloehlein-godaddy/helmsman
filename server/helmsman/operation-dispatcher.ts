import type { ProviderBinding } from './execution-store';
import type { DurableOperation, OperationResult, OperationStore } from './operations';
import { PersistenceConflictError, stableJson } from './persistence';

export interface OperationContext { signal: AbortSignal; idempotencyKey: string; generation: number; }
export interface OperationAdapter {
  readonly binding: ProviderBinding;
  readonly kind: string;
  readonly delivery: 'reconcile' | 'idempotent';
  authorize?(operation: DurableOperation, context: OperationContext): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  invoke(operation: DurableOperation, context: OperationContext): Promise<OperationResult>;
  reconcile(operation: DurableOperation, context: OperationContext): Promise<OperationResult>;
}
export type OperationResolver = (operation: DurableOperation, signal: AbortSignal) => Promise<OperationAdapter | null> | OperationAdapter | null;

export async function dispatchOperation(store: OperationStore, id: string, resolve: OperationResolver, options: {
  timeoutMs?: number; leaseMs?: number; reconcile?: boolean;
} = {}): Promise<DurableOperation> {
  store.assertDispatchAllowed();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const leaseMs = options.leaseMs ?? Math.min(300_000, timeoutMs * 3 + 1000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(leaseMs) || leaseMs <= timeoutMs || leaseMs > 300_000) throw new Error('Invalid operation dispatcher timeout or lease');
  const current = () => {
    const operation = store.get(id);
    if (!operation) throw new PersistenceConflictError('Operation is missing');
    return operation;
  };
  const lease = store.lease(id, leaseMs, { reconcile: options.reconcile });
  if (!lease) return current();
  const controller = new AbortController();
  const context: OperationContext = Object.freeze({ signal: controller.signal, idempotencyKey: id, generation: lease.generation });
  let invoked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function settle(result: OperationResult): DurableOperation {
    try { return store.settle(lease!, result); }
    catch (error) { if (error instanceof PersistenceConflictError) return current(); throw error; }
  }
  const work = async (): Promise<OperationResult> => {
    const operation = current();
    const adapter = await resolve(operation, controller.signal);
    controller.signal.throwIfAborted();
    if (!adapter || adapter.kind !== operation.kind || stableJson(adapter.binding) !== stableJson(operation.binding)) {
      return { status: 'blocked', reason: 'The recorded operation provider or connection is unavailable.', evidence: { code: 'binding-unavailable' } };
    }
    if (lease.requiresReconciliation) return adapter.reconcile(operation, context);
    if (operation.deliveryAttempts >= operation.retry.maxAttempts) return { status: 'blocked', reason: 'Operation delivery attempts are exhausted.', evidence: { code: 'attempts-exhausted' } };
    if (adapter.authorize) {
      const authorization = await adapter.authorize(operation, context);
      controller.signal.throwIfAborted();
      if (!authorization?.allowed) return { status: 'blocked', reason: authorization?.reason ?? 'Current publication authorization is unavailable.', evidence: { code: 'authorization-blocked' } };
    }
    store.markInvoked(lease);
    invoked = true;
    return adapter.invoke(current(), context);
  };
  try {
    const result = await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Operation delivery timed out.')); }, timeoutMs);
    })]);
    return settle(result);
  } catch (error) {
    if (error instanceof PersistenceConflictError) return current();
    return settle({ status: invoked || lease.requiresReconciliation ? 'unknown' : 'blocked',
      reason: invoked || lease.requiresReconciliation ? 'Delivery or reconciliation did not produce reliable acknowledgment.' : 'Operation provider preparation failed.',
      evidence: { code: controller.signal.aborted ? 'timeout' : 'adapter-failed' } });
  } finally { clearTimeout(timer); controller.abort(); }
}
