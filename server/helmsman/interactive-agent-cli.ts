import { parseInteractiveAgentConfig, runInteractiveAgent } from './interactive-agent';
import { joinInputArguments } from './runtime-paths';

const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort.abort());
try {
  const raw = joinInputArguments(process.argv.slice(2));
  await runInteractiveAgent(parseInteractiveAgentConfig(JSON.parse(raw)), { signal: abort.signal });
} catch (error) {
  try { process.stderr.write(`${error instanceof Error ? error.message : 'Interactive agent failed'}\n`); } catch {}
  process.exitCode = 1;
}
