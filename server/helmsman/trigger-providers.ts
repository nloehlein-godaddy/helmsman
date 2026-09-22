import { COMMUNICATION_TIMEOUT_MS } from './communication-timeout';
import type { PluginJson } from '../../src/plugins/backend';
import { parseCampaignTriggerInputV1, parseCampaignTriggerChoiceV1, parseTriggerMetadataV1, parseReviewTriggerInputV1, parseReviewTriggerResultV1, parseTriggerCursorV1, parseTriggerMessageBatchV1, parseTriggerRequestedBatchV1, parseTriggerReviewDetailInputV1, parseTriggerReviewTargetV1, parseWebhookTriggerInputV1, parseWebhookTriggerResultV1, TRIGGER_LIMITS_V1, type TriggerMetadataV1, type TriggerProviderV1, type CampaignTriggerProviderV1, type CommunicationReviewTriggerProviderV1, type PullRequestReviewTriggerProviderV1, type WebhookTriggerProviderV1, type ReviewTriggerProviderV1, type ReviewTriggerContextV1, type ReviewTriggerInputV1, type ReviewTriggerResultV1, type TriggerReviewTargetV1, type TriggerMessageV1 } from '../../src/plugins/trigger';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { PluginPackage } from '../../src/plugins/package';
import { sourceFields, sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import { persistenceHash } from './persistence';

export interface TriggerProviderBindingV1 {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface TriggerRetainedProviderV1 {
  readonly version: 1; readonly binding: TriggerProviderBindingV1; readonly origin: 'builtin' | 'external';
  readonly settings: Readonly<Record<string, PluginJson>>; readonly metadata: TriggerMetadataV1;
}
export interface TriggerProviderRegistration {
  readonly record: TriggerRetainedProviderV1; readonly provider: TriggerProviderV1; readonly package: PluginPackage;
}
export type TriggerProviderPurpose = 'admission' | 'obligation';

export function parseTriggerProviderBindingV1(input: unknown): TriggerProviderBindingV1 {
  const value = sourceObject(input); sourceFields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion']);
  if (!isContributionId(value.providerId) || !isPluginId(value.pluginId) || value.providerId.split('/')[0] !== value.pluginId
    || typeof value.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(value.artifactHash) || value.contractVersion !== 1) throw new TypeError('Invalid trigger provider binding');
  return Object.freeze({ providerId: value.providerId, pluginId: value.pluginId, artifactHash: value.artifactHash, contractVersion: 1 });
}
export function parseTriggerRetainedProviderV1(input: unknown): TriggerRetainedProviderV1 {
  const value = sourceObject(sourceJson(input, 256 * 1024)); sourceFields(value, ['version', 'binding', 'origin', 'settings', 'metadata']);
  if (value.version !== 1 || value.origin !== 'builtin' && value.origin !== 'external') throw new TypeError('Invalid retained trigger provider');
  const binding = parseTriggerProviderBindingV1(value.binding);
  if ((value.origin === 'builtin') !== binding.pluginId.startsWith('helmsman.')) throw new TypeError('Trigger provider origin does not match namespace');
  const settings = sourceObject(value.settings) as Readonly<Record<string, PluginJson>>;
  return Object.freeze({ version: 1, binding, origin: value.origin, settings, metadata: parseTriggerMetadataV1(value.metadata) });
}
export function validateTriggerProvider(provider: TriggerProviderV1): void {
  if (!provider || typeof provider !== 'object') throw new TypeError('Invalid trigger provider registration');
  const metadata = parseTriggerMetadataV1(provider.metadata);
  const method = metadata.kind === 'campaign' ? 'select' : metadata.kind === 'webhook' ? 'parse' : 'scan';
  if (typeof (provider as unknown as Record<string, unknown>)[method] !== 'function') throw new TypeError('Invalid trigger provider implementation');
}
export function boundedTriggerProvider(provider: TriggerProviderV1, signal?: AbortSignal): TriggerProviderV1 {
  validateTriggerProvider(provider); const metadata = parseTriggerMetadataV1(provider.metadata);
  if (metadata.kind === 'campaign') return Object.freeze<CampaignTriggerProviderV1>({ metadata,
    select(input) {
      signal?.throwIfAborted(); const parsed = parseCampaignTriggerInputV1(input); const result = parseCampaignTriggerChoiceV1((provider as CampaignTriggerProviderV1).select(parsed)); signal?.throwIfAborted();
      if (result && !parsed.candidates.some(candidate => candidate.candidateId === result.candidateId)) throw new Error('Trigger selected an unobserved campaign candidate'); return result;
    },
  });
  if (metadata.kind === 'webhook') return Object.freeze<WebhookTriggerProviderV1>({ metadata,
    parse(input) { signal?.throwIfAborted(); const parsed = parseWebhookTriggerInputV1(input); const result = parseWebhookTriggerResultV1((provider as WebhookTriggerProviderV1).parse(parsed)); signal?.throwIfAborted(); return result; },
  });
  const source = metadata.source;
  async function scan(input: ReviewTriggerInputV1, context: ReviewTriggerContextV1): Promise<ReviewTriggerResultV1> {
    signal?.throwIfAborted();
    if (!context || context.source !== source || !context.signal || typeof context.detail !== 'function') throw new Error('Trigger review context does not match its source');
    const parsed = parseReviewTriggerInputV1(input); context.signal.throwIfAborted();
    if (source === 'pull-request' && parsed.cursor !== null) throw new Error('Requested-review trigger cannot use a communication cursor');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('Trigger scan timed out')), source === 'communication' ? COMMUNICATION_TIMEOUT_MS : 30_000);
    const combined = AbortSignal.any([controller.signal, context.signal, ...(signal ? [signal] : [])]);
    const events = new Map<string, TriggerMessageV1>(); const targets = new Map<string, TriggerReviewTargetV1>(); const requested = new Set<string>();
    let active = true; let calls = 0; let discoveryStarted = false; let discoveryCompleted = false; let complete = true;
    const key = (repo: string, number: number) => JSON.stringify([repo.toLowerCase(), number]);
    const assertActive = () => { combined.throwIfAborted(); if (!active) throw new Error('Trigger discovery context expired'); };
    async function invoke<T>(work: () => Promise<T>): Promise<T> {
      assertActive(); if (++calls > TRIGGER_LIMITS_V1.calls) throw new Error('Trigger discovery call limit exceeded');
      const value = await clarificationAbortable(Promise.resolve().then(() => { assertActive(); return work(); }), combined); assertActive(); return value;
    }
    const detail = async (input: { readonly repo: string; readonly number: number }) => {
      const query = parseTriggerReviewDetailInputV1(input);
      if (source === 'pull-request' && !requested.has(key(query.repo, query.number))) throw new Error('Trigger requested an unobserved pull request');
      const value = parseTriggerReviewTargetV1(await invoke(() => context.detail(query, combined)));
      if (value) {
        if (value.repo.toLowerCase() !== query.repo.toLowerCase() || value.number !== query.number) throw new Error('Trigger detail changed its target');
        const prior = targets.get(value.targetId); if (prior && persistenceHash(prior) !== persistenceHash(value)) throw new Error('Trigger detail handle changed'); targets.set(value.targetId, value);
      }
      return value;
    };
    let boundedContext: ReviewTriggerContextV1;
    if (context.source === 'communication') boundedContext = Object.freeze({ source: 'communication', signal: combined, detail,
      async messages(input: { readonly since: string | null }) {
        const value = sourceObject(input); sourceFields(value, ['since']); const since = parseTriggerCursorV1(value.since);
        if (discoveryStarted) throw new Error('Trigger discovery can only scan once'); discoveryStarted = true;
        const result = parseTriggerMessageBatchV1(await invoke(() => context.messages({ since }, combined)));
        discoveryCompleted = true; complete = result.complete; for (const event of result.items) events.set(event.eventId, event); return result;
      },
    });
    else boundedContext = Object.freeze({ source: 'pull-request', signal: combined, detail,
      async requested() {
        if (discoveryStarted) throw new Error('Trigger discovery can only scan once'); discoveryStarted = true;
        const result = parseTriggerRequestedBatchV1(await invoke(() => context.requested(combined))); discoveryCompleted = true; complete = result.quality === 'complete' && !result.truncated;
        for (const item of result.items) requested.add(key(item.repo, item.number)); return result;
      },
    });
    try {
      const result = parseReviewTriggerResultV1(await clarificationAbortable(Promise.resolve().then(() => {
        assertActive();
        return boundedContext.source === 'communication'
          ? (provider as CommunicationReviewTriggerProviderV1).scan(parsed, boundedContext)
          : (provider as PullRequestReviewTriggerProviderV1).scan(parsed, boundedContext);
      }), combined));
      assertActive();
      if (result.complete && (!discoveryCompleted || !complete)) throw new Error('Trigger claimed complete discovery without complete evidence');
      if (source === 'pull-request' && result.nextCursor !== null) throw new Error('Requested-review trigger returned a communication cursor');
      for (const proposal of result.proposals) {
        const target = targets.get(proposal.targetId);
        if (!target || target.status !== 'open' || target.draft || source === 'communication' && (!proposal.eventId || !events.has(proposal.eventId)) || source === 'pull-request' && (proposal.eventId !== null || !requested.has(key(target.repo, target.number)))) throw new Error('Trigger proposed an unobserved or ineligible review target');
      }
      return result;
    } finally { active = false; clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze({ metadata, scan }) as ReviewTriggerProviderV1;
}
export function createTriggerProviderRegistry(options: { eligible(binding: TriggerProviderBindingV1, purpose: TriggerProviderPurpose): boolean }) {
  const registrations = new Map<string, TriggerProviderRegistration>(); const staged = new WeakSet<TriggerProviderRegistration>();
  const key = (binding: TriggerProviderBindingV1) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(input: { binding: TriggerProviderBindingV1; provider: TriggerProviderV1; package: PluginPackage; settings: Readonly<Record<string, PluginJson>>; origin: 'builtin' | 'external' }): TriggerProviderRegistration {
      const provider = boundedTriggerProvider(input.provider);
      const record = parseTriggerRetainedProviderV1({ version: 1, binding: input.binding, origin: input.origin, settings: input.settings, metadata: provider.metadata });
      if (input.package.manifest.id !== record.binding.pluginId || !input.package.backend?.provides.some(value => String(value.id) === 'helmsman/trigger' && `${record.binding.pluginId}/${value.localId}` === record.binding.providerId)) throw new TypeError('Trigger provider differs from its package declaration');
      const localId = record.binding.providerId.split('/')[1]!;
      const expected = record.metadata.kind === 'campaign' ? 'campaign-candidates' : record.metadata.kind === 'webhook' ? 'authenticated-event' : 'review-discovery';
      if (input.package.backend?.triggers?.[localId]?.access[0] !== expected) throw new TypeError('Trigger declaration does not match provider kind');
      const registration = Object.freeze({ record, provider, package: input.package }); staged.add(registration); return registration;
    },
    publish(input: readonly TriggerProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.record.binding);
        if (!staged.has(registration) || registrations.has(identity) || seen.has(identity)) throw new Error('Duplicate or unstaged trigger registration');
        seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.record.binding), registration); staged.delete(registration); }
    },
    resolve(binding: TriggerProviderBindingV1, purpose: TriggerProviderPurpose = 'admission'): TriggerProviderRegistration {
      const registration = registrations.get(key(parseTriggerProviderBindingV1(binding)));
      if (!registration || !options.eligible(registration.record.binding, purpose)) throw new Error('Pinned trigger provider is unavailable');
      return registration;
    },
    list(purpose: TriggerProviderPurpose = 'admission'): readonly TriggerProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.record.binding, purpose)).sort((a, b) => a.record.binding.providerId.localeCompare(b.record.binding.providerId)));
    },
    assertCurrent(record: TriggerRetainedProviderV1): void {
      const parsed = parseTriggerRetainedProviderV1(record); const registration = registrations.get(key(parsed.binding));
      if (!registration || !options.eligible(parsed.binding, 'admission') || persistenceHash(registration.record) !== persistenceHash(parsed)) throw new Error('Trigger provider or effective settings changed before admission');
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.record.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type TriggerProviderRegistry = ReturnType<typeof createTriggerProviderRegistry>;
