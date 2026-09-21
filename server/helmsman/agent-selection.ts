import { isContributionId } from '../../src/plugins/manifest';
import { parseAgentSelectionV1, type AgentProviderRegistry, type AgentSelectionV1 } from './agent-providers';
import { readAgentProviderSelection } from './plugins/data';

export interface ResolvedAgentSelection { readonly selection: AgentSelectionV1; readonly revision: string; }
export interface AgentSelectionOptions {
  readonly root: string; readonly registry: AgentProviderRegistry; readonly writer?: string; readonly reviewerCount: number;
  readonly defaults: { readonly writer: string; readonly reviewers: readonly string[] };
}
export function resolveAgentSelection(options: AgentSelectionOptions): ResolvedAgentSelection {
  if (!Number.isSafeInteger(options.reviewerCount) || options.reviewerCount < 0 || options.reviewerCount > 8) throw new Error('Invalid agent reviewer count');
  const selected = readAgentProviderSelection(options.root);
  const registrations = options.registry.list();
  const resolve = (id: string) => {
    if (!isContributionId(id)) throw new Error('Invalid selected agent provider');
    const value = registrations.find(value => value.record.binding.providerId === id);
    if (!value) throw new Error('Selected agent provider is unavailable'); return value.record;
  };
  const writer = resolve(options.writer ?? selected.writer ?? options.defaults.writer);
  const ids = selected.reviewers ?? [...new Set([writer.binding.providerId, ...options.defaults.reviewers])];
  if (ids.length < options.reviewerCount) throw new Error('Selected agent reviewers are unavailable');
  const reviewers = ids.slice(0, options.reviewerCount).map(resolve);
  if (options.reviewerCount && !reviewers.some(value => value.binding.providerId === writer.binding.providerId)) throw new Error('Selected agent reviewers must include the writer');
  if (options.reviewerCount && (!writer.metadata.supportsPrePr || reviewers.some(value => !value.metadata.supportsPrePr))) throw new Error('Selected agent does not support the required pre-PR workflow');
  return Object.freeze({ selection: parseAgentSelectionV1({ version: 1, writer, reviewers }), revision: selected.revision });
}
export function assertAgentSelectionCurrent(options: { root: string; registry: AgentProviderRegistry }, resolved: ResolvedAgentSelection): void {
  if (readAgentProviderSelection(options.root).revision !== resolved.revision) throw new Error('Agent selection changed before admission');
  const selection = parseAgentSelectionV1(resolved.selection);
  for (const record of [selection.writer, ...selection.reviewers]) options.registry.assertCurrent(record);
}
