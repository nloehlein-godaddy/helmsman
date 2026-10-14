import { parsePullRequestCommandInputV1, parsePullRequestCommandV1, type PullRequestCommandInputV1 } from '../../src/plugins/pull-request-command';
import { formatPullRequestReviewBody, type PullRequestHttpV1, type PullRequestReviewOperationResultV1 } from '../../src/plugins/pull-request-provider';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import type { OperationAdapter, OperationContext, OperationResolver } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';
import type { PullRequestProviderRegistry } from './pull-request-providers';
import { pluginJson } from './plugins/data';

type ReviewTarget = { repo: string; prNumber: number; headSha: string; actor: string };
type ReviewPayload = { repo: string; number: number; event: PullRequestCommandInputV1['event']; body: string; manual: true; expectedHeadSha: string };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, maximum = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) return null;
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function snapshotRequest(value: unknown): Parameters<PullRequestHttpV1['request']>[0] {
  const request = plainObject(value); const query = plainObject(request?.query);
  if (!request || !query || !exactKeys(request, ['body', 'method', 'path', 'query'])) throw new Error('Invalid pull request provider request.');
  const copiedQuery: Record<string, string> = {};
  for (const [key, item] of Object.entries(query)) {
    if (typeof item !== 'string') throw new Error('Invalid pull request provider request.');
    copiedQuery[key] = item;
  }
  return Object.freeze({ method: request.method as 'GET' | 'POST', path: request.path as string,
    query: Object.freeze(copiedQuery), body: request.body });
}

function registryBinding(binding: ProviderBinding) {
  return { providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
}

function sameBinding(first: ProviderBinding, second: ProviderBinding | null): boolean {
  return second !== null && first.role === second.role && first.capability === second.capability && first.contractVersion === second.contractVersion
    && first.contributionId === second.contributionId && first.pluginId === second.pluginId && first.artifactHash === second.artifactHash
    && first.connectionId === second.connectionId && first.credentialHandle === second.credentialHandle;
}

function target(value: unknown): ReviewTarget {
  const input = object(value);
  if (!input || !text(input.repo, 256) || !positive(input.prNumber) || !sha(input.headSha) || !text(input.actor, 128)) throw new Error('Invalid recorded pull request review target');
  return { repo: input.repo, prNumber: input.prNumber, headSha: input.headSha, actor: input.actor };
}

function payload(value: unknown): ReviewPayload {
  const input = object(value);
  if (!input || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(String(input.event)) || typeof input.body !== 'string' || input.body.length > 64_000
    || input.manual !== true || !sha(input.expectedHeadSha)) throw new Error('Invalid recorded pull request review payload');
  const command = parsePullRequestCommandV1(input.command);
  if (command.event !== input.event || command.body !== input.body || command.expectedHeadSha !== input.expectedHeadSha) throw new Error('Recorded pull request review command differs from its payload.');
  return { repo: command.repo, number: command.number, event: command.event, body: command.body, manual: true, expectedHeadSha: command.expectedHeadSha };
}

function reviewRequest(operation: DurableOperation, target: ReviewTarget, input: ReviewPayload): Parameters<PullRequestHttpV1['request']>[0] {
  return Object.freeze({ method: 'POST' as const, path: `/repos/${target.repo}/pulls/${target.prNumber}/reviews`, query: Object.freeze({}), body: Object.freeze({
    event: input.event, body: formatPullRequestReviewBody({ id: operation.id, contentHash: operation.contentHash, body: input.body }), commit_id: target.headSha,
  }) });
}

function matchesReviewRequest(value: unknown, expected: Parameters<PullRequestHttpV1['request']>[0]): boolean {
  const request = plainObject(value); const expectedBody = plainObject(expected.body); const body = plainObject(request?.body);
  if (!request || !expectedBody || !body || !exactKeys(request, ['body', 'method', 'path', 'query']) || !exactKeys(body, ['body', 'commit_id', 'event'])) return false;
  const query = plainObject(request.query);
  return request.method === expected.method && request.path === expected.path && query !== null && exactKeys(query, [])
    && body.event === expectedBody.event && body.body === expectedBody.body && body.commit_id === expectedBody.commit_id;
}

function result(value: PullRequestReviewOperationResultV1, expected: ReviewTarget): OperationResult {
  if (!value || typeof value !== 'object' || !['acknowledged', 'definitely-not-applied', 'unknown'].includes(value.status)) throw new Error('Invalid pull request provider result');
  if (value.status === 'acknowledged') {
    const receipt = object(value.receipt);
    if (!receipt || !text(receipt.repo, 256) || !positive(receipt.prNumber) || !sha(receipt.headSha) || !text(receipt.actor, 128) || !positive(receipt.reviewId)
      || receipt.repo !== expected.repo || receipt.prNumber !== expected.prNumber || receipt.headSha !== expected.headSha || receipt.actor !== expected.actor) throw new Error('Invalid pull request provider receipt');
    return { status: 'acknowledged', receipt: { repo: receipt.repo, prNumber: receipt.prNumber, headSha: receipt.headSha, actor: receipt.actor, reviewId: receipt.reviewId } };
  }
  if (!text(value.reason, 4096) || value.evidence === undefined || value.evidence === null || typeof value.evidence !== 'object') throw new Error('Invalid pull request provider result');
  return value.status === 'definitely-not-applied'
    ? (() => { if (typeof value.retryable !== 'boolean') throw new Error('Invalid pull request provider retryability'); return { status: 'definitely-not-applied' as const, retryable: value.retryable, reason: value.reason, evidence: pluginJson(value.evidence) }; })()
    : { status: 'unknown', reason: value.reason, evidence: pluginJson(value.evidence) };
}

export interface PullRequestProviderEffects {
  prepareReview(input: PullRequestCommandInputV1, signal?: AbortSignal): Promise<{ binding: ProviderBinding; artifacts: readonly ArtifactBinding[]; target: ReviewTarget }>;
  resolve: OperationResolver;
}

export function createPullRequestProviderEffects(options: {
  registry: PullRequestProviderRegistry;
  selected(): ProviderBinding | null;
  artifacts(binding: ProviderBinding): readonly ArtifactBinding[];
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  http(binding: ProviderBinding, signal: AbortSignal, mutation: boolean): PullRequestHttpV1;
  authorize?(binding: ProviderBinding, operation: DurableOperation, context: OperationContext): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  assertAdmission?(): void;
  onReviewAcknowledged?(): void;
}): PullRequestProviderEffects {
  function admission(binding: ProviderBinding) {
    if (!binding || binding.role !== 'effect' || binding.capability !== 'helmsman/pull-request' || binding.contractVersion !== 1
      || binding.connectionId === null || binding.credentialHandle === null) throw new Error('Selected pull request provider binding is invalid.');
    return options.registry.resolve(registryBinding(binding), 'admission');
  }
  async function prepareReview(input: PullRequestCommandInputV1, signal = new AbortController().signal) {
    const command = parsePullRequestCommandInputV1(input); options.assertAdmission?.(); signal.throwIfAborted();
    const binding = options.selected(); if (!binding) throw new Error('No pull request provider is selected.');
    const registration = admission(binding); const artifacts = options.artifacts(binding);
    if (!Array.isArray(artifacts) || !artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) throw new Error('Selected pull request provider artifacts are unavailable.');
    await options.verifyArtifacts(artifacts); signal.throwIfAborted(); options.assertAdmission?.();
    const prepared = await registration.provider.prepareReview({ repo: command.repo, number: command.number, expectedHeadSha: command.expectedHeadSha }, { signal, http: options.http(binding, signal, false) });
    if (!prepared || prepared.repo !== command.repo || prepared.number !== command.number || prepared.headSha !== command.expectedHeadSha || !text(prepared.actor, 128)) throw new Error('Pull request provider did not preserve the approved revision.');
    options.assertAdmission?.();
    if (!sameBinding(binding, options.selected())) throw new Error('Selected pull request provider changed during preparation.');
    admission(binding);
    return Object.freeze({ binding, artifacts: Object.freeze([...artifacts]), target: Object.freeze({ repo: prepared.repo, prNumber: prepared.number, headSha: prepared.headSha, actor: prepared.actor }) });
  }
  const resolve: OperationResolver = async (operation, signal) => {
    if (operation.kind !== 'pull-request.review' || operation.origin.kind !== 'public-pull-request-review' || operation.origin.runId !== null || operation.origin.attempt !== null) return null;
    const binding = operation.binding;
    if (binding.role !== 'effect' || binding.capability !== 'helmsman/pull-request' || binding.contractVersion !== 1 || binding.connectionId === null || binding.credentialHandle === null) return null;
    let registration;
    try { registration = options.registry.resolve(registryBinding(binding), 'obligation'); } catch { return null; }
    const reviewTarget = target(operation.target); const reviewPayload = payload(operation.payload);
    if (reviewTarget.repo !== reviewPayload.repo || reviewTarget.prNumber !== reviewPayload.number || reviewTarget.headSha !== reviewPayload.expectedHeadSha
      || !operation.artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) return null;
    await options.verifyArtifacts(operation.artifacts); signal.throwIfAborted();
    const execute = async (method: 'invokeReview' | 'reconcileReview', live: DurableOperation, context: OperationContext) => {
      const mutation = method === 'invokeReview'; const upstream = options.http(binding, context.signal, mutation);
      const http: PullRequestHttpV1 = Object.freeze({ request: async (input: Parameters<PullRequestHttpV1['request']>[0]) => {
        context.signal.throwIfAborted(); const requested = snapshotRequest(input);
        if (requested.method === 'POST') {
          if (!mutation) throw new Error('Pull request reconciliation cannot mutate remote state.');
          const expected = reviewRequest(live, reviewTarget, reviewPayload);
          if (!matchesReviewRequest(requested, expected)) throw new Error('Pull request provider attempted an unbound review mutation.');
          const authorization = await options.authorize?.(binding, live, context);
          context.signal.throwIfAborted();
          if (authorization && !authorization.allowed) throw new Error(authorization.reason);
          return upstream.request(expected);
        }
        const response = await upstream.request(requested); context.signal.throwIfAborted(); return response;
      } });
      const outcome = result(await registration.provider[method]({ id: live.id, contentHash: live.contentHash,
        repo: reviewTarget.repo, number: reviewTarget.prNumber, headSha: reviewTarget.headSha, actor: reviewTarget.actor, event: reviewPayload.event, body: reviewPayload.body }, { signal: context.signal, http }), reviewTarget);
      if (outcome.status === 'acknowledged') options.onReviewAcknowledged?.();
      return outcome;
    };
    return Object.freeze<OperationAdapter>({ binding, kind: 'pull-request.review', delivery: 'reconcile',
      ...(options.authorize ? { authorize: (live, context) => options.authorize!(binding, live, context) } : {}),
      invoke: (live, context) => execute('invokeReview', live, context), reconcile: (live, context) => execute('reconcileReview', live, context) });
  };
  return Object.freeze({ prepareReview, resolve });
}
