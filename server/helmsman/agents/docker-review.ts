import { runtimeNodeArguments } from '../runtime-paths';
import type { AgentAdapter } from './adapter';
import { prePrAdapter } from './pre-pr';

export function dockerReviewAdapter(reviewer: AgentAdapter): AgentAdapter {
  if (!['codex', 'claude-code'].includes(reviewer.id)) throw new Error('Unsupported Docker review provider');
  return {
    id: reviewer.id,
    buildCommand(task) {
      if (!task.review || !task.dockerExecution) throw new Error('Docker review task is required');
      return { cmd: process.execPath, args: [...runtimeNodeArguments('../docker-review-cli.ts', import.meta.url),
        JSON.stringify({ task, reviewerId: reviewer.id })] };
    },
    parseLine: prePrAdapter(reviewer, '').parseLine,
  };
}
