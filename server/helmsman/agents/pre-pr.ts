import { runtimeNodeArguments } from '../runtime-paths';
import { normalizePrePrSettings, type PrePrSettings } from '../../../src/logic/prePrSettings';
import type { AgentAdapter, AgentEvent, AgentEventKind } from './adapter';
import type { PrePrPublicationConnection } from '../publication-client';
import { isContributionId } from '../../../src/plugins/manifest';

const KINDS = new Set<AgentEventKind>(['phase', 'tool', 'log', 'result', 'usage', 'error', 'review-verdict', 'run-complete']);
const PREFIX = 'pre-pr:';

export function isPrePrAdapter(id: string): boolean {
  const providerId = id.startsWith(PREFIX) ? id.slice(PREFIX.length) : '';
  return providerId === 'codex' || providerId === 'claude-code' || isContributionId(providerId);
}

export function prePrAdapter(writer: AgentAdapter | string, runsDir: string, settings?: PrePrSettings, publication?: PrePrPublicationConnection): AgentAdapter {
  const writerId = typeof writer === 'string' ? writer : writer.id;
  if (writerId !== 'codex' && writerId !== 'claude-code' && !isContributionId(writerId)) throw new Error('Pre-PR review requires a valid agent provider');
  const reviewSettings = normalizePrePrSettings(settings);
  return {
    id: `${PREFIX}${writerId}`,
    ...(typeof writer === 'string' || !writer.metadata ? {} : { metadata: { ...writer.metadata, costReporting: 'delta' as const } }),
    buildCommand(task) {
      if (task.review || task.prBranch) throw new Error('The pre-PR workflow is only for new coding voyages');
      return {
        cmd: process.execPath,
        args: [...runtimeNodeArguments('../pre-pr-cli.ts', import.meta.url),
          JSON.stringify({ task, ...(task.agentSelection ? {} : { writerId }), runsDir, settings: reviewSettings, ...(publication ? { publication } : {}) })],
      };
    },
    parseLine(line) {
      if (!line) return null;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && '__helmsmanPrePr' in value && value.__helmsmanPrePr === 1
          && 'kind' in value && KINDS.has(value.kind as AgentEventKind) && 'text' in value && typeof value.text === 'string') {
          const event: AgentEvent = { kind: value.kind as AgentEventKind, text: value.text };
          if (event.kind === 'result' && 'outcome' in value && ['success', 'failure', 'unknown'].includes(String(value.outcome))) event.outcome = value.outcome as 'success' | 'failure' | 'unknown';
          if ('eventId' in value && typeof value.eventId === 'string' && value.eventId.length <= 256) event.eventId = value.eventId;
          if ('usage' in value && value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
            const usage = value.usage as Record<string, unknown>;
            const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const;
            if (fields.some(field => usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0))) return { kind: 'log', text: line };
            event.usage = Object.fromEntries(fields.filter(field => usage[field] !== undefined).map(field => [field, usage[field]]));
          }
          const record = value as Record<string, unknown>;
          for (const field of ['provider', 'model', 'effort', 'stage'] as const) {
            if (typeof record[field] === 'string' && record[field].length <= (field === 'provider' ? 193 : 128)) event[field] = record[field];
          }
          if ('round' in value && Number.isSafeInteger(value.round) && Number(value.round) >= 0) event.round = Number(value.round);
          if ('costUsd' in value && typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) event.costUsd = value.costUsd;
          if (event.kind === 'result' && 'prNumber' in value && typeof value.prNumber === 'number'
            && Number.isSafeInteger(value.prNumber) && value.prNumber > 0) event.prNumber = value.prNumber;
          return event;
        }
      } catch {}
      return { kind: 'log', text: line };
    },
  };
}
