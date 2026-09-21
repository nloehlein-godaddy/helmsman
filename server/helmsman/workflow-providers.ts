import type { PluginJson } from '../../src/plugins/backend';
import { parseWorkflowActionV1, parseWorkflowMetadataV1, parseWorkflowPromptInputV1, parseWorkflowPromptV1, parseWorkflowStepInputV1, type WorkflowMetadataV1, type WorkflowProviderV1 } from '../../src/plugins/workflow';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { PluginPackage } from '../../src/plugins/package';
import { sourceFields, sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import { persistenceHash } from './persistence';

export interface WorkflowProviderBindingV1 {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface WorkflowRetainedProviderV1 {
  readonly version: 1; readonly binding: WorkflowProviderBindingV1; readonly origin: 'builtin' | 'external';
  readonly settings: Readonly<Record<string, PluginJson>>; readonly metadata: WorkflowMetadataV1;
}
export interface WorkflowProviderRegistration {
  readonly record: WorkflowRetainedProviderV1; readonly provider: WorkflowProviderV1; readonly package: PluginPackage;
}
export type WorkflowProviderPurpose = 'admission' | 'obligation';

export function parseWorkflowProviderBindingV1(input: unknown): WorkflowProviderBindingV1 {
  const value = sourceObject(input); sourceFields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion']);
  if (!isContributionId(value.providerId) || !isPluginId(value.pluginId) || value.providerId.split('/')[0] !== value.pluginId
    || typeof value.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(value.artifactHash) || value.contractVersion !== 1) throw new TypeError('Invalid workflow provider binding');
  return Object.freeze({ providerId: value.providerId, pluginId: value.pluginId, artifactHash: value.artifactHash, contractVersion: 1 });
}
export function parseWorkflowRetainedProviderV1(input: unknown): WorkflowRetainedProviderV1 {
  const value = sourceObject(sourceJson(input, 256 * 1024)); sourceFields(value, ['version', 'binding', 'origin', 'settings', 'metadata']);
  if (value.version !== 1 || value.origin !== 'builtin' && value.origin !== 'external') throw new TypeError('Invalid retained workflow provider');
  const binding = parseWorkflowProviderBindingV1(value.binding);
  if ((value.origin === 'builtin') !== binding.pluginId.startsWith('helmsman.')) throw new TypeError('Workflow provider origin does not match namespace');
  const settings = sourceObject(value.settings) as Readonly<Record<string, PluginJson>>;
  return Object.freeze({ version: 1, binding, origin: value.origin, settings, metadata: parseWorkflowMetadataV1(value.metadata) });
}
export function validateWorkflowProvider(provider: WorkflowProviderV1): void {
  if (!provider || typeof provider !== 'object' || typeof provider.renderPrompt !== 'function' || typeof provider.next !== 'function') throw new TypeError('Invalid workflow provider registration');
  parseWorkflowMetadataV1(provider.metadata);
}
export function boundedWorkflowProvider(provider: WorkflowProviderV1, signal?: AbortSignal): WorkflowProviderV1 {
  validateWorkflowProvider(provider);
  return Object.freeze<WorkflowProviderV1>({ metadata: parseWorkflowMetadataV1(provider.metadata),
    renderPrompt(input) {
      signal?.throwIfAborted(); const parsed = parseWorkflowPromptInputV1(input);
      const result = parseWorkflowPromptV1(provider.renderPrompt(parsed)); signal?.throwIfAborted(); return result;
    },
    next(input) {
      signal?.throwIfAborted(); const parsed = parseWorkflowStepInputV1(input);
      const result = parseWorkflowActionV1(provider.next(parsed)); signal?.throwIfAborted(); return result;
    },
  });
}
export function createWorkflowProviderRegistry(options: { eligible(binding: WorkflowProviderBindingV1, purpose: WorkflowProviderPurpose): boolean }) {
  const registrations = new Map<string, WorkflowProviderRegistration>(); const staged = new WeakSet<WorkflowProviderRegistration>();
  const key = (binding: WorkflowProviderBindingV1) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(input: { binding: WorkflowProviderBindingV1; provider: WorkflowProviderV1; package: PluginPackage; settings: Readonly<Record<string, PluginJson>>; origin: 'builtin' | 'external' }): WorkflowProviderRegistration {
      const provider = boundedWorkflowProvider(input.provider);
      const record = parseWorkflowRetainedProviderV1({ version: 1, binding: input.binding, origin: input.origin, settings: input.settings, metadata: provider.metadata });
      if (input.package.manifest.id !== record.binding.pluginId || !input.package.backend?.provides.some(value => String(value.id) === 'helmsman/workflow' && `${record.binding.pluginId}/${value.localId}` === record.binding.providerId)) throw new TypeError('Workflow provider differs from its package declaration');
      const registration = Object.freeze({ record, provider, package: input.package }); staged.add(registration); return registration;
    },
    publish(input: readonly WorkflowProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.record.binding);
        if (!staged.has(registration) || registrations.has(identity) || seen.has(identity)) throw new Error('Duplicate or unstaged workflow registration');
        seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.record.binding), registration); staged.delete(registration); }
    },
    resolve(binding: WorkflowProviderBindingV1, purpose: WorkflowProviderPurpose = 'admission'): WorkflowProviderRegistration {
      const registration = registrations.get(key(parseWorkflowProviderBindingV1(binding)));
      if (!registration || !options.eligible(registration.record.binding, purpose)) throw new Error('Pinned workflow provider is unavailable');
      return registration;
    },
    list(purpose: WorkflowProviderPurpose = 'admission'): readonly WorkflowProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.record.binding, purpose)).sort((a, b) => a.record.binding.providerId.localeCompare(b.record.binding.providerId)));
    },
    assertCurrent(record: WorkflowRetainedProviderV1): void {
      const parsed = parseWorkflowRetainedProviderV1(record); const registration = registrations.get(key(parsed.binding));
      if (!registration || !options.eligible(parsed.binding, 'admission') || persistenceHash(registration.record) !== persistenceHash(parsed)) throw new Error('Workflow provider or effective settings changed before admission');
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.record.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type WorkflowProviderRegistry = ReturnType<typeof createWorkflowProviderRegistry>;
