import { parseWorkflowPromptInputV1, type WorkflowModeV1, type WorkflowPromptInputV1, type WorkflowProviderV1 } from '../../src/plugins/workflow';
import type { AgentRetainedProviderV1 } from './agent-providers';
import type { AgentTask } from './agents/adapter';
import { clarificationPrompt } from './agents/clarification-prompt';
import { agentAttribution, appendAgentByline } from './agent-attribution';
import type { ArtifactBinding, ExecutionSnapshotInput, ProviderBinding } from './execution-store';
import { loadRetainedWorkflowProvider } from './workflow-retained-loader';
import { parseWorkflowRetainedProviderV1, type WorkflowRetainedProviderV1 } from './workflow-providers';
import { persistedJson, persistenceHash } from './persistence';

export type WorkflowPromptRenderer = (task: AgentTask, agent: AgentRetainedProviderV1) => string;

function mergeWorkflowArtifacts(first: readonly ArtifactBinding[], second: readonly ArtifactBinding[]): readonly ArtifactBinding[] {
  const result = new Map(first.map(artifact => [artifact.pluginId, artifact]));
  for (const artifact of second) {
    const prior = result.get(artifact.pluginId);
    if (prior && persistenceHash(prior) !== persistenceHash(artifact)) throw new Error('Conflicting execution artifact');
    result.set(artifact.pluginId, artifact);
  }
  return [...result.values()];
}

export function workflowMode(task: Pick<AgentTask, 'review' | 'prBranch' | 'prePr'>): WorkflowModeV1 {
  if (task.review) return 'review';
  if (task.prBranch && !task.prePr) return 'branch';
  return 'coding';
}

export function workflowPromptProjection(task: AgentTask, agent: AgentRetainedProviderV1): WorkflowPromptInputV1 {
  const role = task.review || task.prePr?.stage === 'review' ? 'review agent' : 'PR author';
  const stage = task.prePr ? {
    stage: task.prePr.stage,
    baseSha: task.prePr.baseSha,
    ...(task.prePr.headSha !== undefined ? { headSha: task.prePr.headSha } : {}),
    reportPath: task.prePr.reportPath,
    ...(task.prePr.feedback !== undefined ? { feedback: task.prePr.feedback } : {}),
    ...(task.prePr.round !== undefined ? { round: task.prePr.round } : {}),
    ...(task.prePr.incompleteReview !== undefined ? { incompleteReview: { ...task.prePr.incompleteReview } } : {}),
    ...(task.prePr.summaryCorrection ? { summaryCorrection: { ...task.prePr.summaryCorrection } } : {}),
  } : null;
  return parseWorkflowPromptInputV1({
    version: 1,
    runtime: {
      providerId: agent.binding.providerId,
      model: task.model ?? agent.metadata.defaults.model ?? null,
      effort: task.effort ?? agent.metadata.defaults.effort ?? null,
      reviewDelegation: agent.metadata.reviewDelegation,
    },
    byline: appendAgentByline('', agentAttribution(agent.binding.providerId, task, role)),
    clarificationInstructions: clarificationPrompt(task),
    task: {
      ticketId: task.ticketId,
      title: task.title,
      repo: task.repo,
      jiraBaseUrl: task.jiraBaseUrl,
      ...(task.jiraContext !== undefined ? { jiraContext: task.jiraContext } : {}),
      ...(task.task !== undefined ? { task: task.task } : {}),
      ...(task.prBranch !== undefined ? { prBranch: task.prBranch } : {}),
      ...(task.prNumber !== undefined ? { prNumber: task.prNumber } : {}),
      ...(task.review !== undefined ? { review: task.review } : {}),
      ...(task.prHeadSha !== undefined ? { prHeadSha: task.prHeadSha } : {}),
      ...(task.skillsPath !== undefined ? { skillsPath: task.skillsPath } : {}),
      ...(task.reviewOutputPaths ? { reviewOutputPaths: { ...task.reviewOutputPaths } } : {}),
    },
    stage,
  });
}

export function workflowExecutionSnapshot(snapshot: ExecutionSnapshotInput, task: AgentTask): ExecutionSnapshotInput {
  if (!task.workflow) return snapshot;
  const record = parseWorkflowRetainedProviderV1(task.workflow);
  if (!task.workflowRuntime) throw new Error('Retained workflow runtime is unavailable');
  if (!task.workflowRuntime.artifacts.some(artifact => artifact.pluginId === record.binding.pluginId && artifact.artifactHash === record.binding.artifactHash)) {
    throw new Error('Retained workflow artifact closure is unavailable');
  }
  const artifacts = mergeWorkflowArtifacts(snapshot.artifacts, task.workflowRuntime.artifacts);
  const binding = record.binding;
  if (!artifacts.some(artifact => artifact.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) {
    throw new Error('Retained workflow artifact is unavailable');
  }
  const workflowBinding: ProviderBinding = { role: 'workflow', capability: 'helmsman/workflow', contributionId: binding.providerId,
    pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null };
  return { ...snapshot, artifacts, bindings: [...snapshot.bindings.filter(item => item.role !== 'workflow'), workflowBinding],
    settings: { ...snapshot.settings, workflow: persistedJson(record) } };
}

export function verifyWorkflowExecution(task: AgentTask, snapshot: ExecutionSnapshotInput): WorkflowRetainedProviderV1 | null {
  if (!task.workflow && snapshot.settings.workflow === undefined) return null;
  if (!task.workflow) throw new Error('Saved workflow is missing from the retained task');
  const record = parseWorkflowRetainedProviderV1(task.workflow);
  if (persistenceHash(record) !== persistenceHash(snapshot.settings.workflow)) throw new Error('Saved workflow differs from the immutable execution snapshot');
  const expected = workflowExecutionSnapshot(snapshot, task);
  if (persistenceHash(expected.artifacts) !== persistenceHash(snapshot.artifacts)
    || persistenceHash(expected.bindings.map(persistenceHash).sort()) !== persistenceHash(snapshot.bindings.map(persistenceHash).sort())) {
    throw new Error('Saved workflow artifacts or binding differ from the execution snapshot');
  }
  return record;
}

export async function loadExecutionWorkflow(task: Pick<AgentTask, 'workflow' | 'workflowRuntime' | 'review' | 'prBranch' | 'prePr'>,
  signal?: AbortSignal): Promise<{ record: WorkflowRetainedProviderV1; provider: WorkflowProviderV1; renderPrompt: WorkflowPromptRenderer;
    assertMode(task: Pick<AgentTask, 'review' | 'prBranch' | 'prePr'>): void; dispose(): Promise<void> } | null> {
  if (!task.workflow) return null;
  const record = parseWorkflowRetainedProviderV1(task.workflow);
  const runtime = task.workflowRuntime;
  if (!runtime) throw new Error('Retained workflow runtime is unavailable');
  const loaded = await loadRetainedWorkflowProvider({ ...runtime, record, signal });
  const assertMode = (modeTask: Pick<AgentTask, 'review' | 'prBranch' | 'prePr'>) => {
    const mode = workflowMode(modeTask);
    if (!record.metadata.modes.includes(mode)) throw new Error(`Retained workflow does not support ${mode} execution`);
  };
  return {
    record,
    provider: loaded.provider,
    assertMode,
    renderPrompt: (renderTask, agent) => {
      assertMode(renderTask);
      return loaded.provider.renderPrompt(workflowPromptProjection(renderTask, agent));
    },
    dispose: loaded.dispose,
  };
}
