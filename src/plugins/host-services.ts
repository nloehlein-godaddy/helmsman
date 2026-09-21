import { createHostCampaignService } from './campaigns-service';
import { createHostTerminalService } from './terminal-service';
import { createHostCommunicationService } from './communication-service';
import { createHostCommunicationCommandService } from './communication-command-service';
import { createHostPullRequestCommandService } from './pull-request-command-service';
import { createHostClarificationReadService } from './clarification-read-service';
import { createHostClarificationCommandService } from './clarification-command-service';
import { createHostSuggestedContactAdminService } from './suggested-contact-admin-service';
import { createHostSourceAdminService } from './source-admin-service';
import { createHostTodoLegacyRecoveryService } from './todo-legacy-recovery-service';
import { fetchOutcomes, saveOutcomeAssessment } from '../data/outcomeClient';
import { createHostPullRequestReadService } from './pull-request-read-service';
import { createHostPullRequestInspectService } from './pull-request-inspect-service';
import { createHostActivityReadService } from './activity-read-service';
import { createHostRunReadService } from './run-read-service';
import { createHostRunInspectService } from './run-inspect-service';
import { createHostDownloadService } from './download-service';
import { createHostRunCommandService } from './run-command-service';
import { createHostTaskEditService } from './task-edit-service';
import { createHostSourceCommandService } from './source-command-service';
import { createHostTaskViewsReadService } from './task-views-read-service';
import type { PluginPageServices } from './services';
import type { PricingEstimate, UsageQuery, UsageSnapshot } from './usage';
import { createHostTaskReadService, type TaskReadScopeV1 } from './task-read-service';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const amount = (value: unknown): boolean => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const tokens = (value: unknown): boolean => value === null || count(value);
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

function usageSnapshot(value: unknown, query: UsageQuery): value is UsageSnapshot {
  const data = object(value);
  const window = object(data?.window);
  const reported = object(data?.reported);
  if (!data || !window || !reported || data.version !== 1 || data.currency !== 'USD'
    || data.repo !== query.repo || !timestamp(window.from) || !timestamp(window.to)
    || Date.parse(String(window.from)) !== Date.parse(query.from) || Date.parse(String(window.to)) !== Date.parse(query.to)
    || !Array.isArray(data.runs) || !Array.isArray(data.records)) return false;
  const ids = new Set<string>();
  for (const value of data.runs) {
    const run = object(value);
    if (!run || typeof run.runId !== 'string' || ids.has(run.runId) || typeof run.repo !== 'string'
      || query.repo !== null && run.repo.toLowerCase() !== query.repo.toLowerCase()
      || !['running', 'succeeded', 'failed', 'stopped'].includes(String(run.status))
      || !timestamp(run.startedAt) || run.endedAt !== null && !timestamp(run.endedAt) || !amount(run.reportedCostUsd)) return false;
    ids.add(run.runId);
  }
  const events = new Set<string>();
  return data.records.every(value => {
    const row = object(value);
    const identity = JSON.stringify([row?.runId, row?.attempt, row?.eventId]);
    if (events.has(identity)) return false;
    events.add(identity);
    return row !== null && typeof row.runId === 'string' && ids.has(row.runId) && count(row.attempt) && Number(row.attempt) > 0
      && typeof row.eventId === 'string' && typeof row.provider === 'string' && (row.model === null || typeof row.model === 'string')
      && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].every(key => tokens(row[key])) && amount(row.costUsd);
  }) && ['observedCostUsd', 'knownCostUsd'].every(key => amount(reported[key]))
    && ['runsWithKnownCost', 'runsWithoutUsage'].every(key => count(reported[key]) && Number(reported[key]) <= ids.size)
    && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].every(key => tokens(reported[key]));
}

function pricingEstimate(value: unknown): value is PricingEstimate | null {
  if (value === null) return true;
  const data = object(value);
  const provenance = object(data?.provenance);
  if (!data || !provenance || data.version !== 1 || data.currency !== 'USD'
    || typeof provenance.source !== 'string' || typeof provenance.rateVersion !== 'string' || !timestamp(provenance.asOf)
    || !amount(data.estimatedUnreportedCostUsd) || !count(data.estimatedUsageEvents) || !count(data.unreportedUsageEvents)
    || Number(data.estimatedUsageEvents) > Number(data.unreportedUsageEvents)
    || (data.estimatedUsageEvents === 0) !== (data.estimatedUnreportedCostUsd === null)) return false;
  if (data.records === undefined) return true;
  if (!Array.isArray(data.records) || data.records.length !== data.unreportedUsageEvents) return false;
  const events = new Set<string>();
  let sum = 0;
  let priced = 0;
  const valid = data.records.every(value => {
    const row = object(value);
    if (!row || typeof row.runId !== 'string' || !count(row.attempt) || Number(row.attempt) < 1
      || typeof row.eventId !== 'string' || !amount(row.estimatedCostUsd)) return false;
    const identity = JSON.stringify([row.runId, row.attempt, row.eventId]);
    if (events.has(identity)) return false;
    events.add(identity);
    if (typeof row.estimatedCostUsd === 'number') { sum += row.estimatedCostUsd; priced++; }
    return true;
  });
  return valid && Number.isFinite(sum) && priced === data.estimatedUsageEvents
    && (priced === 0 || Math.abs(sum - Number(data.estimatedUnreportedCostUsd)) <= Math.max(1e-9, sum * 1e-9));
}

export function createHostPageServices(lifetime: AbortSignal, scope?: () => TaskReadScopeV1, caller?: string): PluginPageServices {
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  async function request(endpoint: string, input: UsageQuery, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ version: String(input.version), from: input.from, to: input.to });
    if (input.repo !== null) params.set('repo', input.repo);
    const response = await fetch(`${endpoint}?${params}`, { signal: signalFor(signal) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof object(body)?.error === 'string' ? String(object(body)?.error) : `Plugin service failed (${response.status}).`);
    return body;
  }
  return Object.freeze({
    version: 1,
    ...(scope ? { tasks: createHostTaskReadService(lifetime, { scope }), runs: createHostRunReadService(lifetime, { scope }), runInspect: createHostRunInspectService(lifetime, { scope }), downloads: createHostDownloadService(lifetime, scope),
      todoLegacyRecovery: createHostTodoLegacyRecoveryService(lifetime, { scope }),
      taskEdit: createHostTaskEditService(lifetime, { scope }), taskViews: createHostTaskViewsReadService(lifetime, { scope }),
      pullRequests: createHostPullRequestReadService(lifetime, { scope }),
      pullRequestInspect: createHostPullRequestInspectService(lifetime, { scope }),
      activity: createHostActivityReadService(lifetime, { scope }),
      ...(caller ? { runCommands: createHostRunCommandService(lifetime, { scope, caller }),
        clarifications: createHostClarificationReadService(lifetime, { scope, caller }),
        clarificationCommands: createHostClarificationCommandService(lifetime, { scope, caller }),
        pullRequestCommands: createHostPullRequestCommandService(lifetime, { scope, caller }),
        terminal: createHostTerminalService(lifetime, { scope, caller }),
        campaigns: createHostCampaignService(lifetime, { scope, caller }),
        communication: createHostCommunicationService(lifetime, { scope, caller }),
        communicationCommands: createHostCommunicationCommandService(lifetime, { scope, caller }),
        suggestedContacts: createHostSuggestedContactAdminService(lifetime, { scope, caller }),
        sourceAdmin: createHostSourceAdminService(lifetime, { scope, caller }),
        sourceCommands: createHostSourceCommandService(lifetime, { scope, caller }) } : {}) } : {}),
    usage: Object.freeze({ async query(input: UsageQuery, signal?: AbortSignal) {
      const body = await request('/api/usage/v1', input, signal);
      if (!usageSnapshot(body, input)) throw new Error('Usage response was invalid.');
      return body;
    } }),
    outcomes: Object.freeze({
      summary: (repo, days, signal) => fetchOutcomes(repo, days, signalFor(signal), '/api/reports/outcomes/v1'),
      assessment: (runId, input, signal) => saveOutcomeAssessment(runId, input, signalFor(signal), '/api/reports/outcomes/v1'),
    } satisfies PluginPageServices['outcomes']),
    pricing: Object.freeze({ async estimate(input: UsageQuery, signal?: AbortSignal) {
      const body = await request('/api/pricing/v1', input, signal);
      if (!pricingEstimate(body)) throw new Error('Pricing response was invalid.');
      return body;
    } }),
  });
}
