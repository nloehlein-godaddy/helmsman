import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { SchedulingProviderV1 } from '../../src/plugins/scheduling-provider';
import { persistenceHash } from './persistence';

export interface SchedulingProviderBinding {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface SchedulingProviderRegistration { readonly binding: SchedulingProviderBinding; readonly provider: SchedulingProviderV1; readonly settingsHash: string; }
export interface SchedulingProviderSelection { readonly registration: SchedulingProviderRegistration; readonly revision: string; }

function validBinding(value: SchedulingProviderBinding): boolean {
  return isContributionId(value?.providerId) && isPluginId(value?.pluginId) && value.providerId.split('/')[0] === value.pluginId
    && typeof value.artifactHash === 'string' && /^[a-f\d]{64}$/.test(value.artifactHash) && value.contractVersion === 1;
}
export function validateSchedulingProvider(provider: SchedulingProviderV1): void {
  if (!provider || typeof provider !== 'object' || typeof provider.select !== 'function'
    || !Number.isSafeInteger(provider.intervalMs) || provider.intervalMs < 250 || provider.intervalMs > 3_600_000) throw new Error('Invalid scheduling provider registration');
}
export function createSchedulingProviderRegistry(options: { eligible(binding: SchedulingProviderBinding): boolean }) {
  const registrations = new Map<string, SchedulingProviderRegistration>(); const staged = new WeakSet<SchedulingProviderRegistration>();
  const key = (binding: SchedulingProviderBinding) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(binding: SchedulingProviderBinding, provider: SchedulingProviderV1, settingsHash = persistenceHash({})): SchedulingProviderRegistration {
      if (!validBinding(binding)) throw new Error('Invalid scheduling provider binding'); validateSchedulingProvider(provider);
      if (!/^[a-f\d]{64}$/.test(settingsHash)) throw new Error('Invalid scheduling settings identity');
      const value = Object.freeze({ binding: Object.freeze({ ...binding }), provider, settingsHash }); staged.add(value); return value;
    },
    publish(input: readonly SchedulingProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.binding);
        if (!staged.has(registration) || seen.has(identity) || registrations.has(identity)) throw new Error('Duplicate or unstaged scheduling provider registration');
        validateSchedulingProvider(registration.provider); seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.binding), registration); staged.delete(registration); }
    },
    resolve(binding: SchedulingProviderBinding): SchedulingProviderRegistration {
      if (!validBinding(binding)) throw new Error('Invalid scheduling provider binding');
      const registration = registrations.get(key(binding));
      if (!registration || !options.eligible(registration.binding)) throw new Error('Selected scheduling provider is unavailable');
      return registration;
    },
    list(): readonly SchedulingProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.binding)).sort((a, b) => a.binding.providerId.localeCompare(b.binding.providerId)));
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type SchedulingProviderRegistry = ReturnType<typeof createSchedulingProviderRegistry>;
