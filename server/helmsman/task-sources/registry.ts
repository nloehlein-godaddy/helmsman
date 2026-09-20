import type { TaskSourceDeclaration } from '../../../src/plugins/backend';
import { parseSourceBindingV1, parseSourceInstanceV1, validateTaskSourceProvider, type SourceBindingV1, type SourceInstanceV1, type TaskSourceProviderV1 } from '../../../src/plugins/tasks';
import { PersistenceConflictError } from '../persistence';

export type SourceResolutionPurpose = 'admission' | 'obligation';
export interface TaskSourceRegistration {
  readonly binding: SourceBindingV1;
  readonly declaration: TaskSourceDeclaration;
  readonly provider: TaskSourceProviderV1;
}
export interface TaskSourceRegistry {
  stage(binding: SourceBindingV1, declaration: TaskSourceDeclaration, provider: TaskSourceProviderV1): TaskSourceRegistration;
  publish(registrations: readonly TaskSourceRegistration[]): void;
  removePlugin(pluginId: string): void;
  list(purpose?: SourceResolutionPurpose): readonly TaskSourceRegistration[];
  resolve(instance: SourceInstanceV1, purpose: SourceResolutionPurpose): TaskSourceRegistration;
}
const bindingKey = (binding: SourceBindingV1) => JSON.stringify([binding.pluginId, binding.providerId, binding.artifactHash, binding.contractVersion]);
export function createTaskSourceRegistry(options: { eligible(binding: SourceBindingV1, purpose: SourceResolutionPurpose): boolean }): TaskSourceRegistry {
  const registered = new Map<string, TaskSourceRegistration>();
  const staged = new WeakSet<TaskSourceRegistration>();
  return {
    stage(binding, declaration, provider) {
      const parsed = parseSourceBindingV1(binding);
      if (parsed.connectionId !== null || parsed.credentialHandle !== null) throw new PersistenceConflictError('Registrations cannot capture an instance connection');
      validateTaskSourceProvider(provider, declaration);
      const registration = Object.freeze({ binding: parsed, declaration: Object.freeze({ identityFormats: Object.freeze([...declaration.identityFormats]), effectIds: Object.freeze([...declaration.effectIds]), commandIds: Object.freeze([...declaration.commandIds]), access: Object.freeze([...declaration.access]) }), provider });
      staged.add(registration); return registration;
    },
    publish(registrations) {
      const keys = new Set<string>();
      for (const registration of registrations) {
        const key = bindingKey(registration.binding);
        if (!staged.has(registration) || registered.has(key) || keys.has(key)) throw new PersistenceConflictError('Duplicate or unstaged task source registration');
        validateTaskSourceProvider(registration.provider, registration.declaration); keys.add(key);
      }
      for (const registration of registrations) { registered.set(bindingKey(registration.binding), registration); staged.delete(registration); }
    },
    removePlugin(pluginId) { for (const [key, value] of registered) if (value.binding.pluginId === pluginId) registered.delete(key); },
    list(purpose = 'admission') { return [...registered.values()].filter(value => options.eligible(value.binding, purpose)).sort((a, b) => bindingKey(a.binding).localeCompare(bindingKey(b.binding))); },
    resolve(input, purpose) {
      const instance = parseSourceInstanceV1(input);
      if (purpose === 'admission' && !instance.desiredEnabled) throw new PersistenceConflictError('Task source instance is disabled');
      const registration = registered.get(bindingKey(instance.binding));
      if (!registration || !options.eligible(instance.binding, purpose)) throw new PersistenceConflictError('Pinned task source provider is unavailable');
      if (instance.authority && !registration.declaration.identityFormats.includes(instance.authority.identityFormat)) throw new PersistenceConflictError('Task source identity format is unsupported');
      return registration;
    },
  };
}

export function selectTaskSourceInstance(input: {
  instances: readonly SourceInstanceV1[];
  repo: string;
  sourceId?: string;
  selections?: readonly (string | null | undefined)[];
  registry: TaskSourceRegistry;
}): SourceInstanceV1 {
  const eligible = (instance: SourceInstanceV1) => {
    if (input.sourceId && instance.sourceId !== input.sourceId || !instance.allowedRepos.includes(input.repo)) return false;
    try { input.registry.resolve(instance, 'admission'); return true; } catch { return false; }
  };
  const explicit = input.selections?.find(value => value !== null && value !== undefined);
  if (explicit !== undefined) {
    const selected = input.instances.find(instance => instance.id === explicit);
    if (!selected || !eligible(selected)) throw new PersistenceConflictError('Explicit task source selection is unavailable');
    return selected;
  }
  const candidates = input.instances.filter(eligible);
  if (candidates.length !== 1) throw new PersistenceConflictError(candidates.length ? 'Task source selection is ambiguous' : 'No task source is available');
  return candidates[0]!;
}
