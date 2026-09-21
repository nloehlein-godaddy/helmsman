import { isContributionId } from '../../src/plugins/manifest';
import { parseNativeTerminalRetainedProviderV1, type NativeTerminalProviderRegistry, type NativeTerminalRetainedProviderV1 } from './native-terminal-providers';
import { readNativeTerminalProviderSelection, type NativeTerminalSelectionKind } from './plugins/data';

export interface ResolvedNativeTerminalSelection { readonly record: NativeTerminalRetainedProviderV1; readonly revision: string; readonly kind: NativeTerminalSelectionKind; }
export function resolveNativeTerminalSelection(options: { root: string; registry: NativeTerminalProviderRegistry; defaultProviderId: string; kind: NativeTerminalSelectionKind }): ResolvedNativeTerminalSelection {
  const selected = readNativeTerminalProviderSelection(options.root, options.kind);
  const providerId = selected.providerId ?? options.defaultProviderId;
  if (!isContributionId(providerId)) throw new Error('Invalid selected native terminal');
  const registration = options.registry.list().find(value => value.record.binding.providerId === providerId);
  if (!registration) throw new Error('Selected native terminal provider is unavailable');
  if (options.kind === 'browser' && !registration.record.metadata.browser) throw new Error('Selected native terminal does not support browser primitives');
  return Object.freeze({ record: registration.record, revision: selected.revision, kind: options.kind });
}
export function assertNativeTerminalSelectionCurrent(options: { root: string; registry: NativeTerminalProviderRegistry; kind?: NativeTerminalSelectionKind }, resolved: ResolvedNativeTerminalSelection): void {
  if (options.kind !== undefined && options.kind !== resolved.kind || readNativeTerminalProviderSelection(options.root, resolved.kind).revision !== resolved.revision) throw new Error('Native terminal selection changed before admission');
  const record = parseNativeTerminalRetainedProviderV1(resolved.record);
  if (resolved.kind === 'browser' && !record.metadata.browser) throw new Error('Selected native terminal does not support browser primitives');
  options.registry.assertCurrent(record);
}
