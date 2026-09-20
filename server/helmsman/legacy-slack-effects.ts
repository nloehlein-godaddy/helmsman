import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { dispatchOperation, type OperationAdapter, type OperationResolver } from './operation-dispatcher';
import { createSlackReviewOperationAdapter } from './operation-queues';
import type { DurableOperation, OperationStore } from './operations';
import { persistenceHash, stableJson, type Persistence } from './persistence';
import { SlackReviewError, validateSlackReviewInput, type openSlackReviewRequester, type SlackReviewResult } from './slack/review-request';

export interface LegacySlackTarget { enabled: boolean; workspace: string; channel: string; mention: string; connectionId: string; }
export interface LegacySlackEffectsOptions {
  persistence: Persistence;
  operations: OperationStore;
  artifact: ArtifactBinding;
  requester: Pick<ReturnType<typeof openSlackReviewRequester>, 'request' | 'receipt'>;
  currentTarget(): LegacySlackTarget;
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  assertAdmission?(): void;
}
export interface LegacySlackEffects {
  request(input: unknown): Promise<SlackReviewResult>;
  dispatch(id: string): Promise<DurableOperation>;
  drainPending(): Promise<void>;
  resolve: OperationResolver;
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sameTarget = (first: LegacySlackTarget, second: LegacySlackTarget) => first.workspace === second.workspace && first.channel === second.channel
  && first.mention === second.mention && first.connectionId === second.connectionId;

export function createLegacySlackEffects(options: LegacySlackEffectsOptions): LegacySlackEffects {
  const { operations, requester } = options;
  const flights = new Map<string, { key: string; promise: Promise<SlackReviewResult> }>();
  const failures = new Map<string, SlackReviewError | undefined>();
  let draining: Promise<void> | null = null;
  const binding = (target: LegacySlackTarget): ProviderBinding => ({ role: 'effect', capability: 'slack', contractVersion: 1,
    contributionId: `${options.artifact.pluginId}/slack-browser-review`, pluginId: options.artifact.pluginId,
    artifactHash: options.artifact.artifactHash, connectionId: target.connectionId, credentialHandle: null });
  function target(): LegacySlackTarget {
    const value = options.currentTarget();
    if (!value?.enabled) throw new SlackReviewError('Slack integration is disabled. Enable it in Config.', 409);
    if (!/^[A-Z0-9]{3,32}$/.test(value.workspace) || !/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(value.channel)
      || !/^[a-z\d_-]{1,80}$/.test(value.mention) || !/^[a-f\d]{64}$/.test(value.connectionId)) {
      throw new SlackReviewError('Set a valid Slack workspace, review channel, and user group in Config.', 400);
    }
    return { ...value };
  }
  const resolver = (allowSend: boolean): OperationResolver => async (operation, signal) => {
    if (operation.kind !== 'slack.review-request' || operation.origin.kind !== 'slack-request' || operation.origin.runId !== null || operation.origin.attempt !== null) return null;
    const value = object(operation.target);
    if (!value || typeof value.workspace !== 'string' || typeof value.channel !== 'string' || typeof value.mention !== 'string'
      || typeof operation.binding.connectionId !== 'string') return null;
    const input = validateSlackReviewInput(value);
    const retained: LegacySlackTarget = { enabled: true, workspace: value.workspace, channel: value.channel, mention: value.mention, connectionId: operation.binding.connectionId };
    if (operation.origin.id !== input.requestId || operation.key !== `slack-request:${input.requestId}` || operation.origin.revision !== persistenceHash(operation.target)
      || stableJson(operation.binding) !== stableJson(binding(retained)) || stableJson(operation.artifacts) !== stableJson([options.artifact])) return null;
    await options.verifyArtifacts(operation.artifacts);
    signal.throwIfAborted();
    const readReceipt = () => {
      const receipt = requester.receipt(input.requestId);
      if (receipt && (receipt.workspaceTarget !== retained.workspace || receipt.connectionTarget !== retained.connectionId)) {
        throw new SlackReviewError('Recorded Slack receipt has another or unverified workspace connection.', 409, true);
      }
      return receipt;
    };
    const adapter = createSlackReviewOperationAdapter({ binding: operation.binding,
      currentTarget: () => {
        const current = options.currentTarget();
        return current?.enabled && sameTarget(current, retained) ? current : null;
      },
      receipt: readReceipt,
      request: async request => {
        try {
          return await requester.request(request, { binding: { workspace: retained.workspace, connectionId: retained.connectionId },
            beforeSend() {
              const current = options.currentTarget();
              if (!current?.enabled || !sameTarget(current, retained)) throw new SlackReviewError('Recorded Slack connection changed before delivery. Restore it before retrying.', 409);
              options.assertAdmission?.();
            } });
        } catch (error) {
          if (failures.has(input.requestId) && error instanceof SlackReviewError) failures.set(input.requestId, error);
          throw error;
        }
      },
    });
    const guarded: OperationAdapter = { ...adapter,
      async invoke(operation, context) {
        try { readReceipt(); }
        catch { return { status: 'unknown', reason: 'Legacy Slack receipt has no verified workspace binding.', evidence: { code: 'slack-receipt-binding-unavailable' } }; }
        return allowSend ? adapter.invoke(operation, context) : adapter.reconcile(operation, context);
      },
    };
    return guarded;
  };
  const resolve = resolver(false);
  const dispatch = (id: string) => dispatchOperation(operations, id, resolve, { reconcile: true });
  async function request(value: unknown): Promise<SlackReviewResult> {
    const input = validateSlackReviewInput(value);
    const destination = target();
    await options.verifyArtifacts([options.artifact]);
    let operation = options.persistence.transaction(() => {
      if (!sameTarget(target(), destination)) throw new SlackReviewError('Slack configuration changed while preparing the request.', 409);
      const key = `slack-request:${input.requestId}`;
      const existing = operations.byKey(key);
      const expectedTarget = { ...input, workspace: destination.workspace, channel: destination.channel, mention: destination.mention };
      if (existing) {
        if (stableJson(existing.target) !== stableJson(expectedTarget) || stableJson(existing.binding) !== stableJson(binding(destination))) {
          throw new SlackReviewError('Request ID already belongs to a different Slack review request or connection.', 409);
        }
        const receipt = requester.receipt(input.requestId);
        if (existing.status === 'blocked' && !existing.requiresReconciliation && receipt?.status === 'failed'
          && receipt.workspaceTarget === destination.workspace && receipt.connectionTarget === destination.connectionId) {
          return operations.retry(existing.id, { actor: 'requesting-user', reason: 'Explicit repeat of a definitely failed Slack request.',
            evidence: { requestId: input.requestId, receiptStatus: 'failed' } });
        }
        return existing;
      }
      options.assertAdmission?.();
      return operations.enqueue({ version: 1, key, kind: 'slack.review-request',
        origin: { kind: 'slack-request', id: input.requestId, revision: persistenceHash(expectedTarget), runId: null, attempt: null },
        binding: binding(destination), artifacts: [options.artifact], target: expectedTarget, payload: {} });
    });
    failures.set(input.requestId, undefined);
    try {
      operation = await dispatchOperation(operations, operation.id, resolver(true), { reconcile: true });
      const failure = failures.get(input.requestId);
      if (failure) throw failure;
      const receipt = requester.receipt(input.requestId);
      if (operation.status === 'completed' && receipt?.status === 'sent' && receipt.workspaceTarget === destination.workspace && receipt.connectionTarget === destination.connectionId) {
        return { ok: true, channel: receipt.channel ?? receipt.channelTarget, mention: receipt.mention ?? receipt.mentionTarget, permalink: receipt.permalink };
      }
      const uncertain = operation.requiresReconciliation || receipt?.status === 'pending' || receipt?.status === 'uncertain';
      throw new SlackReviewError(uncertain ? 'Delivery is pending or unconfirmed. Check Slack before requesting again.'
        : 'Slack delivery is blocked. Restore the recorded connection or use Recovery to reconcile the request.', 409, uncertain);
    } finally { failures.delete(input.requestId); }
  }
  return {
    resolve, dispatch,
    request(value) {
      let input;
      try { input = validateSlackReviewInput(value); } catch (error) { return Promise.reject(error); }
      const key = `${input.repo}#${input.prNumber}`;
      const existing = flights.get(input.requestId);
      if (existing) return existing.key === key ? existing.promise : Promise.reject(new SlackReviewError('Request ID is already in use.', 409));
      const promise = request(input).finally(() => flights.delete(input.requestId));
      flights.set(input.requestId, { key, promise });
      return promise;
    },
    drainPending() {
      draining ??= (async () => {
        for (const operation of operations.list({ statuses: ['pending', 'leased', 'retrying', 'blocked', 'uncertain'] })) {
          if (operation.kind === 'slack.review-request' && operation.origin.kind === 'slack-request') await dispatch(operation.id);
        }
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}
