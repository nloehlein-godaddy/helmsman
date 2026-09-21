import type { CommunicationBrowserSessionV1, CommunicationDestinationV1, CommunicationProviderContextV1, CommunicationProviderResultV1, CommunicationReviewRequestV1 } from '../../src/plugins/communication-provider';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import type { OperationAdapter, OperationContext, OperationResolver } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';
import type { CommunicationProviderRegistry } from './communication-providers';
import { pluginJson } from './plugins/data';

export type CommunicationReviewTargetV1 = { readonly repo: string; readonly number: number; readonly destination: CommunicationDestinationV1 };
export type CommunicationReviewPayloadV1 = { readonly caller: string; readonly requestId: string };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, maximum = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function destination(value: unknown): CommunicationDestinationV1 {
  const input = object(value);
  if (!input || !text(input.providerId, 192) || !/^[a-f\d]{64}$/.test(String(input.artifactHash))
    || !text(input.workspace, 128) || !text(input.channel, 128) || !text(input.mention, 128) || !text(input.connectionId, 4096)) throw new Error('Invalid communication destination.');
  return Object.freeze({ providerId: input.providerId, artifactHash: input.artifactHash as string, workspace: input.workspace,
    channel: input.channel, mention: input.mention, connectionId: input.connectionId });
}

function sameDestination(first: CommunicationDestinationV1, second: CommunicationDestinationV1 | null): boolean {
  return second !== null && first.providerId === second.providerId && first.artifactHash === second.artifactHash
    && first.workspace === second.workspace && first.channel === second.channel && first.mention === second.mention && first.connectionId === second.connectionId;
}

function sameBinding(first: ProviderBinding, second: ProviderBinding | null): boolean {
  return second !== null && first.role === second.role && first.capability === second.capability && first.contractVersion === second.contractVersion
    && first.contributionId === second.contributionId && first.pluginId === second.pluginId && first.artifactHash === second.artifactHash
    && first.connectionId === second.connectionId && first.credentialHandle === second.credentialHandle;
}

function registryBinding(binding: ProviderBinding) {
  return { providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash,
    contractVersion: 1 as const, connectionId: null, credentialHandle: null };
}

function target(value: unknown): CommunicationReviewTargetV1 {
  const input = object(value);
  if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid recorded communication review target.');
  return Object.freeze({ repo: input.repo, number: input.number, destination: destination(input.destination) });
}

function payload(value: unknown): CommunicationReviewPayloadV1 {
  const input = object(value);
  if (!input || !text(input.caller, 256) || !text(input.requestId, 256)) throw new Error('Invalid recorded communication review payload.');
  return Object.freeze({ caller: input.caller, requestId: input.requestId });
}

function result(value: CommunicationProviderResultV1, expected: CommunicationDestinationV1): OperationResult {
  if (!value || typeof value !== 'object' || !['acknowledged', 'definitely-not-applied', 'unknown'].includes(String(value.status))) throw new Error('Invalid communication provider result.');
  if (value.status === 'acknowledged') {
    const receipt = object(value.receipt);
    if (!receipt || !text(receipt.workspace, 128) || !text(receipt.channel, 128) || !text(receipt.mention, 128)
      || !text(receipt.connectionId, 4096) || receipt.permalink !== null && !text(receipt.permalink, 4096)
      || receipt.workspace !== expected.workspace || receipt.channel !== expected.channel || receipt.mention !== expected.mention || receipt.connectionId !== expected.connectionId) throw new Error('Invalid communication provider receipt.');
    return { status: 'acknowledged', receipt: { workspace: receipt.workspace, channel: receipt.channel, mention: receipt.mention,
      connectionId: receipt.connectionId, permalink: receipt.permalink } };
  }
  if (!text(value.reason, 4096) || value.evidence === undefined || value.evidence === null || typeof value.evidence !== 'object') throw new Error('Invalid communication provider result.');
  if (value.status === 'definitely-not-applied') {
    if (typeof value.retryable !== 'boolean') throw new Error('Invalid communication provider retryability.');
    return { status: 'definitely-not-applied', retryable: value.retryable, reason: value.reason, evidence: pluginJson(value.evidence) };
  }
  return { status: 'unknown', reason: value.reason, evidence: pluginJson(value.evidence) };
}

export interface CommunicationProviderEffects {
  prepareReviewRequest(input: { readonly repo: string; readonly number: number; readonly expectedDestination: CommunicationDestinationV1 }, signal?: AbortSignal): Promise<{
    readonly binding: ProviderBinding;
    readonly artifacts: readonly ArtifactBinding[];
    readonly target: CommunicationReviewTargetV1;
  }>;
  readonly resolve: OperationResolver;
}

export function createCommunicationProviderEffects(options: {
  readonly registry: CommunicationProviderRegistry;
  selected(): ProviderBinding | null;
  destination(binding: ProviderBinding): CommunicationDestinationV1 | null;
  artifacts(binding: ProviderBinding): readonly ArtifactBinding[];
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  session(binding: ProviderBinding, destination: CommunicationDestinationV1, signal: AbortSignal): { readonly surface: string | null; readonly watchedChannel: { readonly id: string; readonly name: string }; readonly browser: CommunicationBrowserSessionV1 };
  authorize?(binding: ProviderBinding, operation: DurableOperation, context: OperationContext): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  assertAdmission?(): void;
  withSession?<T>(work: () => Promise<T>): Promise<T>;
}): CommunicationProviderEffects {
  function admission(binding: ProviderBinding) {
    if (!binding || binding.role !== 'effect' || binding.capability !== 'helmsman/communication' || binding.contractVersion !== 1
      || binding.connectionId === null || binding.credentialHandle === null) throw new Error('Selected communication provider binding is invalid.');
    return options.registry.resolve(registryBinding(binding), 'admission');
  }
  function context(binding: ProviderBinding, configured: CommunicationDestinationV1, signal: AbortSignal, beforeSend: () => Promise<void>): CommunicationProviderContextV1 {
    const session = options.session(binding, configured, signal);
    if (!session || (session.surface !== null && !text(session.surface, 512)) || !text(session.watchedChannel?.id, 128) || !text(session.watchedChannel?.name, 128) || !session.browser) throw new Error('Communication browser session is unavailable.');
    return Object.freeze({ signal, destination: configured, surface: session.surface, watchedChannel: Object.freeze({ id: session.watchedChannel.id, name: session.watchedChannel.name }), browser: session.browser, beforeSend });
  }
  async function prepareReviewRequestCore(input: { readonly repo: string; readonly number: number; readonly expectedDestination: CommunicationDestinationV1 }, signal = new AbortController().signal) {
    if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid communication review request.');
    const expected = destination(input.expectedDestination); options.assertAdmission?.(); signal.throwIfAborted();
    const binding = options.selected(); if (!binding) throw new Error('No communication provider is selected.');
    const configured = options.destination(binding);
    if (!configured || !sameDestination(expected, configured) || configured.providerId !== binding.contributionId || configured.artifactHash !== binding.artifactHash || configured.connectionId !== binding.connectionId) throw new Error('Selected communication destination changed.');
    const registration = admission(binding); const artifacts = options.artifacts(binding);
    if (!Array.isArray(artifacts) || !artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) throw new Error('Selected communication provider artifacts are unavailable.');
    await options.verifyArtifacts(artifacts); signal.throwIfAborted(); options.assertAdmission?.();
    const prepared = await registration.provider.prepareReviewRequest({ repo: input.repo, number: input.number }, context(binding, configured, signal, async () => { throw new Error('Communication preparation cannot send.'); }));
    if (!prepared || prepared.workspace !== configured.workspace || prepared.channel !== configured.channel || prepared.mention !== configured.mention || prepared.connectionId !== configured.connectionId) throw new Error('Communication provider changed the configured destination.');
    options.assertAdmission?.();
    if (!sameBinding(binding, options.selected()) || !sameDestination(configured, options.destination(binding))) throw new Error('Selected communication provider changed during preparation.');
    admission(binding);
    return Object.freeze({ binding, artifacts: Object.freeze([...artifacts]), target: Object.freeze({ repo: input.repo, number: input.number, destination: configured }) });
  }
  const prepareReviewRequest: CommunicationProviderEffects['prepareReviewRequest'] = (input, signal) => {
    const work = () => prepareReviewRequestCore(input, signal);
    return options.withSession ? options.withSession(work) : work();
  };
  const resolve: OperationResolver = async (operation, signal) => {
    if (operation.kind !== 'communication.review-request' || operation.origin.kind !== 'public-communication-review-request' || operation.origin.runId !== null || operation.origin.attempt !== null) return null;
    const binding = operation.binding;
    if (binding.role !== 'effect' || binding.capability !== 'helmsman/communication' || binding.contractVersion !== 1 || binding.connectionId === null || binding.credentialHandle === null) return null;
    let registration;
    try { registration = options.registry.resolve(registryBinding(binding), 'obligation'); } catch { return null; }
    let reviewTarget: CommunicationReviewTargetV1; let reviewPayload: CommunicationReviewPayloadV1;
    try { reviewTarget = target(operation.target); reviewPayload = payload(operation.payload); } catch { return null; }
    if (reviewTarget.destination.providerId !== binding.contributionId || reviewTarget.destination.artifactHash !== binding.artifactHash || reviewTarget.destination.connectionId !== binding.connectionId
      || !operation.artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) return null;
    await options.verifyArtifacts(operation.artifacts); signal.throwIfAborted();
    const execute = async (method: 'invokeReviewRequest' | 'reconcileReviewRequest', live: DurableOperation, operationContext: OperationContext) => {
      const readOnly = method === 'reconcileReviewRequest';
      const beforeSend = async () => {
        if (readOnly) throw new Error('Communication reconciliation cannot send.');
        operationContext.signal.throwIfAborted();
        const authorization = await options.authorize?.(binding, live, operationContext);
        operationContext.signal.throwIfAborted();
        if (authorization && !authorization.allowed) throw new Error(authorization.reason);
        if (!sameBinding(binding, options.selected()) || !sameDestination(reviewTarget.destination, options.destination(binding))) throw new Error('Recorded communication destination changed before delivery.');
      };
      const invocation: CommunicationReviewRequestV1 = Object.freeze({ id: live.id, contentHash: live.contentHash, caller: reviewPayload.caller,
        requestId: reviewPayload.requestId, repo: reviewTarget.repo, number: reviewTarget.number, destination: reviewTarget.destination });
      const work = async () => result(await registration.provider[method](invocation, context(binding, reviewTarget.destination, operationContext.signal, beforeSend)), reviewTarget.destination);
      return options.withSession ? options.withSession(work) : work();
    };
    return Object.freeze<OperationAdapter>({ binding, kind: 'communication.review-request', delivery: 'reconcile',
      ...(options.authorize ? { authorize: (live, operationContext) => options.authorize!(binding, live, operationContext) } : {}),
      invoke: (live, operationContext) => execute('invokeReviewRequest', live, operationContext),
      reconcile: (live, operationContext) => execute('reconcileReviewRequest', live, operationContext) });
  };
  return Object.freeze({ prepareReviewRequest, resolve });
}
