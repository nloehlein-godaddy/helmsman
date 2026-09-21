import { readSchedulingProviderSelection } from './plugins/data';
import type { SchedulingProviderRegistry, SchedulingProviderSelection } from './scheduling-providers';

export function resolveSelectedSchedulingProvider(options: {
  root: string; registry: SchedulingProviderRegistry; defaultProvider: string;
}): SchedulingProviderSelection {
  const selected = readSchedulingProviderSelection(options.root);
  const registration = options.registry.list().find(value => value.binding.providerId === (selected.providerId ?? options.defaultProvider));
  if (!registration) throw new Error('Selected scheduling provider is unavailable');
  return Object.freeze({ registration, revision: selected.revision });
}
