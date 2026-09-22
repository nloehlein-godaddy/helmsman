import type { PluginJson } from '../../src/plugins/backend';
import { sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import type { CommunicationProviderV1 } from '../../src/plugins/communication-provider';
import type { ProviderBinding } from './execution-store';
import { initializeCommunicationProviderDefault, readCommunicationProviderBinding } from './plugins/data';

export interface CommunicationProviderBinding {
  readonly providerId: string;
  readonly pluginId: string;
  readonly artifactHash: string;
  readonly contractVersion: 1;
  readonly connectionId: string | null;
  readonly credentialHandle: string | null;
}

export type CommunicationProviderPurpose = 'admission' | 'obligation';

export interface CommunicationProviderRegistration {
  readonly binding: CommunicationProviderBinding;
  readonly provider: CommunicationProviderV1;
  readonly access?: 'browser-session' | 'provider-network';
  readonly settings?: Readonly<Record<string, PluginJson>>;
}

function validBinding(value: CommunicationProviderBinding): boolean {
  return typeof value?.providerId === 'string' && /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9_-]*)$/.test(value.providerId)
    && typeof value.pluginId === 'string' && /^[a-z][a-z0-9.-]*$/.test(value.pluginId)
    && typeof value.artifactHash === 'string' && /^[a-f\d]{64}$/.test(value.artifactHash)
    && value.contractVersion === 1 && value.connectionId === null && value.credentialHandle === null;
}

export function validateCommunicationProvider(provider: CommunicationProviderV1): void {
  if (!provider || typeof provider !== 'object' || ['prepareReviewRequest', 'invokeReviewRequest', 'reconcileReviewRequest', 'scanReviewRequests']
    .some(method => typeof provider[method as keyof CommunicationProviderV1] !== 'function')) throw new Error('Invalid communication provider registration.');
}

export function createCommunicationProviderRegistry(options: { eligible(binding: CommunicationProviderBinding, purpose: CommunicationProviderPurpose): boolean }) {
  const registrations = new Map<string, CommunicationProviderRegistration>();
  const key = (binding: CommunicationProviderBinding) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  function stage(binding: CommunicationProviderBinding, provider: CommunicationProviderV1, settings: Readonly<Record<string, PluginJson>> = {}, access: 'browser-session' | 'provider-network' = 'browser-session'): CommunicationProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid communication provider binding.');
    validateCommunicationProvider(provider);
    if (!['browser-session', 'provider-network'].includes(access) || access === 'provider-network' && typeof provider.connectionIdentity !== 'function') throw new Error('Network communication providers require a connection identity.');
    return Object.freeze({ binding: Object.freeze({ ...binding }), provider, access, settings: sourceObject(sourceJson(settings)) as Readonly<Record<string, PluginJson>> });
  }
  function publish(input: readonly CommunicationProviderRegistration[]): void {
    const seen = new Set<string>();
    for (const registration of input) {
      const identity = key(registration.binding);
      if (seen.has(identity) || registrations.has(identity)) throw new Error('Duplicate communication provider registration.');
      seen.add(identity);
    }
    for (const registration of input) registrations.set(key(registration.binding), registration);
  }
  function resolve(binding: CommunicationProviderBinding, purpose: CommunicationProviderPurpose): CommunicationProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid communication provider binding.');
    const registration = registrations.get(key(binding));
    if (!registration || !options.eligible(registration.binding, purpose)) throw new Error('Recorded communication provider is unavailable.');
    return registration;
  }
  return Object.freeze({ stage, publish, resolve,
    list(): readonly CommunicationProviderRegistration[] { return Object.freeze([...registrations.values()].filter(value => options.eligible(value.binding, 'admission')).sort((a, b) => a.binding.providerId.localeCompare(b.binding.providerId))); },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}

export type CommunicationProviderRegistry = ReturnType<typeof createCommunicationProviderRegistry>;

export function bootstrapCommunicationProviderSelection(root: string, defaultProvider: string): void {
  initializeCommunicationProviderDefault(root, defaultProvider);
}

export function resolveSelectedCommunicationProvider(options: {
  root: string;
  registry: CommunicationProviderRegistry;
  connection(registration: CommunicationProviderRegistration): { readonly connectionId: string; readonly credentialHandle: string } | null;
}): ProviderBinding | null {
  const providerId = readCommunicationProviderBinding(options.root);
  if (!providerId) return null;
  const registration = options.registry.list().find(item => item.binding.providerId === providerId);
  if (!registration) return null;
  const connection = options.connection(registration);
  if (!connection || !safeConnection(connection.connectionId) || !safeConnection(connection.credentialHandle)) return null;
  return Object.freeze({ role: 'effect', capability: 'helmsman/communication', contractVersion: 1, contributionId: registration.binding.providerId,
    pluginId: registration.binding.pluginId, artifactHash: registration.binding.artifactHash, connectionId: connection.connectionId, credentialHandle: connection.credentialHandle });
}

function safeConnection(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
