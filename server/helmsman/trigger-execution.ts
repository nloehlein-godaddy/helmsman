import type { AgentTask } from './agents/adapter';
import type { ArtifactBinding, ExecutionSnapshotInput } from './execution-store';
import { persistedJson, persistenceHash } from './persistence';
import { parseTriggerProvenanceV1 } from './trigger-provenance';

export function triggerExecutionSnapshot(snapshot: ExecutionSnapshotInput, task: Pick<AgentTask, 'trigger' | 'triggerReviewSource'>): ExecutionSnapshotInput {
  if (!task.trigger) return snapshot;
  const trigger = parseTriggerProvenanceV1(task.trigger);
  const artifacts = new Map<string, ArtifactBinding>();
  for (const artifact of [...snapshot.artifacts, ...trigger.artifacts, ...(task.triggerReviewSource?.artifacts ?? [])]) {
    const prior = artifacts.get(artifact.pluginId);
    if (prior && persistenceHash(prior) !== persistenceHash(artifact)) throw new Error('Conflicting trigger execution artifact');
    artifacts.set(artifact.pluginId, artifact);
  }
  return { ...snapshot, artifacts: [...artifacts.values()], settings: { ...snapshot.settings, trigger: persistedJson(trigger), ...(task.triggerReviewSource ? { triggerReviewSource: persistedJson(task.triggerReviewSource) } : {}) } };
}

export function verifyTriggerExecution(task: Pick<AgentTask, 'trigger' | 'triggerReviewSource'>, snapshot: ExecutionSnapshotInput): void {
  if (!task.trigger && snapshot.settings.trigger === undefined) return;
  if (!task.trigger || snapshot.settings.trigger === undefined
    || persistenceHash(parseTriggerProvenanceV1(task.trigger)) !== persistenceHash(snapshot.settings.trigger)) throw new Error('Saved trigger differs from execution provenance');
  if ((task.triggerReviewSource === undefined) !== (snapshot.settings.triggerReviewSource === undefined)
    || task.triggerReviewSource && persistenceHash(task.triggerReviewSource) !== persistenceHash(snapshot.settings.triggerReviewSource)) throw new Error('Saved trigger review source differs from execution provenance');
  if (persistenceHash(triggerExecutionSnapshot(snapshot, task).artifacts) !== persistenceHash(snapshot.artifacts)) throw new Error('Trigger execution artifact closure is incomplete');
}
