import { runtimeNodeArguments, chunkInputArguments } from '../runtime-paths';
import type { AgentAdapter } from './adapter';
import { isPrePrAdapter, prePrAdapter } from './pre-pr';

export function isFeedbackUpdateAdapter(id: string): boolean {
  return id.startsWith('feedback:') && isPrePrAdapter(`pre-pr:${id.slice('feedback:'.length)}`);
}

export function feedbackUpdateAdapter(writer: AgentAdapter, runsDir: string): AgentAdapter {
  const protocol = prePrAdapter(writer, runsDir);
  return {
    id: `feedback:${writer.id}`,
    ...(protocol.metadata ? { metadata: protocol.metadata } : {}),
    parseLine: protocol.parseLine,
    buildCommand(task) {
      if (task.review || !task.prBranch || !task.prNumber || task.workflow?.metadata.feedbackCompletion !== true
        || !task.agentSelection || !task.pullRequestSource) throw new Error('Feedback workflow requires retained PR, workflow and agent providers');
      return { cmd: process.execPath,
        args: [...runtimeNodeArguments('../feedback-update-cli.ts', import.meta.url), ...chunkInputArguments(JSON.stringify({ task, runsDir }))] };
    },
  };
}
