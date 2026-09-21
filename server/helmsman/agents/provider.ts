import type { AgentProviderV1 } from '../../../src/plugins/agent-provider';
import { parseAgentCommandInputV1 } from '../../../src/plugins/agent-provider';
import { boundedAgentProvider, type AgentRetainedProviderV1 } from '../agent-providers';
import type { AgentAdapter } from './adapter';
import { buildPrompt } from './prompt';

export function agentProviderAdapter(record: AgentRetainedProviderV1, input: AgentProviderV1): AgentAdapter {
  const provider = boundedAgentProvider(input);
  return {
    id: record.binding.providerId,
    metadata: record.metadata,
    buildCommand(task) {
      const model = task.model ?? record.metadata.defaults.model;
      const effort = task.effort ?? record.metadata.defaults.effort;
      const command = provider.buildCommand(parseAgentCommandInputV1({ version: 1,
        prompt: buildPrompt({ ...task, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, record.binding.providerId),
        model, effort, stage: task.prePr?.stage ?? (task.review ? 'review' : 'direct'), summaryCorrection: Boolean(task.prePr?.summaryCorrection),
        task: { ticketId: task.ticketId, repo: task.repo, title: task.title },
      }));
      return { cmd: command.cmd, args: [...command.args] };
    },
    parseLine: line => provider.parseLine(line),
  };
}
