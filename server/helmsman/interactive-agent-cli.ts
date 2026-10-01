import { parseInteractiveAgentConfig, runInteractiveAgent } from './interactive-agent';

const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort.abort());
try {
  const raw = process.argv.slice(2).map(argument => argument.startsWith('--input=') ? argument.slice('--input='.length) : argument).join('');
  await runInteractiveAgent(parseInteractiveAgentConfig(JSON.parse(raw)), { signal: abort.signal });
} catch (error) {
  try { process.stderr.write(`${error instanceof Error ? error.message : 'Interactive agent failed'}\n`); } catch {}
  process.exitCode = 1;
}
