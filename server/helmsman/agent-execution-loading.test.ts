// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadAgent: vi.fn(), loadWorkflow: vi.fn() }));
vi.mock('./agent-retained-loader', () => ({ loadRetainedAgentProvider: mocks.loadAgent }));
vi.mock('./workflow-execution', () => ({ loadExecutionWorkflow: mocks.loadWorkflow }));

import type { AgentProviderV1 } from '../../src/plugins/agent-provider';
import type { AgentTask } from './agents/adapter';
import { loadExecutionAgents } from './agent-execution';

const metadata = { version: 1 as const, label: 'Agent', defaults: { model: null, effort: null },
  review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } },
  reviewSkills: [], reviewDelegation: 'none' as const, supportsPrePr: true, docker: null, costReporting: 'delta' as const };
const record = (name: string, hash: string) => ({ version: 1 as const, binding: { providerId: `example.${name}/agent`, pluginId: `example.${name}`, artifactHash: hash, contractVersion: 1 as const },
  origin: 'external' as const, settings: {}, metadata });
const writer = record('writer', 'a'.repeat(64));
const reviewer = record('reviewer', 'b'.repeat(64));
const workflow = { version: 1 as const, binding: { providerId: 'example.workflow/coding', pluginId: 'example.workflow', artifactHash: 'c'.repeat(64), contractVersion: 1 as const },
  origin: 'external' as const, settings: {}, metadata: { version: 1 as const, label: 'Workflow', modes: ['coding' as const], execution: 'staged' as const,
    requiredSkills: [], maxRounds: 3, stageTimeoutMinutes: 45 } };
const task: Pick<AgentTask, 'agentSelection' | 'agentRuntime' | 'workflow' | 'workflowRuntime'> = {
  agentSelection: { version: 1, writer, reviewers: [writer, reviewer] },
  agentRuntime: { pluginsRoot: '/plugins', runtimeArtifactsRoot: '/artifacts', artifacts: [] }, workflow,
  workflowRuntime: { pluginsRoot: '/plugins', runtimeArtifactsRoot: '/artifacts', artifacts: [] },
};

describe('retained agent and workflow loading', () => {
  beforeEach(() => { mocks.loadAgent.mockReset(); mocks.loadWorkflow.mockReset(); });

  it('loads one workflow renderer for the agent set and disposes agents before it', async () => {
    const order: string[] = [];
    const renderPrompt = vi.fn(() => 'workflow prompt');
    mocks.loadWorkflow.mockResolvedValue({ renderPrompt, dispose: async () => { order.push('workflow'); } });
    mocks.loadAgent.mockImplementation(async ({ record: input }: { record: typeof writer }) => {
      const provider: AgentProviderV1 = { metadata, buildCommand: command => ({ cmd: 'agent', args: [command.prompt] }), parseLine: () => null };
      return { provider, dispose: async () => { order.push(input.binding.providerId); } };
    });
    const loaded = await loadExecutionAgents(task);
    expect(mocks.loadWorkflow).toHaveBeenCalledOnce();
    expect(mocks.loadAgent).toHaveBeenCalledTimes(2);
    expect(loaded.writer.buildCommand({ ticketId: 'T-1', title: 'Task', repo: 'org/repo', jiraBaseUrl: '', workflow })).toEqual({ cmd: 'agent', args: ['workflow prompt'] });
    expect(renderPrompt).toHaveBeenCalledWith(expect.objectContaining({ workflow }), writer);
    await loaded.dispose();
    expect(order).toEqual([reviewer.binding.providerId, writer.binding.providerId, 'workflow']);
  });

  it('disposes the workflow and prior agents when a later retained agent fails to load', async () => {
    const disposeAgent = vi.fn(async () => {}); const disposeWorkflow = vi.fn(async () => {});
    mocks.loadWorkflow.mockResolvedValue({ renderPrompt: vi.fn(), dispose: disposeWorkflow });
    mocks.loadAgent.mockResolvedValueOnce({ provider: { metadata, buildCommand: vi.fn(), parseLine: vi.fn() }, dispose: disposeAgent })
      .mockRejectedValueOnce(new Error('artifact missing'));
    await expect(loadExecutionAgents(task)).rejects.toThrow('artifact missing');
    expect(disposeAgent).toHaveBeenCalledOnce();
    expect(disposeWorkflow).toHaveBeenCalledOnce();
  });
});
