// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AgentProviderV1 } from '../../src/plugins/agent-provider';
import type { ExecutionSnapshotInput } from './execution-store';
import type { AgentTask } from './agents/adapter';
import { agentProviderAdapter } from './agents/provider';
import { verifyWorkflowExecution, workflowExecutionSnapshot, workflowPromptProjection } from './workflow-execution';

const agentMetadata = { version: 1 as const, label: 'Agent', defaults: { model: 'agent/model', effort: 'high' },
  review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } },
  reviewSkills: [], reviewDelegation: 'native-subagents' as const, supportsPrePr: true, docker: null, costReporting: 'delta' as const };
const agent = { version: 1 as const, binding: { providerId: 'example.agent/agent', pluginId: 'example.agent', artifactHash: 'a'.repeat(64), contractVersion: 1 as const },
  origin: 'external' as const, settings: {}, metadata: agentMetadata };
const workflow = { version: 1 as const, binding: { providerId: 'example.workflow/coding', pluginId: 'example.workflow', artifactHash: 'b'.repeat(64), contractVersion: 1 as const },
  origin: 'external' as const, settings: { maxRounds: 4 }, metadata: { version: 1 as const, label: 'Workflow', modes: ['coding' as const], execution: 'staged' as const,
    requiredSkills: [], maxRounds: 4, stageTimeoutMinutes: 30 } };
const workflowArtifact = { pluginId: workflow.binding.pluginId, artifactHash: workflow.binding.artifactHash, packageVersion: '1.0.0', requires: [] };
const task: AgentTask = { ticketId: 'T-1', title: 'Safe workflow projection', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.test', jiraContext: 'Acceptance criteria',
  model: 'selected/model', effort: 'xhigh', skillsPath: '/runtime/skills', agentSelection: { version: 1, writer: agent, reviewers: [agent] }, workflow,
  workflowRuntime: { pluginsRoot: '/private/plugins', runtimeArtifactsRoot: '/private/artifacts', artifacts: [workflowArtifact] },
  hostIsolation: { runId: 'run-1', gatewayUrl: 'http://private', capability: 'secret', runtimeRoot: '/private/runtime' },
  clarification: { questionsPath: '/runtime/questions.jsonl', answersPath: '/runtime/answers.jsonl', gateUrl: 'http://private/gate', gateToken: 'secret' },
  prePr: { stage: 'review', baseSha: 'c'.repeat(40), headSha: 'd'.repeat(40), reportPath: '/runtime/report.json', round: 2 } };

function snapshot(): ExecutionSnapshotInput {
  const artifact = { pluginId: 'helmsman.runtime', artifactHash: 'e'.repeat(64), packageVersion: '1.0.0', requires: [] };
  return { version: 1, runId: 'run-1', attempt: 1, repo: task.repo, logicalWork: { source: 'test', instance: 'local', taskId: task.ticketId }, task: {},
    workflowSnapshotId: null, artifacts: [artifact], bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached',
      pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null },
    { role: 'workflow', capability: 'workflow', contractVersion: 1, contributionId: 'coding', pluginId: artifact.pluginId,
      artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }], settings: {}, schemas: [],
    provenance: { kind: 'admission', evidence: {} } };
}

describe('retained workflow execution', () => {
  it('projects only validated prompt data after host path remapping', () => {
    const projected = workflowPromptProjection(task, agent);
    expect(projected).toMatchObject({ runtime: { providerId: agent.binding.providerId, model: 'selected/model', effort: 'xhigh' },
      task: { repo: task.repo, skillsPath: '/runtime/skills' }, stage: { stage: 'review', reportPath: '/runtime/report.json' } });
    expect(projected.clarificationInstructions).toContain('/runtime/questions.jsonl');
    const json = JSON.stringify(projected);
    for (const secret of ['secret', '/private/plugins', '/private/artifacts', '/private/runtime', 'gateUrl', 'workflowRuntime', 'agentSelection']) expect(json).not.toContain(secret);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.task)).toBe(true);
    expect(Object.isFrozen(projected.stage)).toBe(true);
  });

  it('replaces the legacy workflow binding with the exact retained provider and verifies it', () => {
    const captured = workflowExecutionSnapshot(snapshot(), task);
    expect(captured.bindings.filter(binding => binding.role === 'workflow')).toEqual([{ role: 'workflow', capability: 'helmsman/workflow', contractVersion: 1,
      contributionId: workflow.binding.providerId, pluginId: workflow.binding.pluginId, artifactHash: workflow.binding.artifactHash, connectionId: null, credentialHandle: null }]);
    expect(captured.settings.workflow).toEqual(workflow);
    expect(captured.artifacts).toContainEqual(workflowArtifact);
    expect(verifyWorkflowExecution(task, captured)).toEqual(workflow);
    expect(() => verifyWorkflowExecution({ ...task, workflow: { ...workflow, settings: { maxRounds: 2 } } }, captured)).toThrow('immutable execution snapshot');
    expect(() => workflowExecutionSnapshot(snapshot(), { ...task, workflowRuntime: { ...task.workflowRuntime!, artifacts: [] } })).toThrow('artifact closure');
  });

  it('never falls back to core prompts for a task with a retained workflow', () => {
    const buildCommand = vi.fn<AgentProviderV1['buildCommand']>(input => ({ cmd: 'agent', args: [input.prompt] }));
    const provider: AgentProviderV1 = { metadata: agentMetadata, buildCommand, parseLine: () => null };
    expect(() => agentProviderAdapter(agent, provider).buildCommand(task)).toThrow('renderer is unavailable');
    expect(agentProviderAdapter(agent, provider, () => 'authored prompt').buildCommand(task)).toEqual({ cmd: 'agent', args: ['authored prompt'] });
    expect(buildCommand).toHaveBeenCalledOnce();
  });
});
