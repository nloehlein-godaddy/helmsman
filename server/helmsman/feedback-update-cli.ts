import type { AgentEvent } from './agents/adapter';
import { runFeedbackUpdateRuntime } from './feedback-update-runtime';
import { acknowledgeCoordinatorSettlement } from './coordinator-settlement';
import { joinInputArguments } from './runtime-paths';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
try {
  const serialized = joinInputArguments(process.argv.slice(2));
  if (!serialized) throw new Error('Feedback worker input is required');
  const input = JSON.parse(serialized) as Parameters<typeof runFeedbackUpdateRuntime>[0];
  if (!input?.task || typeof input.runsDir !== 'string') throw new Error('Invalid feedback worker input');
  await runFeedbackUpdateRuntime(input, emit);
  emit({ kind: 'result', outcome: 'success', text: `PR #${input.task.prNumber} feedback completed after independent verification`, prNumber: input.task.prNumber });
} catch (error) {
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

await acknowledgeCoordinatorSettlement();
