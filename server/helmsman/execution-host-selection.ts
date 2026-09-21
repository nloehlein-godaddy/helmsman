import { isContributionId } from '../../src/plugins/manifest';
import { parseExecutionHostRetainedProviderV1, type ExecutionHostProviderRegistry, type ExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { readExecutionHostProviderSelection } from './plugins/data';

export interface ResolvedExecutionHostSelection { readonly record: ExecutionHostRetainedProviderV1; readonly revision: string; }
export function resolveExecutionHostSelection(options: { root: string; registry: ExecutionHostProviderRegistry; defaultProviderId: string }): ResolvedExecutionHostSelection {
  const selected = readExecutionHostProviderSelection(options.root);
  const providerId = selected.providerId ?? options.defaultProviderId;
  if (!isContributionId(providerId)) throw new Error('Invalid selected execution host');
  const registration = options.registry.list().find(value => value.record.binding.providerId === providerId);
  if (!registration) throw new Error('Selected execution host provider is unavailable');
  return Object.freeze({ record: registration.record, revision: selected.revision });
}
export function assertExecutionHostSelectionCurrent(options: { root: string; registry: ExecutionHostProviderRegistry }, resolved: ResolvedExecutionHostSelection): void {
  if (readExecutionHostProviderSelection(options.root).revision !== resolved.revision) throw new Error('Execution host selection changed before admission');
  options.registry.assertCurrent(parseExecutionHostRetainedProviderV1(resolved.record));
}
