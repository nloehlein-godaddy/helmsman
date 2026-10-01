import type { AgentProviderV1 } from '../../../src/plugins/agent-provider';
import { parseAgentCommandInputV1 } from '../../../src/plugins/agent-provider';
import { boundedAgentProvider, type AgentRetainedProviderV1 } from '../agent-providers';
import type { AgentAdapter, AgentTask } from './adapter';
import { buildPrompt } from './prompt';

export function agentProviderAdapter(record: AgentRetainedProviderV1, input: AgentProviderV1, renderPrompt?: (task: AgentTask) => string): AgentAdapter {
  const provider = boundedAgentProvider(input);
  const commandInput = (task: AgentTask) => {
      const model = task.model ?? record.metadata.defaults.model;
      const effort = task.effort ?? record.metadata.defaults.effort;
      const prepared = { ...task, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      if (task.workflow && !renderPrompt) throw new Error('Retained workflow prompt renderer is unavailable');
      const prompt = renderPrompt ? renderPrompt(prepared) : buildPrompt(prepared, record.binding.providerId);
      return parseAgentCommandInputV1({ version: 1,
        prompt,
        model, effort, stage: task.feedbackStage?.stage === 'audit' ? 'review' : task.prePr?.stage ?? (task.review ? 'review' : 'direct'), summaryCorrection: Boolean(task.prePr?.summaryCorrection),
        task: { ticketId: task.ticketId, repo: task.repo, title: task.title },
      });
  };
  return {
    id: record.binding.providerId,
    metadata: record.metadata,
    ...(provider.buildInteractiveCommand ? { buildInteractiveCommand: (task: AgentTask) => provider.buildInteractiveCommand!(commandInput(task)) } : {}),
    buildCommand(task) {
      const command = provider.buildCommand(commandInput(task));
      return { cmd: command.cmd, args: [...command.args] };
    },
    parseLine: line => provider.parseLine(line),
  };
}
