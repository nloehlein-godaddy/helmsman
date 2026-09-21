import { runtimeNodeArguments } from '../runtime-paths';
import type { AgentAdapter } from './adapter';
import { prePrAdapter } from './pre-pr';
import { usesIsolatedExecution } from '../execution-host-stage';

export function dockerReviewAdapter(reviewer: AgentAdapter): AgentAdapter {
  return {
    id: reviewer.id,
    ...(reviewer.metadata ? { metadata: { ...reviewer.metadata, costReporting: 'delta' as const } } : {}),
    buildCommand(task) {
      if (!task.review || !usesIsolatedExecution(task)) throw new Error('Isolated review task is required');
      return { cmd: process.execPath, args: [...runtimeNodeArguments('../docker-review-cli.ts', import.meta.url),
        JSON.stringify({ task, ...(task.agentSelection ? {} : { reviewerId: reviewer.id }) })] };
    },
    parseLine: prePrAdapter(reviewer, '').parseLine,
  };
}
