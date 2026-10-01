import type { PluginJson } from '../../src/plugins/backend';
import { sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import type { FeedbackTrackerProviderV1 } from '../../src/plugins/feedback-tracker';
import type { ProviderBinding } from './execution-store';
import { readFeedbackTrackerProviderBinding } from './plugins/data';

export interface FeedbackTrackerProviderBinding {
  readonly providerId: string;
  readonly pluginId: string;
  readonly artifactHash: string;
  readonly contractVersion: 1;
  readonly connectionId: string | null;
  readonly credentialHandle: string | null;
}

export type FeedbackTrackerProviderPurpose = 'admission' | 'obligation';

export interface FeedbackTrackerProviderRegistration {
  readonly binding: FeedbackTrackerProviderBinding;
  readonly provider: FeedbackTrackerProviderV1;
  readonly settings?: Readonly<Record<string, PluginJson>>;
}

function validBinding(value: FeedbackTrackerProviderBinding): boolean {
  return typeof value?.providerId === 'string' && /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9_-]*)$/.test(value.providerId)
    && typeof value.pluginId === 'string' && /^[a-z][a-z0-9.-]*$/.test(value.pluginId)
    && typeof value.artifactHash === 'string' && /^[a-f\d]{64}$/.test(value.artifactHash)
    && value.contractVersion === 1 && value.connectionId === null && value.credentialHandle === null;
}

export function validateFeedbackTrackerProvider(provider: FeedbackTrackerProviderV1): void {
  if (!provider || typeof provider !== 'object' || ['destination', 'prepareSubmission', 'invokeSubmission', 'reconcileSubmission']
    .some(method => typeof provider[method as keyof FeedbackTrackerProviderV1] !== 'function')) throw new Error('Invalid feedback tracker provider registration.');
}

export function createFeedbackTrackerProviderRegistry(options: { eligible(binding: FeedbackTrackerProviderBinding, purpose: FeedbackTrackerProviderPurpose): boolean }) {
  const registrations = new Map<string, FeedbackTrackerProviderRegistration>();
  const key = (binding: FeedbackTrackerProviderBinding) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  function stage(binding: FeedbackTrackerProviderBinding, provider: FeedbackTrackerProviderV1, settings: Readonly<Record<string, PluginJson>> = {}): FeedbackTrackerProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid feedback tracker provider binding.');
    validateFeedbackTrackerProvider(provider);
    return Object.freeze({ binding: Object.freeze({ ...binding }), provider, settings: sourceObject(sourceJson(settings)) as Readonly<Record<string, PluginJson>> });
  }
  function publish(input: readonly FeedbackTrackerProviderRegistration[]): void {
    const seen = new Set<string>();
    for (const registration of input) {
      const identity = key(registration.binding);
      if (seen.has(identity) || registrations.has(identity)) throw new Error('Duplicate feedback tracker provider registration.');
      seen.add(identity);
    }
    for (const registration of input) registrations.set(key(registration.binding), registration);
  }
  function resolve(binding: FeedbackTrackerProviderBinding, purpose: FeedbackTrackerProviderPurpose): FeedbackTrackerProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid feedback tracker provider binding.');
    const registration = registrations.get(key(binding));
    if (!registration || !options.eligible(registration.binding, purpose)) throw new Error('Recorded feedback tracker provider is unavailable.');
    return registration;
  }
  return Object.freeze({ stage, publish, resolve,
    list(): readonly FeedbackTrackerProviderRegistration[] { return Object.freeze([...registrations.values()].filter(value => options.eligible(value.binding, 'admission')).sort((a, b) => a.binding.providerId.localeCompare(b.binding.providerId))); },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}

export type FeedbackTrackerProviderRegistry = ReturnType<typeof createFeedbackTrackerProviderRegistry>;

export function resolveSelectedFeedbackTrackerProvider(options: {
  root: string;
  registry: FeedbackTrackerProviderRegistry;
  connection(): { readonly connectionId: string; readonly credentialHandle: string } | null;
}): ProviderBinding | null {
  const providerId = readFeedbackTrackerProviderBinding(options.root);
  if (!providerId) return null;
  const registration = options.registry.list().find(item => item.binding.providerId === providerId);
  if (!registration) return null;
  const connection = options.connection();
  if (!connection || !safeConnection(connection.connectionId) || !safeConnection(connection.credentialHandle)) return null;
  return Object.freeze({ role: 'effect', capability: 'helmsman/feedback-tracker', contractVersion: 1, contributionId: registration.binding.providerId,
    pluginId: registration.binding.pluginId, artifactHash: registration.binding.artifactHash, connectionId: connection.connectionId, credentialHandle: connection.credentialHandle });
}

function safeConnection(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}

export interface FeedbackTrackerRetainedProviderV1 {
  readonly origin: 'builtin' | 'plugin'; readonly binding: FeedbackTrackerProviderBinding; readonly settings: Readonly<Record<string, PluginJson>>;
}
export function parseFeedbackTrackerRetainedProviderV1(value: FeedbackTrackerRetainedProviderV1): FeedbackTrackerRetainedProviderV1 {
  if (!value || !['builtin', 'plugin'].includes(value.origin) || !validBinding(value.binding)
    || (value.origin === 'builtin') !== value.binding.pluginId.startsWith('helmsman.')) throw new Error('Invalid retained feedback tracker');
  return { origin: value.origin, binding: { ...value.binding }, settings: sourceObject(sourceJson(value.settings)) as Readonly<Record<string, PluginJson>> };
}
