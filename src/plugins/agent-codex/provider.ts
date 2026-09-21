import type { AgentCommandInputV1, AgentEventV1, AgentProviderV1, AgentUsageV1 } from '@helmsman/plugin-sdk';

const PR_RE = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i;
const codexEfforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const identifier = (value: unknown): string | undefined => { const result = text(value); return result && result.length <= 256 ? result : undefined; };
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const cost = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const prNumber = (value: string): number | undefined => { const match = value.match(PR_RE); return match ? Number(match[1]) : undefined; };

function usage(value: unknown): AgentUsageV1 | undefined {
  const source = record(value);
  if (!source) return undefined;
  const inputTokens = count(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = count(source.cached_input_tokens ?? source.cachedInputTokens);
  const outputTokens = count(source.output_tokens ?? source.outputTokens);
  const totalTokens = count(source.total_tokens ?? source.totalTokens);
  const result = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
  return Object.keys(result).length ? result : undefined;
}

function errorText(value: unknown): string | null {
  const source = record(value);
  return text(source?.message) ?? text(source?.error) ?? text(value);
}

export function codexArgs(input: AgentCommandInputV1): readonly string[] {
  const model = input.model ?? 'gpt-6-astra';
  if (input.effort !== null && !codexEfforts.has(input.effort)) throw new TypeError('Unsupported Codex reasoning effort');
  const effort = input.effort ?? 'medium';
  return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-m', model, '-c', `model_reasoning_effort="${effort}"`,
    ...(input.stage === 'review' && !input.summaryCorrection ? ['-c', 'features.multi_agent=true'] : []), input.prompt];
}

export function parseCodexLine(line: string): AgentEventV1 | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const event = record(parsed); const type = text(event?.type);
  if (!event || !type) return null;
  if (type === 'item.completed') {
    const item = record(event.item); const eventId = identifier(item?.id);
    if (text(item?.type) === 'agent_message') {
      const itemText = text(item?.text);
      return itemText ? { kind: 'result', outcome: 'unknown', text: itemText, ...(eventId ? { eventId } : {}), ...(prNumber(itemText) === undefined ? {} : { prNumber: prNumber(itemText) }) } : null;
    }
    if (text(item?.type) === 'command_execution') {
      const command = text(item?.command);
      return command ? { kind: 'tool', text: command, ...(eventId ? { eventId } : {}) } : null;
    }
    return null;
  }
  if (type === 'turn.completed') {
    const parsedUsage = usage(event.usage); const costUsd = cost(record(event.usage)?.cost_usd ?? record(event.usage)?.costUsd ?? event.cost_usd ?? event.costUsd); const eventId = identifier(event.turn_id ?? event.id);
    return parsedUsage || costUsd !== undefined ? { kind: 'usage', text: 'Codex turn completed', provider: 'codex', ...(eventId ? { eventId } : {}), ...(parsedUsage ? { usage: parsedUsage } : {}), ...(costUsd === undefined ? {} : { costUsd }) } : null;
  }
  if (type === 'error' || type === 'turn.failed') {
    const message = errorText(event.error) ?? errorText(event); const eventId = identifier(event.turn_id ?? event.id);
    return message ? { kind: 'result', outcome: 'failure', text: message, ...(eventId ? { eventId } : {}) } : null;
  }
  return null;
}

export const codexAgentProvider: AgentProviderV1 = {
  metadata: { version: 1, label: 'Codex', defaults: { model: 'gpt-6-astra', effort: 'medium' }, review: { low: { model: 'gpt-5.6-terra', effort: 'low' }, medium: { model: 'gpt-5.6-sol', effort: 'medium' }, high: { model: 'gpt-6-astra', effort: 'high' } }, reviewSkills: ['review-agent'], reviewDelegation: 'review-agent-skill', supportsPrePr: true, docker: 'openai-responses', costReporting: 'delta' },
  buildCommand(input) { return { cmd: 'codex', args: codexArgs(input) }; },
  parseLine(line) { return parseCodexLine(line) ?? (line ? { kind: 'log', text: line, ...(prNumber(line) === undefined ? {} : { prNumber: prNumber(line) }) } : null); },
};
