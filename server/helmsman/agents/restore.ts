import type { RunRow } from '../db';
import type { AgentAdapter, AgentTask } from './adapter';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { commandAdapter } from './command';
import { dockerReviewAdapter } from './docker-review';
import { isFeedbackUpdateAdapter, feedbackUpdateAdapter } from './feedback-update';
import { isPrePrAdapter, prePrAdapter } from './pre-pr';
import type { PrePrSettings } from '../../../src/logic/prePrSettings';
import type { PrePrPublicationConnection } from '../publication-client';
import { usesIsolatedExecution } from '../execution-host-stage';

export function restoreRunAdapter(row: Pick<RunRow, 'adapter' | 'taskJson'>, options: { runsDir: string; agentCmd?: string | null; publication?: PrePrPublicationConnection; reviewSettings?: PrePrSettings; retained?: AgentAdapter }): AgentAdapter {
  const id = row.adapter.replace(/^(?:pre-pr|feedback):/, '');
  const provider = options.retained ?? (id === 'claude-code' ? claudeCodeAdapter : id === 'codex' ? codexAdapter
    : id === 'command' && options.agentCmd ? commandAdapter(options.agentCmd) : null);
  if (!provider || provider.id !== id) throw new Error('The original agent provider is unavailable');
  if (isFeedbackUpdateAdapter(row.adapter)) return feedbackUpdateAdapter(provider, options.runsDir);
  if (isPrePrAdapter(row.adapter)) return prePrAdapter(provider, options.runsDir, options.reviewSettings, options.publication);
  let value: unknown;
  try { value = row.taskJson ? JSON.parse(row.taskJson) : null; }
  catch { return provider; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return provider;
  const task = value as Partial<AgentTask>;
  if (task.review === true && usesIsolatedExecution(task)) {
    return dockerReviewAdapter(provider);
  }
  return provider;
}
