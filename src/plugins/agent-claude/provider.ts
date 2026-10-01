import type { AgentCommandInputV1, AgentEventV1, AgentProviderV1 } from '@helmsman/plugin-sdk';

const PR_RE = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i;
const prNumber = (text: string): number | undefined => { const match = text.match(PR_RE); return match ? Number(match[1]) : undefined; };
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function claudeArgs(input: AgentCommandInputV1): readonly string[] {
  return ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(input.model ? ['--model', input.model] : []), ...(input.effort ? ['--effort', input.effort] : [])];
}

export function parseClaudeLine(line: string): AgentEventV1 | null {
  let parsed: Record<string, unknown>;
  try { const value: unknown = JSON.parse(line.trim()); if (!value || typeof value !== 'object' || Array.isArray(value)) return null; parsed = value as Record<string, unknown>; } catch { return null; }
  if (parsed.type === 'result') {
    const result = typeof parsed.result === 'string' ? parsed.result : 'done'; const usage = parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage) ? parsed.usage as Record<string, unknown> : {};
    const inputTokens = usage.input_tokens; const cachedInputTokens = usage.cache_read_input_tokens; const outputTokens = usage.output_tokens;
    const parsedUsage = { ...(validCount(inputTokens) ? { inputTokens } : {}), ...(validCount(cachedInputTokens) ? { cachedInputTokens } : {}), ...(validCount(outputTokens) ? { outputTokens } : {}) };
    const outcome = parsed.is_error === true || parsed.subtype === 'error' ? 'failure' as const : parsed.subtype === 'success' ? 'success' as const : 'unknown' as const;
    return { kind: 'result', outcome, text: result, ...(validCost(parsed.total_cost_usd) || Object.keys(parsedUsage).length ? { provider: 'claude-code' } : {}), ...(validCost(parsed.total_cost_usd) ? { costUsd: parsed.total_cost_usd } : {}), ...(Object.keys(parsedUsage).length ? { usage: parsedUsage } : {}), ...(typeof parsed.uuid === 'string' && parsed.uuid.length <= 256 ? { eventId: parsed.uuid } : {}), ...(prNumber(result) === undefined ? {} : { prNumber: prNumber(result) }) };
  }
  if (parsed.type !== 'assistant') return null;
  const message = parsed.message && typeof parsed.message === 'object' && !Array.isArray(parsed.message) ? parsed.message as Record<string, unknown> : null;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_use' && typeof item.name === 'string') { const input = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input as Record<string, unknown> : {}; const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''; return { kind: 'tool', text: detail ? `${item.name}: ${detail}` : item.name }; }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) { const text = item.text.trim(); return { kind: 'log', text, ...(prNumber(text) === undefined ? {} : { prNumber: prNumber(text) }) }; }
  }
  return null;
}

export const claudeAgentProvider: AgentProviderV1 = {
  metadata: { version: 1, label: 'Claude Code', defaults: { model: null, effort: null }, review: { low: { model: 'sonnet', effort: 'low' }, medium: { model: 'sonnet', effort: 'medium' }, high: { model: 'opus', effort: 'high' } }, reviewSkills: [], reviewDelegation: 'native-subagents', supportsPrePr: true, docker: 'anthropic-messages', costReporting: 'cumulative' },
  buildCommand(input) { return { cmd: 'claude', args: claudeArgs(input) }; }, parseLine: parseClaudeLine,
  buildInteractiveCommand(input) {
    return { command: { cmd: 'claude', args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages',
      '--verbose', '--dangerously-skip-permissions', ...(input.model ? ['--model', input.model] : []), ...(input.effort ? ['--effort', input.effort] : [])] },
    protocol: 'claude-stream-json', initialInput: { prompt: input.prompt, model: input.model, effort: input.effort } };
  },
};
