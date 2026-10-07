import { acknowledgeCoordinatorSettlement } from './coordinator-settlement';
import type { AgentEvent, AgentTask } from './agents/adapter';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodeAdapter } from './agents/claude-code';
import { codexAdapter } from './agents/codex';
import { assertClarificationReady, executePrePrStage, stageEventEmitter } from './pre-pr-runtime';
import { sanitizeDockerGit } from './docker-stage';
import { loadRetainedAgentProvider } from './agent-retained-loader';
import { agentProviderAdapter } from './agents/provider';
import { usesIsolatedExecution } from './execution-host-stage';
import { loadExecutionWorkflow } from './workflow-execution';
import { joinInputArguments } from './runtime-paths';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
const abort = new AbortController();
const stop = () => abort.abort();
const clearOutputs = () => Promise.all(['.agent-review.md', '.agent-review-comments.json'].map(name => rm(join(process.cwd(), name), { force: true })));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('SIGHUP', stop);
const disposals: Array<() => Promise<void>> = [];
try {
  const input = JSON.parse(joinInputArguments(process.argv.slice(2)) || 'null') as { task?: AgentTask; reviewerId?: string } | null;
  const task = input?.task;
  if (!task?.review || !usesIsolatedExecution(task)) throw new Error('Invalid isolated review task');
  const record = task.agentSelection?.writer;
  const runtime = task.agentRuntime;
  const workflow = await loadExecutionWorkflow(task, abort.signal);
  if (workflow) disposals.push(workflow.dispose);
  workflow?.assertMode(task);
  const loaded = record && runtime ? await loadRetainedAgentProvider({ ...runtime, record, signal: abort.signal }) : undefined;
  if (loaded) disposals.push(loaded.dispose);
  if (!loaded && input?.reviewerId !== 'codex' && input?.reviewerId !== 'claude-code') throw new Error('Recorded review provider is unavailable');
  const adapter = loaded ? agentProviderAdapter(record!, loaded.provider,
    workflow ? renderTask => workflow.renderPrompt(renderTask, record!) : undefined) : input?.reviewerId === 'claude-code' ? claudeCodeAdapter : codexAdapter;
  if (adapter.metadata?.supportsPrePr === false) throw new Error('Recorded agent provider does not support review workflows');
  const forward = stageEventEmitter(adapter, task, emit);
  await clearOutputs();
  await sanitizeDockerGit(process.cwd(), task.repo);
  forward({ kind: 'phase', text: 'Starting isolated review' });
  await executePrePrStage(adapter, task, process.cwd(), forward, abort.signal);
  const isolationRunId = task.hostIsolation?.runId ?? task.dockerExecution?.runId;
  if (!isolationRunId) throw new Error('Isolated review run identity is unavailable');
  await assertClarificationReady(task, isolationRunId);
} catch (error) {
  await clearOutputs().catch(() => undefined);
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error), stage: 'review', round: 1 });
  process.exitCode = 1;
} finally {
  for (const dispose of disposals.reverse()) await dispose().catch(() => undefined);
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
  process.off('SIGHUP', stop);
}

await acknowledgeCoordinatorSettlement();
