import type { AgentAdapter, AgentTask } from './agents/adapter';
import { agentProviderAdapter } from './agents/provider';
import { parseAgentSelectionV1, type AgentSelectionV1 } from './agent-providers';
import { loadRetainedAgentProvider } from './agent-retained-loader';
import type { ArtifactBinding, ExecutionSnapshotInput, ProviderBinding } from './execution-store';
import { persistedJson, persistenceHash } from './persistence';

export function mergeExecutionArtifacts(...groups: readonly (readonly ArtifactBinding[])[]): readonly ArtifactBinding[] {
  const result = new Map<string, ArtifactBinding>();
  for (const artifact of groups.flat()) {
    const existing = result.get(artifact.pluginId);
    if (existing && persistenceHash(existing) !== persistenceHash(artifact)) throw new Error('Conflicting execution artifact');
    result.set(artifact.pluginId, artifact);
  }
  return [...result.values()];
}

export function agentExecutionSnapshot(snapshot: ExecutionSnapshotInput, task: AgentTask): ExecutionSnapshotInput {
  if (!task.agentSelection) return snapshot;
  const selection = parseAgentSelectionV1(task.agentSelection);
  if (!task.agentRuntime) throw new Error('Retained agent runtime is unavailable');
  const artifacts = mergeExecutionArtifacts(snapshot.artifacts, task.agentRuntime.artifacts);
  const providers = new Map([selection.writer, ...selection.reviewers].map(record => [record.binding.providerId, record]));
  const bindings: ProviderBinding[] = [...providers.values()].map(record => {
    const binding = record.binding;
    if (!artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) throw new Error('Retained agent artifact is unavailable');
    return { role: 'agent', capability: 'helmsman/agent', contributionId: binding.providerId, pluginId: binding.pluginId,
      artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null };
  });
  return { ...snapshot, artifacts, bindings: [...snapshot.bindings.filter(binding => binding.role !== 'agent'), ...bindings],
    settings: { ...snapshot.settings, agents: persistedJson(selection) } };
}

export function verifyAgentExecution(task: AgentTask, snapshot: ExecutionSnapshotInput): AgentSelectionV1 | null {
  if (!task.agentSelection && snapshot.settings.agents === undefined) return null;
  const selection = parseAgentSelectionV1(task.agentSelection);
  if (persistenceHash(selection) !== persistenceHash(snapshot.settings.agents)) throw new Error('Saved agents differ from the immutable execution snapshot');
  const expected = agentExecutionSnapshot(snapshot, task);
  if (persistenceHash(expected.artifacts) !== persistenceHash(snapshot.artifacts)
    || persistenceHash(expected.bindings.map(persistenceHash).sort()) !== persistenceHash(snapshot.bindings.map(persistenceHash).sort())) throw new Error('Saved agent artifacts or bindings differ from the execution snapshot');
  return selection;
}

export async function loadExecutionAgents(task: Pick<AgentTask, 'agentSelection' | 'agentRuntime'>, signal?: AbortSignal): Promise<{ writer: AgentAdapter; dispose(): Promise<void> }> {
  const selection = parseAgentSelectionV1(task.agentSelection);
  const runtime = task.agentRuntime;
  if (!runtime) throw new Error('Retained agent runtime is unavailable');
  const loaded: Array<Awaited<ReturnType<typeof loadRetainedAgentProvider>>> = [];
  const dispose = async () => { for (const value of loaded.splice(0).reverse()) await value.dispose(); };
  try {
    let writer: AgentAdapter | undefined;
    for (const record of new Map([selection.writer, ...selection.reviewers].map(record => [record.binding.providerId, record])).values()) {
      const value = await loadRetainedAgentProvider({ ...runtime, record, signal });
      loaded.push(value);
      if (record.binding.providerId === selection.writer.binding.providerId) writer = agentProviderAdapter(record, value.provider);
    }
    if (!writer) throw new Error('Retained writer is unavailable');
    return { writer, dispose };
  } catch (error) { await dispose(); throw error; }
}
