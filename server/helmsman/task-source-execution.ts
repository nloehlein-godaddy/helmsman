import { parseTaskSnapshotV1, type TaskSnapshotV1 } from '../../src/plugins/tasks';
import type { PluginJson } from '../../src/plugins/backend';
import type { AgentTask } from './agents/adapter';
import type { AppConfig } from '../config';
import type { ArtifactBinding, ExecutionSnapshotInput, ProviderBinding } from './execution-store';
import { legacyExecutionSettings, legacyExecutionSnapshot } from './legacy-execution-snapshot';
import { persistedJson, persistenceHash } from './persistence';
import type { StoredTaskSnapshot, WorkClaimRecord } from './task-sources/store';

function contacts(input: TaskSnapshotV1['providerData']): AgentTask['contactHints'] {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('contactHints' in input)) return undefined;
  const hints = input.contactHints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return undefined;
  const entries = ['explicitContactId', 'assigneeId', 'reporterId'].flatMap(key => {
    const value = (hints as Readonly<Record<string, PluginJson>>)[key];
    return typeof value === 'string' && value.trim() && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value) ? [[key, value]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function sourceExecutionSettings(config: AppConfig, boundAgents = false, boundWorkflow = false) {
  return legacyExecutionSettings({ ...config, jira: null, botAccountId: null }, boundAgents, boundWorkflow);
}

export function sourceExecutionTask(snapshot: StoredTaskSnapshot, claim: WorkClaimRecord): AgentTask {
  const task = parseTaskSnapshotV1(snapshot.task, { sourceId: claim.ref.sourceId });
  if (claim.state !== 'claimed' || !claim.receipt || claim.taskSnapshotHash !== snapshot.hash
    || claim.ref.externalId !== task.ref.externalId || snapshot.instance.id !== claim.instance.id) throw new Error('Source claim is not ready for execution');
  const contactHints = contacts(task.providerData);
  return {
    ticketId: task.displayKey, title: task.title, repo: task.repo, jiraBaseUrl: '',
    source: { version: 1, taskSnapshotHash: snapshot.hash, claimId: claim.id, instanceId: snapshot.instance.id },
    ...(contactHints ? { contactHints } : {}),
    task: [
      `${task.displayKey}: ${task.title}`,
      `Description:\n${task.requirements.description}`,
      ...(task.requirements.acceptanceCriteria.length ? [`Acceptance criteria:\n${task.requirements.acceptanceCriteria.join('\n')}`] : []),
      ...(task.requirements.links.length ? [`References:\n${task.requirements.links.map(link => `${link.title}: ${link.url}`).join('\n')}`] : []),
      'Task source claims and status updates are managed by Helmsman. Do not modify the task source directly.',
    ].join('\n\n'),
  };
}

export function sourceExecutionSnapshot(input: Parameters<typeof legacyExecutionSnapshot>[0] & {
  source: StoredTaskSnapshot;
  claim: WorkClaimRecord;
  sourceArtifacts: readonly ArtifactBinding[];
}): ExecutionSnapshotInput {
  const metadata = input.task.source;
  const { source, claim } = input;
  if (!metadata || metadata.taskSnapshotHash !== source.hash || metadata.claimId !== claim.id
    || metadata.instanceId !== source.instance.id || claim.runId !== input.run.id
    || claim.taskSnapshotHash !== source.hash || source.task.repo !== input.run.repo) throw new Error('Execution source binding changed');
  const provider = source.instance.binding;
  if (!input.sourceArtifacts.some(artifact => artifact.pluginId === provider.pluginId && artifact.artifactHash === provider.artifactHash)) throw new Error('Source artifact closure is unavailable');
  const sourceBinding: ProviderBinding = { role: 'source', capability: 'helmsman/task-source', contributionId: provider.providerId,
    pluginId: provider.pluginId, artifactHash: provider.artifactHash, contractVersion: 1,
    connectionId: provider.connectionId, credentialHandle: provider.credentialHandle };
  const legacy = legacyExecutionSnapshot({ ...input, config: { ...input.config, jira: null, botAccountId: null } });
  const artifacts = new Map<string, ArtifactBinding>();
  for (const artifact of [...legacy.artifacts, ...input.sourceArtifacts]) {
    const existing = artifacts.get(artifact.pluginId);
    if (existing && persistenceHash(existing) !== persistenceHash(artifact)) throw new Error('Conflicting source artifact');
    artifacts.set(artifact.pluginId, artifact);
  }
  return { ...legacy,
    logicalWork: { source: source.task.ref.sourceId, instance: source.instance.id, taskId: source.task.ref.externalId },
    artifacts: [...artifacts.values()],
    bindings: [...legacy.bindings.filter(binding => binding.role !== 'source' && !(binding.role === 'effect' && binding.capability === 'jira')), sourceBinding],
    settings: { ...legacy.settings, source: persistedJson({ snapshotHash: source.hash, claimId: claim.id, instanceRevision: source.instance.revision }) },
    schemas: [...legacy.schemas, { owner: 'core.task-sources', minimum: 1, maximum: 1 },
      ...(provider.connectionId ? [{ owner: 'core.source-connections', minimum: 1, maximum: 1 }] : [])],
  };
}
