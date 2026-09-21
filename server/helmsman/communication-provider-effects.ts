import type { CommunicationBrowserSessionV1, CommunicationDestinationV1, CommunicationProviderContextV1, CommunicationProviderResultV1, CommunicationReviewRequestV1 } from '../../src/plugins/communication-provider';
import { parseNativeTerminalReferenceV1 } from '../../src/plugins/native-terminal';
import { isPluginId } from '../../src/plugins/manifest';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { parseNativeTerminalRetainedProviderV1, type NativeTerminalRetainedProviderV1 } from './native-terminal-providers';
import type { OperationAdapter, OperationContext, OperationResolver } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';
import type { CommunicationProviderRegistry } from './communication-providers';
import { pluginJson } from './plugins/data';

export interface CommunicationReviewBrowserTransportV1 {
  readonly provider: NativeTerminalRetainedProviderV1;
  readonly artifacts: readonly ArtifactBinding[];
  readonly surface: string | null;
}
export type CommunicationReviewTargetV1 = {
  readonly repo: string; readonly number: number; readonly destination: CommunicationDestinationV1;
  readonly browserTransport?: CommunicationReviewBrowserTransportV1;
};
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

function artifact(value: unknown): ArtifactBinding {
  const input = object(value);
  if (!input || !isPluginId(input.pluginId) || typeof input.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(input.artifactHash)
    || !text(input.packageVersion, 256) || !Array.isArray(input.requires) || input.requires.length > 256
    || input.requires.some(required => !isPluginId(required)) || new Set(input.requires).size !== input.requires.length) throw new Error('Invalid retained communication browser artifact.');
  return Object.freeze({ pluginId: input.pluginId, artifactHash: input.artifactHash, packageVersion: input.packageVersion, requires: Object.freeze([...input.requires]) as readonly string[] });
}

function browserTransport(value: unknown): CommunicationReviewBrowserTransportV1 {
  const input = object(value);
  if (!input || !Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 256
    || input.surface !== null && typeof input.surface !== 'string') throw new Error('Invalid retained communication browser transport.');
  const artifacts = input.artifacts.map(artifact);
  if (new Set(artifacts.map(item => item.pluginId)).size !== artifacts.length) throw new Error('Invalid retained communication browser artifacts.');
  const provider = parseNativeTerminalRetainedProviderV1(input.provider);
  if (!provider.metadata.browser || !artifacts.some(item => item.pluginId === provider.binding.pluginId && item.artifactHash === provider.binding.artifactHash))
    throw new Error('Retained communication browser provider is unavailable.');
  return Object.freeze({ provider, artifacts: Object.freeze(artifacts), surface: input.surface === null ? null : parseNativeTerminalReferenceV1(input.surface) });
}

function mergeArtifacts(...closures: readonly (readonly ArtifactBinding[])[]): readonly ArtifactBinding[] {
  const result = new Map<string, ArtifactBinding>();
  for (const closure of closures) for (const item of closure) {
    const parsed = artifact(item); const prior = result.get(parsed.pluginId);
    if (prior && (prior.artifactHash !== parsed.artifactHash || prior.packageVersion !== parsed.packageVersion
      || JSON.stringify(prior.requires) !== JSON.stringify(parsed.requires))) throw new Error('Communication provider artifact closures conflict.');
    result.set(parsed.pluginId, parsed);
  }
  return Object.freeze([...result.values()]);
}

function target(value: unknown): CommunicationReviewTargetV1 {
  const input = object(value);
  if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid recorded communication review target.');
  return Object.freeze({ repo: input.repo, number: input.number, destination: destination(input.destination),
    ...(input.browserTransport === undefined ? {} : { browserTransport: browserTransport(input.browserTransport) }) });
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
  admissionSession(binding: ProviderBinding, destination: CommunicationDestinationV1, signal: AbortSignal): {
    readonly browserTransport: CommunicationReviewBrowserTransportV1;
    readonly surface: string | null; readonly watchedChannel: { readonly id: string; readonly name: string }; readonly browser: CommunicationBrowserSessionV1;
    assertCurrent(): void;
  };
  retainedSession(transport: CommunicationReviewBrowserTransportV1, destination: CommunicationDestinationV1, signal: AbortSignal): Promise<{
    readonly surface: string | null; readonly watchedChannel: { readonly id: string; readonly name: string }; readonly browser: CommunicationBrowserSessionV1;
    dispose(): Promise<void>;
  }>;
  authorize?(binding: ProviderBinding, operation: DurableOperation, context: OperationContext): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  assertAdmission?(): void;
  withSession?<T>(work: () => Promise<T>): Promise<T>;
}): CommunicationProviderEffects {
  function admission(binding: ProviderBinding) {
    if (!binding || binding.role !== 'effect' || binding.capability !== 'helmsman/communication' || binding.contractVersion !== 1
      || binding.connectionId === null || binding.credentialHandle === null) throw new Error('Selected communication provider binding is invalid.');
    return options.registry.resolve(registryBinding(binding), 'admission');
  }
  function context(session: { readonly surface: string | null; readonly watchedChannel: { readonly id: string; readonly name: string }; readonly browser: CommunicationBrowserSessionV1 }, configured: CommunicationDestinationV1, signal: AbortSignal, beforeSend: () => Promise<void>): CommunicationProviderContextV1 {
    if (!session || (session.surface !== null && !text(session.surface, 512)) || typeof session.watchedChannel?.id !== 'string' || session.watchedChannel.id.length > 128 || typeof session.watchedChannel?.name !== 'string' || session.watchedChannel.name.length > 128 || !session.browser) throw new Error('Communication browser session is unavailable.');
    return Object.freeze({ signal, destination: configured, surface: session.surface, watchedChannel: Object.freeze({ id: session.watchedChannel.id, name: session.watchedChannel.name }), browser: session.browser, beforeSend });
  }
  async function prepareReviewRequestCore(input: { readonly repo: string; readonly number: number; readonly expectedDestination: CommunicationDestinationV1 }, signal = new AbortController().signal) {
    if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid communication review request.');
    const expected = destination(input.expectedDestination); options.assertAdmission?.(); signal.throwIfAborted();
    const binding = options.selected(); if (!binding) throw new Error('No communication provider is selected.');
    const configured = options.destination(binding);
    if (!configured || !sameDestination(expected, configured) || configured.providerId !== binding.contributionId || configured.artifactHash !== binding.artifactHash || configured.connectionId !== binding.connectionId) throw new Error('Selected communication destination changed.');
    const registration = admission(binding); const providerArtifacts = options.artifacts(binding);
    if (!Array.isArray(providerArtifacts) || !providerArtifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) throw new Error('Selected communication provider artifacts are unavailable.');
    const session = options.admissionSession(binding, configured, signal); const transport = browserTransport(session.browserTransport);
    const artifacts = mergeArtifacts(providerArtifacts, transport.artifacts);
    await options.verifyArtifacts(artifacts); signal.throwIfAborted(); session.assertCurrent(); options.assertAdmission?.();
    const prepared = await registration.provider.prepareReviewRequest({ repo: input.repo, number: input.number }, context(session, configured, signal, async () => { throw new Error('Communication preparation cannot send.'); }));
    if (!prepared || prepared.workspace !== configured.workspace || prepared.channel !== configured.channel || prepared.mention !== configured.mention || prepared.connectionId !== configured.connectionId) throw new Error('Communication provider changed the configured destination.');
    session.assertCurrent(); options.assertAdmission?.();
    if (!sameBinding(binding, options.selected()) || !sameDestination(configured, options.destination(binding))) throw new Error('Selected communication provider changed during preparation.');
    admission(binding);
    return Object.freeze({ binding, artifacts, target: Object.freeze({ repo: input.repo, number: input.number, destination: configured, browserTransport: transport }) });
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
    if (!reviewTarget.browserTransport) return null;
    if (reviewTarget.destination.providerId !== binding.contributionId || reviewTarget.destination.artifactHash !== binding.artifactHash || reviewTarget.destination.connectionId !== binding.connectionId
      || !operation.artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)
      || reviewTarget.browserTransport.artifacts.some(captured => !operation.artifacts.some(item => item.pluginId === captured.pluginId && item.artifactHash === captured.artifactHash))) return null;
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
      const work = async () => {
        const retained = await options.retainedSession(reviewTarget.browserTransport!, reviewTarget.destination, operationContext.signal);
        try { return result(await registration.provider[method](invocation, context(retained, reviewTarget.destination, operationContext.signal, beforeSend)), reviewTarget.destination); }
        finally { await retained.dispose(); }
      };
      return options.withSession ? options.withSession(work) : work();
    };
    return Object.freeze<OperationAdapter>({ binding, kind: 'communication.review-request', delivery: 'reconcile',
      ...(options.authorize ? { authorize: (live, operationContext) => options.authorize!(binding, live, operationContext) } : {}),
      invoke: (live, operationContext) => execute('invokeReviewRequest', live, operationContext),
      reconcile: (live, operationContext) => execute('reconcileReviewRequest', live, operationContext) });
  };
  return Object.freeze({ prepareReviewRequest, resolve });
}
