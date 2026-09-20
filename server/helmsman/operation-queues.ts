import type { PluginJson } from '../../src/plugins/backend';
import type { ProviderBinding } from './execution-store';
import type { OperationAdapter, OperationContext } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';
import { persistedJson, stableJson } from './persistence';
import { SlackReviewError } from './slack/review-request';
import { isGithubRepo } from '../pr-lists';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unknown = (reason: string): OperationResult => ({ status: 'unknown', reason, evidence: { code: 'queue-receipt-unavailable' } });

export interface SlackOperationReceipt {
  requestId: string; repo: string; prNumber: number; channelTarget: string; mentionTarget: string;
  status: 'pending' | 'sent' | 'failed' | 'uncertain'; channel: string | null; mention: string | null; permalink: string | null;
}
export interface SlackOperationTarget { requestId: string; workspace: string; channel: string; mention: string; repo: string; prNumber: number; }

export function createSlackReviewOperationAdapter(options: {
  binding: ProviderBinding;
  currentTarget(): { workspace: string; channel: string; mention: string } | null;
  receipt(requestId: string): SlackOperationReceipt | null;
  request(input: { requestId: string; repo: string; prNumber: number }): Promise<unknown>;
}): OperationAdapter {
  function target(operation: DurableOperation): SlackOperationTarget {
    const value = object(operation.target);
    if (!value || typeof value.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.requestId)
      || !text(value.workspace) || !text(value.channel) || !text(value.mention) || !text(value.repo) || !isGithubRepo(value.repo)
      || typeof value.prNumber !== 'number' || !Number.isSafeInteger(value.prNumber) || value.prNumber < 1) throw new Error('Invalid pinned Slack review target');
    return { requestId: value.requestId, workspace: value.workspace, channel: value.channel, mention: value.mention, repo: value.repo, prNumber: value.prNumber };
  }
  function receipt(value: SlackOperationTarget): OperationResult | null {
    const prior = options.receipt(value.requestId);
    if (!prior) return null;
    if (prior.requestId !== value.requestId || prior.repo !== value.repo || prior.prNumber !== value.prNumber
      || prior.channelTarget !== value.channel || prior.mentionTarget !== value.mention) return unknown('Persisted Slack receipt belongs to a different target.');
    if (prior.status === 'sent') return { status: 'acknowledged', receipt: persistedJson({ ...prior, workspace: value.workspace }) };
    if (prior.status === 'failed') return { status: 'definitely-not-applied', retryable: true, reason: 'Slack requester recorded definite failure before delivery.', evidence: { requestId: prior.requestId, status: prior.status } };
    return unknown('Existing Slack delivery is pending or uncertain; automatic resend is prohibited.');
  }
  return {
    kind: 'slack.review-request', binding: options.binding, delivery: 'reconcile',
    async reconcile(operation) {
      try { return receipt(target(operation)) ?? unknown('No Slack receipt proves delivery or non-delivery.'); }
      catch { return unknown('Pinned Slack receipt cannot be read.'); }
    },
    async invoke(operation, context) {
      let attempted = false;
      try {
        const value = target(operation);
        const current = options.currentTarget();
        if (!current || current.workspace !== value.workspace || current.channel !== value.channel || current.mention !== value.mention) {
          return { status: 'definitely-not-applied', retryable: false, reason: 'Pinned Slack workspace, channel, or mention is unavailable.', evidence: { code: 'slack-target-changed' } };
        }
        const prior = receipt(value);
        if (prior && prior.status !== 'definitely-not-applied') return prior;
        context.signal.throwIfAborted();
        attempted = true;
        await options.request({ requestId: value.requestId, repo: value.repo, prNumber: value.prNumber });
        return receipt(value) ?? unknown('Slack requester returned without its durable receipt.');
      } catch (error) {
        if (!attempted || error instanceof SlackReviewError && !error.uncertain) return { status: 'definitely-not-applied', retryable: false,
          reason: 'Slack request was rejected before delivery.', evidence: { code: 'slack-not-sent' } };
        return unknown('Slack delivery may have occurred; check its existing request receipt before retrying.');
      }
    },
  };
}

export interface QueueProjectionReceipt { key: string; content: PluginJson; receipt: PluginJson; }
export function createQueueProjectionOperationAdapter(options: {
  binding: ProviderBinding; kind: string;
  lookup(key: string): QueueProjectionReceipt | null;
  project(operation: DurableOperation, context: OperationContext): Promise<QueueProjectionReceipt> | QueueProjectionReceipt;
}): OperationAdapter {
  const match = (operation: DurableOperation, receipt: QueueProjectionReceipt): OperationResult => {
    if (receipt.key !== operation.key || stableJson(receipt.content) !== stableJson({ target: operation.target, payload: operation.payload })) {
      return { status: 'blocked', reason: 'Existing queue projection conflicts with the immutable operation.', evidence: { code: 'projection-conflict' } };
    }
    return { status: 'acknowledged', receipt: persistedJson({ key: receipt.key, receipt: receipt.receipt }) };
  };
  return {
    kind: options.kind, binding: options.binding, delivery: 'idempotent',
    async reconcile(operation) {
      try {
        const prior = options.lookup(operation.key);
        return prior ? match(operation, prior) : { status: 'definitely-not-applied', retryable: true,
          reason: 'Stable-ID local queue projection is absent and may be idempotently restored.', evidence: { key: operation.key } };
      } catch { return unknown('Local queue projection cannot be verified.'); }
    },
    async invoke(operation, context) {
      try {
        const prior = options.lookup(operation.key);
        if (prior) return match(operation, prior);
        context.signal.throwIfAborted();
        return match(operation, await options.project(operation, context));
      } catch { return unknown('Local queue projection was interrupted; reconcile its stable identity.'); }
    },
  };
}
