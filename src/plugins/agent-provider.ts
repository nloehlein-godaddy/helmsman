import type { PluginJson } from './backend';
import { sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export const AGENT_PROVIDER_LIMITS_V1: Readonly<Record<'prompt' | 'line' | 'command' | 'arguments' | 'text', number>> = Object.freeze({ prompt: 256 * 1024, line: 1024 * 1024, command: 1024 * 1024, arguments: 256, text: 1024 * 1024 });
export interface AgentModelSettingsV1 { readonly model: string | null; readonly effort: string | null; }
export interface AgentProviderMetadataV1 {
  readonly version: 1; readonly label: string;
  readonly defaults: AgentModelSettingsV1;
  readonly review: Readonly<Record<'low' | 'medium' | 'high', AgentModelSettingsV1>>;
  readonly reviewSkills: readonly string[];
  readonly reviewDelegation: 'review-agent-skill' | 'native-subagents' | 'none';
  readonly supportsPrePr: boolean;
  readonly docker: 'openai-responses' | 'anthropic-messages' | null;
  readonly costReporting: 'delta' | 'cumulative';
}
export interface AgentCommandInputV1 {
  readonly version: 1; readonly prompt: string; readonly model: string | null; readonly effort: string | null;
  readonly stage: 'direct' | 'implement' | 'review' | 'fix'; readonly summaryCorrection: boolean;
  readonly task: { readonly ticketId: string; readonly repo: string; readonly title: string };
}
export interface AgentCommandV1 { readonly cmd: string; readonly args: readonly string[]; }
export interface AgentInteractiveCommandV1 {
  readonly command: AgentCommandV1;
  readonly protocol: 'codex-app-server' | 'claude-stream-json';
  readonly initialInput: { readonly prompt: string; readonly model: string | null; readonly effort: string | null };
}
export interface AgentUsageV1 { readonly inputTokens?: number; readonly cachedInputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; }
export interface AgentEventFieldsV1 {
  readonly text: string; readonly costUsd?: number; readonly prNumber?: number; readonly eventId?: string; readonly usage?: AgentUsageV1;
  readonly provider?: string; readonly model?: string; readonly effort?: string; readonly stage?: string; readonly round?: number;
}
export type AgentEventV1 = AgentEventFieldsV1 & (
  | { readonly kind: 'result'; readonly outcome: 'success' | 'failure' | 'unknown' }
  | { readonly kind: 'phase' | 'tool' | 'log' | 'usage' | 'error' | 'review-verdict'; readonly outcome?: never }
);
export interface AgentProviderV1 {
  readonly metadata: AgentProviderMetadataV1;
  buildCommand(input: AgentCommandInputV1): AgentCommandV1;
  buildInteractiveCommand?(input: AgentCommandInputV1): AgentInteractiveCommandV1;
  parseLine(line: string): AgentEventV1 | null;
}
export interface AgentDeclarationV1 { readonly access: readonly ['process-description']; }
export interface AgentBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerAgent(localId: string, provider: AgentProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface AgentBackendModuleV1 { activate(context: AgentBackendContextV1): void | Promise<void>; }

function invalid(): never { throw new TypeError('Invalid agent provider contract'); }
function nullable(value: unknown, maximum: number): string | null { return value === null ? null : sourceText(value, maximum); }
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || !empty && !value.trim()) invalid(); return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value;
}
export function parseAgentModelSettingsV1(input: unknown): AgentModelSettingsV1 {
  const value = sourceObject(input); sourceFields(value, ['model', 'effort']);
  return Object.freeze({ model: nullable(value.model, 128), effort: nullable(value.effort, 64) });
}
export function parseAgentProviderMetadataV1(input: unknown): AgentProviderMetadataV1 {
  const value = sourceObject(sourceJson(input, 16_384));
  sourceFields(value, ['version', 'label', 'defaults', 'review', 'reviewSkills', 'reviewDelegation', 'supportsPrePr', 'docker', 'costReporting']);
  if (value.version !== 1 || typeof value.supportsPrePr !== 'boolean' || !['review-agent-skill', 'native-subagents', 'none'].includes(String(value.reviewDelegation))
    || ![null, 'openai-responses', 'anthropic-messages'].includes(value.docker as string | null) || !['delta', 'cumulative'].includes(String(value.costReporting))) invalid();
  const review = sourceObject(value.review); sourceFields(review, ['low', 'medium', 'high']);
  if (!Array.isArray(value.reviewSkills) || value.reviewSkills.length > 16 || new Set(value.reviewSkills).size !== value.reviewSkills.length
    || value.reviewSkills.some(skill => typeof skill !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(skill))) invalid();
  return Object.freeze({ version: 1, label: sourceText(value.label, 128), defaults: parseAgentModelSettingsV1(value.defaults),
    review: Object.freeze({ low: parseAgentModelSettingsV1(review.low), medium: parseAgentModelSettingsV1(review.medium), high: parseAgentModelSettingsV1(review.high) }),
    reviewSkills: Object.freeze([...value.reviewSkills]) as readonly string[], reviewDelegation: value.reviewDelegation as AgentProviderMetadataV1['reviewDelegation'],
    supportsPrePr: value.supportsPrePr, docker: value.docker as AgentProviderMetadataV1['docker'], costReporting: value.costReporting as AgentProviderMetadataV1['costReporting'] });
}
export function parseAgentCommandInputV1(input: unknown): AgentCommandInputV1 {
  const value = sourceObject(sourceJson(input, AGENT_PROVIDER_LIMITS_V1.command));
  sourceFields(value, ['version', 'prompt', 'model', 'effort', 'stage', 'summaryCorrection', 'task']);
  if (value.version !== 1 || !['direct', 'implement', 'review', 'fix'].includes(String(value.stage)) || typeof value.summaryCorrection !== 'boolean') invalid();
  const task = sourceObject(value.task); sourceFields(task, ['ticketId', 'repo', 'title']);
  return Object.freeze({ version: 1, prompt: text(value.prompt, AGENT_PROVIDER_LIMITS_V1.prompt), model: nullable(value.model, 128), effort: nullable(value.effort, 64),
    stage: value.stage as AgentCommandInputV1['stage'], summaryCorrection: value.summaryCorrection,
    task: Object.freeze({ ticketId: sourceText(task.ticketId, 512), repo: parseTaskRepo(task.repo), title: sourceText(task.title, 4096) }) });
}
export function parseAgentCommandV1(input: unknown): AgentCommandV1 {
  const value = sourceObject(sourceJson(input, AGENT_PROVIDER_LIMITS_V1.command)); sourceFields(value, ['cmd', 'args']);
  if (!Array.isArray(value.args) || value.args.length > AGENT_PROVIDER_LIMITS_V1.arguments) invalid();
  return Object.freeze({ cmd: sourceText(value.cmd, 4096), args: Object.freeze(value.args.map(value => text(value, AGENT_PROVIDER_LIMITS_V1.prompt, true))) });
}
export function parseAgentInteractiveCommandV1(input: unknown): AgentInteractiveCommandV1 {
  const value = sourceObject(sourceJson(input, AGENT_PROVIDER_LIMITS_V1.command));
  sourceFields(value, ['command', 'protocol', 'initialInput']);
  if (value.protocol !== 'codex-app-server' && value.protocol !== 'claude-stream-json') invalid();
  const initialInput = sourceObject(value.initialInput); sourceFields(initialInput, ['prompt', 'model', 'effort']);
  return Object.freeze({ command: parseAgentCommandV1(value.command), protocol: value.protocol,
    initialInput: Object.freeze({ prompt: text(initialInput.prompt, AGENT_PROVIDER_LIMITS_V1.prompt),
      model: nullable(initialInput.model, 128), effort: nullable(initialInput.effort, 64) }) });
}
export function parseAgentEventV1(input: unknown): AgentEventV1 | null {
  if (input === null) return null;
  const value = sourceObject(sourceJson(input, AGENT_PROVIDER_LIMITS_V1.line));
  sourceFields(value, ['kind', 'text', ...(value.kind === 'result' ? ['outcome'] : [])], ['costUsd', 'prNumber', 'eventId', 'usage', 'provider', 'model', 'effort', 'stage', 'round']);
  if (!['phase', 'tool', 'log', 'result', 'usage', 'error', 'review-verdict'].includes(String(value.kind))
    || value.kind === 'result' && !['success', 'failure', 'unknown'].includes(String(value.outcome))) invalid();
  const result: Record<string, unknown> = { kind: value.kind, text: text(value.text, AGENT_PROVIDER_LIMITS_V1.text, true), ...(value.kind === 'result' ? { outcome: value.outcome } : {}) };
  if (Object.hasOwn(value, 'costUsd')) { if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0) invalid(); result.costUsd = value.costUsd; }
  if (Object.hasOwn(value, 'prNumber')) result.prNumber = integer(value.prNumber, 1);
  if (Object.hasOwn(value, 'round')) result.round = integer(value.round);
  for (const field of ['eventId', 'provider', 'model', 'effort', 'stage'] as const) if (Object.hasOwn(value, field)) result[field] = sourceText(value[field], field === 'eventId' ? 256 : 128);
  if (Object.hasOwn(value, 'usage')) {
    const usage = sourceObject(value.usage); sourceFields(usage, [], ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']);
    result.usage = Object.freeze(Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, integer(value)])));
  }
  return Object.freeze(result) as unknown as AgentEventV1;
}
