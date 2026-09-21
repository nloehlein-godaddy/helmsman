import type { PluginJson } from '../../src/plugins/backend';
import { AGENT_PROVIDER_LIMITS_V1, parseAgentCommandInputV1, parseAgentCommandV1, parseAgentEventV1, parseAgentProviderMetadataV1, type AgentProviderMetadataV1, type AgentProviderV1 } from '../../src/plugins/agent-provider';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { PluginPackage } from '../../src/plugins/package';
import { sourceFields, sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import { persistenceHash } from './persistence';

export interface AgentProviderBindingV1 {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface AgentRetainedProviderV1 {
  readonly version: 1; readonly binding: AgentProviderBindingV1; readonly origin: 'builtin' | 'external';
  readonly settings: Readonly<Record<string, PluginJson>>; readonly metadata: AgentProviderMetadataV1;
}
export interface AgentSelectionV1 { readonly version: 1; readonly writer: AgentRetainedProviderV1; readonly reviewers: readonly AgentRetainedProviderV1[]; }
export interface AgentProviderRegistration {
  readonly record: AgentRetainedProviderV1; readonly provider: AgentProviderV1; readonly package: PluginPackage;
}
export type AgentProviderPurpose = 'admission' | 'obligation';

export function parseAgentProviderBindingV1(input: unknown): AgentProviderBindingV1 {
  const value = sourceObject(input); sourceFields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion']);
  if (!isContributionId(value.providerId) || !isPluginId(value.pluginId) || value.providerId.split('/')[0] !== value.pluginId
    || typeof value.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(value.artifactHash) || value.contractVersion !== 1) throw new TypeError('Invalid agent provider binding');
  return Object.freeze({ providerId: value.providerId, pluginId: value.pluginId, artifactHash: value.artifactHash, contractVersion: 1 });
}
export function parseAgentRetainedProviderV1(input: unknown): AgentRetainedProviderV1 {
  const value = sourceObject(sourceJson(input, 256 * 1024)); sourceFields(value, ['version', 'binding', 'origin', 'settings', 'metadata']);
  if (value.version !== 1 || value.origin !== 'builtin' && value.origin !== 'external') throw new TypeError('Invalid retained agent provider');
  const binding = parseAgentProviderBindingV1(value.binding);
  if ((value.origin === 'builtin') !== binding.pluginId.startsWith('helmsman.')) throw new TypeError('Agent provider origin does not match namespace');
  const settings = sourceObject(value.settings) as Readonly<Record<string, PluginJson>>;
  return Object.freeze({ version: 1, binding, origin: value.origin, settings, metadata: parseAgentProviderMetadataV1(value.metadata) });
}
export function parseAgentSelectionV1(input: unknown): AgentSelectionV1 {
  const value = sourceObject(sourceJson(input, 1024 * 1024)); sourceFields(value, ['version', 'writer', 'reviewers']);
  if (value.version !== 1 || !Array.isArray(value.reviewers) || value.reviewers.length > 8) throw new TypeError('Invalid agent selection');
  const reviewers = value.reviewers.map(parseAgentRetainedProviderV1);
  if (new Set(reviewers.map(value => value.binding.providerId)).size !== reviewers.length) throw new TypeError('Duplicate review provider');
  const writer = parseAgentRetainedProviderV1(value.writer);
  if (reviewers.some(value => value.binding.providerId === writer.binding.providerId && persistenceHash(value) !== persistenceHash(writer))) throw new TypeError('Conflicting retained agent records');
  return Object.freeze({ version: 1, writer, reviewers: Object.freeze(reviewers) });
}
export function validateAgentProvider(provider: AgentProviderV1): void {
  if (!provider || typeof provider !== 'object' || typeof provider.buildCommand !== 'function' || typeof provider.parseLine !== 'function') throw new TypeError('Invalid agent provider registration');
  parseAgentProviderMetadataV1(provider.metadata);
}
export function boundedAgentProvider(provider: AgentProviderV1): AgentProviderV1 {
  validateAgentProvider(provider);
  return Object.freeze<AgentProviderV1>({ metadata: parseAgentProviderMetadataV1(provider.metadata),
    buildCommand(input) { return parseAgentCommandV1(provider.buildCommand(parseAgentCommandInputV1(input))); },
    parseLine(line) {
      if (typeof line !== 'string' || line.length > AGENT_PROVIDER_LIMITS_V1.line || Buffer.byteLength(line) > AGENT_PROVIDER_LIMITS_V1.line || line.includes('\0')) throw new TypeError('Agent output line exceeds contract bounds');
      return parseAgentEventV1(provider.parseLine(line));
    },
  });
}
export function createAgentProviderRegistry(options: { eligible(binding: AgentProviderBindingV1, purpose: AgentProviderPurpose): boolean }) {
  const registrations = new Map<string, AgentProviderRegistration>(); const staged = new WeakSet<AgentProviderRegistration>();
  const key = (binding: AgentProviderBindingV1) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(input: { binding: AgentProviderBindingV1; provider: AgentProviderV1; package: PluginPackage; settings: Readonly<Record<string, PluginJson>>; origin: 'builtin' | 'external' }): AgentProviderRegistration {
      const provider = boundedAgentProvider(input.provider);
      const record = parseAgentRetainedProviderV1({ version: 1, binding: input.binding, origin: input.origin, settings: input.settings, metadata: provider.metadata });
      if (input.package.manifest.id !== record.binding.pluginId || !input.package.backend?.provides.some(value => String(value.id) === 'helmsman/agent' && `${record.binding.pluginId}/${value.localId}` === record.binding.providerId)) throw new TypeError('Agent provider differs from its package declaration');
      const registration = Object.freeze({ record, provider, package: input.package }); staged.add(registration); return registration;
    },
    publish(input: readonly AgentProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.record.binding);
        if (!staged.has(registration) || registrations.has(identity) || seen.has(identity)) throw new Error('Duplicate or unstaged agent registration');
        seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.record.binding), registration); staged.delete(registration); }
    },
    resolve(binding: AgentProviderBindingV1, purpose: AgentProviderPurpose = 'admission'): AgentProviderRegistration {
      const registration = registrations.get(key(parseAgentProviderBindingV1(binding)));
      if (!registration || !options.eligible(registration.record.binding, purpose)) throw new Error('Pinned agent provider is unavailable');
      return registration;
    },
    list(purpose: AgentProviderPurpose = 'admission'): readonly AgentProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.record.binding, purpose)).sort((a, b) => a.record.binding.providerId.localeCompare(b.record.binding.providerId)));
    },
    assertCurrent(record: AgentRetainedProviderV1): void {
      const parsed = parseAgentRetainedProviderV1(record); const registration = registrations.get(key(parsed.binding));
      if (!registration || !options.eligible(parsed.binding, 'admission') || persistenceHash(registration.record) !== persistenceHash(parsed)) throw new Error('Agent provider or effective settings changed before admission');
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.record.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type AgentProviderRegistry = ReturnType<typeof createAgentProviderRegistry>;
