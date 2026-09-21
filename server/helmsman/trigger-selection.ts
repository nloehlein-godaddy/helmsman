import { parseTriggerRoleV1, type TriggerMetadataV1, type TriggerSelectionRoleV1 } from '../../src/plugins/trigger';
import { parseTriggerRetainedProviderV1, type TriggerProviderRegistry, type TriggerRetainedProviderV1 } from './trigger-providers';
import { readTriggerProviderSelection } from './plugins/data';

export const DEFAULT_TRIGGER_PROVIDERS: Readonly<Record<TriggerSelectionRoleV1, string>> = Object.freeze({ campaign: 'helmsman.trigger-campaign/dispatch', 'slack-review': 'helmsman.trigger-slack-review/watch', 'github-review': 'helmsman.trigger-github-review/watch', 'github-webhook': 'helmsman.trigger-github-webhook/github' });
export interface ResolvedTriggerSelection { readonly record: TriggerRetainedProviderV1 | null; readonly revision: string; readonly kind: TriggerSelectionRoleV1; }
export function triggerMatchesRole(metadata: TriggerMetadataV1, role: TriggerSelectionRoleV1): boolean {
  if (role === 'campaign') return metadata.kind === 'campaign';
  if (role === 'github-webhook') return metadata.kind === 'webhook';
  return metadata.kind === 'review-watch' && metadata.source === (role === 'slack-review' ? 'communication' : 'pull-request');
}
export function resolveTriggerSelection(options: { root: string; registry: TriggerProviderRegistry; kind: TriggerSelectionRoleV1 }): ResolvedTriggerSelection {
  const kind = parseTriggerRoleV1(options.kind); const selected = readTriggerProviderSelection(options.root, kind);
  if (selected.providerId === null) return Object.freeze({ record: null, revision: selected.revision, kind });
  const id = selected.providerId === 'default' ? DEFAULT_TRIGGER_PROVIDERS[kind] : selected.providerId;
  const registration = options.registry.list().find(value => value.record.binding.providerId === id);
  if (!registration) throw new Error('Selected trigger provider is unavailable');
  if (!triggerMatchesRole(registration.record.metadata, kind)) throw new Error('Selected trigger does not support the selection role');
  return Object.freeze({ record: registration.record, revision: selected.revision, kind });
}
export function assertTriggerSelectionCurrent(options: { root: string; registry: TriggerProviderRegistry }, resolved: ResolvedTriggerSelection): void {
  const kind = parseTriggerRoleV1(resolved.kind);
  if (readTriggerProviderSelection(options.root, kind).revision !== resolved.revision) throw new Error('Trigger selection changed before admission');
  if (resolved.record === null) return;
  const record = parseTriggerRetainedProviderV1(resolved.record);
  if (!triggerMatchesRole(record.metadata, kind)) throw new Error('Selected trigger does not support the selection role');
  options.registry.assertCurrent(record);
}
