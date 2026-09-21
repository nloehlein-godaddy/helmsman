import type { PluginJson } from '../../src/plugins/backend';
import { parseExecutionHostReferenceV1, type ExecutionHostProviderV1, type ExecutionHostReferenceV1 } from '../../src/plugins/execution-host';
import { isContributionId } from '../../src/plugins/manifest';
import type { AgentTask } from './agents/adapter';
import { mergeExecutionArtifacts } from './agent-execution';
import { parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { loadRetainedExecutionHostProvider } from './execution-host-retained-loader';
import type { ExecutionSnapshotInput, ProviderBinding } from './execution-store';
import { persistedJson, persistenceHash } from './persistence';
import { launchIdentity, type HostRef, type LaunchSpec, type RunHost } from './run-host';
import { applicationRoot, isHostCoordinatorCommand, retainedRuntimePath } from './runtime-paths';

export function retainedLegacyHostKind(row: { hostKind?: string | null }, snapshot: ExecutionSnapshotInput): Exclude<HostRef['kind'], 'plugin'> {
  const binding = snapshot.bindings.find(value => value.role === 'host');
  if (binding?.capability !== 'host' || !['detached', 'cmux', 'wezterm', 'docker'].includes(binding.contributionId)
    || row.hostKind != null && binding.contributionId !== row.hostKind) throw new Error('The original legacy execution host is unavailable');
  return binding.contributionId as Exclude<HostRef['kind'], 'plugin'>;
}

export function parsePluginHostRef(input: unknown): Extract<HostRef, { kind: 'plugin' }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid plugin host reference');
  const value = input as Record<string, unknown>;
  if (value.kind !== 'plugin' || !isContributionId(value.providerId)) throw new Error('Invalid plugin host reference');
  const reference = parseExecutionHostReferenceV1(value.reference);
  if (persistenceHash(value.ownership) !== persistenceHash(reference.identity)) throw new Error('Plugin host ownership differs from its reference');
  return { kind: 'plugin', providerId: value.providerId, reference, ownership: reference.identity };
}

export function hostExecutionSnapshot(snapshot: ExecutionSnapshotInput, task: AgentTask): ExecutionSnapshotInput {
  if (!task.executionHost) return snapshot;
  const record = parseExecutionHostRetainedProviderV1(task.executionHost);
  if (!task.hostRuntime || task.hostConfiguration === undefined) throw new Error('Retained execution host configuration is unavailable');
  const artifacts = mergeExecutionArtifacts(snapshot.artifacts, task.hostRuntime.artifacts);
  const binding = record.binding;
  if (!artifacts.some(value => value.pluginId === binding.pluginId && value.artifactHash === binding.artifactHash)) throw new Error('Retained execution host artifact is unavailable');
  const host: ProviderBinding = { role: 'host', capability: 'helmsman/execution-host', contributionId: binding.providerId,
    pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null };
  return { ...snapshot, artifacts, bindings: [...snapshot.bindings.filter(value => value.role !== 'host'), host],
    settings: { ...snapshot.settings, host: persistedJson({ provider: record, configuration: task.hostConfiguration }) } };
}

export function verifyHostExecution(task: AgentTask, snapshot: ExecutionSnapshotInput): void {
  if (!task.executionHost && snapshot.settings.host === undefined) return;
  const record = parseExecutionHostRetainedProviderV1(task.executionHost);
  if (task.hostConfiguration === undefined || persistenceHash({ provider: record, configuration: task.hostConfiguration }) !== persistenceHash(snapshot.settings.host)) {
    throw new Error('Saved execution host differs from the immutable snapshot');
  }
  const expected = hostExecutionSnapshot(snapshot, task);
  if (persistenceHash(expected.artifacts) !== persistenceHash(snapshot.artifacts)
    || persistenceHash(expected.bindings.map(persistenceHash).sort()) !== persistenceHash(snapshot.bindings.map(persistenceHash).sort())) {
    throw new Error('Saved execution host bindings differ from the immutable snapshot');
  }
}

export function executionHostAdapter(input: {
  runId: string; providerId: string; provider: ExecutionHostProviderV1; configuration: PluginJson; wrapperPath: string; runtimeRoot: string;
}): RunHost {
  const specFor = (spec: LaunchSpec) => {
    const identity = launchIdentity(spec);
    if (!identity || identity.runId !== input.runId) throw new Error('Execution host requires this run’s durable launch identity');
    const remap = (value: string) => retainedRuntimePath(value, applicationRoot(), input.runtimeRoot);
    return { ...spec, ...identity, version: 1 as const, cmd: remap(spec.cmd), args: spec.args.map(remap),
      wrapperPath: input.wrapperPath, coordinator: isHostCoordinatorCommand(spec), configuration: input.configuration };
  };
  const owned = (ref: ExecutionHostReferenceV1, identity?: ReturnType<typeof launchIdentity>): HostRef => {
    const reference = parseExecutionHostReferenceV1(ref);
    if (reference.identity.runId !== input.runId || identity && persistenceHash(identity) !== persistenceHash(reference.identity)) throw new Error('Execution host returned another launch identity');
    return { kind: 'plugin', providerId: input.providerId, reference, ownership: reference.identity };
  };
  const unwrap = (ref: HostRef): ExecutionHostReferenceV1 => {
    const parsed = parsePluginHostRef(ref);
    if (parsed.providerId !== input.providerId || parsed.reference.identity.runId !== input.runId) throw new Error('Execution host reference belongs to another retained provider or run');
    return parsed.reference;
  };
  return {
    kind: 'plugin',
    async launch(spec) { const launch = specFor(spec); return owned(await input.provider.launch(launch), launchIdentity(spec)); },
    async discover(spec, ref) {
      const launch = specFor(spec);
      const reference = ref ? unwrap(ref) : undefined;
      if (reference && persistenceHash(reference.identity) !== persistenceHash(launchIdentity(spec))) throw new Error('Execution host reference belongs to another attempt');
      const result = await input.provider.discover(launch, reference);
      if (result.status !== 'found') return result;
      if (result.evidence.runId !== launch.runId || result.evidence.launchId !== launch.launchId || result.evidence.attempt !== launch.attempt) throw new Error('Execution host discovery returned another attempt');
      return { ...result, ref: owned(result.ref, launchIdentity(spec)) };
    },
    isAlive: ref => input.provider.isAlive(unwrap(ref)),
    async stop(ref) {
      await input.provider.stop(unwrap(ref));
      await input.provider.stopStages?.(input.runId);
    },
  };
}

export async function loadExecutionHost(task: Pick<AgentTask, 'executionHost' | 'hostRuntime'>, signal?: AbortSignal) {
  const record = parseExecutionHostRetainedProviderV1(task.executionHost);
  if (!task.hostRuntime) throw new Error('Retained execution host runtime is unavailable');
  return loadRetainedExecutionHostProvider({ ...task.hostRuntime, record, signal });
}
