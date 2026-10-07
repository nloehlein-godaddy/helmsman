import { acknowledgeCoordinatorSettlement } from './coordinator-settlement';
import type { AgentEvent } from './agents/adapter';
import { runPrePrRuntime } from './pre-pr-runtime';
import { validatePublicationConnection } from './publication-client';
import { joinInputArguments } from './runtime-paths';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
try {
  const serialized = joinInputArguments(process.argv.slice(2));
  if (!serialized) throw new Error('Pre-PR worker input is required');
  const input = JSON.parse(serialized) as Parameters<typeof runPrePrRuntime>[0];
  const legacy = input?.writerId === 'codex' || input?.writerId === 'claude-code';
  if (!input?.task || !input.task.agentSelection && !legacy || typeof input.runsDir !== 'string') throw new Error('Invalid pre-PR worker input');
  input.publication = validatePublicationConnection(input.publication);
  const prNumber = await runPrePrRuntime(input, emit);
  emit({ kind: 'result', outcome: 'success', text: `Created PR #${prNumber} after adversarial approval`, prNumber });
} catch (error) {
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

await acknowledgeCoordinatorSettlement();
