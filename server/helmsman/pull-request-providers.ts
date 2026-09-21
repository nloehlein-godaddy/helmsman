import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import type { ProviderBinding } from './execution-store';
import { initializePullRequestProviderDefault, readPullRequestProviderBinding } from './plugins/data';

export interface PullRequestProviderBinding {
  readonly providerId: string;
  readonly pluginId: string;
  readonly artifactHash: string;
  readonly contractVersion: 1;
  readonly connectionId: string | null;
  readonly credentialHandle: string | null;
}

export type PullRequestProviderPurpose = 'admission' | 'obligation';

export interface PullRequestProviderRegistration {
  readonly binding: PullRequestProviderBinding;
  readonly provider: PullRequestProviderV1;
}

function validBinding(value: PullRequestProviderBinding): boolean {
  return typeof value?.providerId === 'string' && /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9_-]*)$/.test(value.providerId)
    && typeof value.pluginId === 'string' && /^[a-z][a-z0-9.-]*$/.test(value.pluginId)
    && typeof value.artifactHash === 'string' && /^[a-f\d]{64}$/.test(value.artifactHash)
    && value.contractVersion === 1 && value.connectionId === null && value.credentialHandle === null;
}

export function validatePullRequestProvider(provider: PullRequestProviderV1): void {
  if (!provider || typeof provider !== 'object' || ['list', 'detail', 'diff', 'prepareReview', 'invokeReview', 'reconcileReview']
    .some(method => typeof provider[method as keyof PullRequestProviderV1] !== 'function')
    || provider.profile !== undefined && typeof provider.profile !== 'function') throw new Error('Invalid pull request provider registration.');
}

export function createPullRequestProviderRegistry(options: { eligible(binding: PullRequestProviderBinding, purpose: PullRequestProviderPurpose): boolean }) {
  const registrations = new Map<string, PullRequestProviderRegistration>();
  const key = (binding: PullRequestProviderBinding) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  function stage(binding: PullRequestProviderBinding, provider: PullRequestProviderV1): PullRequestProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid pull request provider binding.');
    validatePullRequestProvider(provider);
    return Object.freeze({ binding: Object.freeze({ ...binding }), provider });
  }
  function publish(input: readonly PullRequestProviderRegistration[]): void {
    const seen = new Set<string>();
    for (const registration of input) {
      const identity = key(registration.binding);
      if (seen.has(identity) || registrations.has(identity)) throw new Error('Duplicate pull request provider registration.');
      seen.add(identity);
    }
    for (const registration of input) registrations.set(key(registration.binding), registration);
  }
  function resolve(binding: PullRequestProviderBinding, purpose: PullRequestProviderPurpose): PullRequestProviderRegistration {
    if (!validBinding(binding)) throw new Error('Invalid pull request provider binding.');
    const registration = registrations.get(key(binding));
    if (!registration || !options.eligible(registration.binding, purpose)) throw new Error('Recorded pull request provider is unavailable.');
    return registration;
  }
  return Object.freeze({ stage, publish, resolve,
    list(): readonly PullRequestProviderRegistration[] { return Object.freeze([...registrations.values()].filter(value => options.eligible(value.binding, 'admission')).sort((a, b) => a.binding.providerId.localeCompare(b.binding.providerId))); },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}

export type PullRequestProviderRegistry = ReturnType<typeof createPullRequestProviderRegistry>;

export function bootstrapPullRequestProviderSelection(root: string, defaultProvider: string): void {
  initializePullRequestProviderDefault(root, defaultProvider);
}

export function resolveSelectedPullRequestProvider(options: {
  root: string;
  registry: PullRequestProviderRegistry;
  connection(): { readonly connectionId: string; readonly credentialHandle: string } | null;
}): ProviderBinding | null {
  const providerId = readPullRequestProviderBinding(options.root);
  if (!providerId) return null;
  const registration = options.registry.list().find(item => item.binding.providerId === providerId);
  if (!registration) return null;
  const connection = options.connection();
  if (!connection || !safeConnection(connection.connectionId) || !safeConnection(connection.credentialHandle)) return null;
  return Object.freeze({ role: 'effect', capability: 'helmsman/pull-request', contractVersion: 1, contributionId: registration.binding.providerId,
    pluginId: registration.binding.pluginId, artifactHash: registration.binding.artifactHash, connectionId: connection.connectionId, credentialHandle: connection.credentialHandle });
}

function safeConnection(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
