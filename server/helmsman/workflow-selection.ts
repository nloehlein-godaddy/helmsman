import { isContributionId } from '../../src/plugins/manifest';
import { parseWorkflowModeV1, type WorkflowModeV1 } from '../../src/plugins/workflow';
import { parseWorkflowRetainedProviderV1, type WorkflowProviderRegistry, type WorkflowRetainedProviderV1 } from './workflow-providers';
import { readWorkflowProviderSelection } from './plugins/data';

export const DEFAULT_WORKFLOW_PROVIDERS: Readonly<Record<WorkflowModeV1, string>> = Object.freeze({ coding: 'helmsman.workflow-coding/coding', review: 'helmsman.workflow-review/review', branch: 'helmsman.workflow-coding/branch' });
export interface ResolvedWorkflowSelection { readonly record: WorkflowRetainedProviderV1; readonly revision: string; readonly mode: WorkflowModeV1; }
export function canonicalWorkflowProviderId(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid workflow provider reference');
  if (value === 'coding@1') return DEFAULT_WORKFLOW_PROVIDERS.coding;
  if (value === 'review@1') return DEFAULT_WORKFLOW_PROVIDERS.review;
  const id = value.endsWith('@1') ? value.slice(0, -2) : value;
  if (!isContributionId(id)) throw new Error('Invalid workflow provider reference'); return id;
}
export function resolveWorkflowSelection(options: { root: string; registry: WorkflowProviderRegistry; mode: WorkflowModeV1; providerId?: string }): ResolvedWorkflowSelection {
  const mode = parseWorkflowModeV1(options.mode); const selected = readWorkflowProviderSelection(options.root, mode);
  const providerId = canonicalWorkflowProviderId(options.providerId ?? selected.providerId ?? DEFAULT_WORKFLOW_PROVIDERS[mode]);
  const registration = options.registry.list().find(value => value.record.binding.providerId === providerId);
  if (!registration) throw new Error('Selected workflow provider is unavailable');
  if (!registration.record.metadata.modes.includes(mode) || (registration.record.metadata.execution === 'staged') !== (mode === 'coding')) throw new Error('Selected workflow does not support the task mode');
  return Object.freeze({ record: registration.record, revision: selected.revision, mode });
}
export function assertWorkflowSelectionCurrent(options: { root: string; registry: WorkflowProviderRegistry }, resolved: ResolvedWorkflowSelection): void {
  const mode = parseWorkflowModeV1(resolved.mode);
  if (readWorkflowProviderSelection(options.root, mode).revision !== resolved.revision) throw new Error('Workflow selection changed before admission');
  const record = parseWorkflowRetainedProviderV1(resolved.record);
  if (!record.metadata.modes.includes(mode) || (record.metadata.execution === 'staged') !== (mode === 'coding')) throw new Error('Selected workflow does not support the task mode');
  options.registry.assertCurrent(record);
}
