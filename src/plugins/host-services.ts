import { apiFetch, rejectApiCache } from '../data/api-client';
import { createHostAgentPromptSettingsService } from './agent-prompts-service';
import { createHostWhiteboardService } from './whiteboard-service';
import { createHostRunInstructionService } from './run-instruction-service';
import { createHostPostmortemService } from './postmortem-service';
import { createHostExecutionPolicyService } from './execution-policy-service';
import { createHostFeedbackSettingsService } from './feedback-settings-service';
import { createHostFeedbackCommandService } from './feedback-command-service';
import { createHostTaskActionService } from './task-action-service';
import { createHostProfileService } from './profile-service';
import { createHostGithubSettingsService } from './github-settings-service';
import { createHostJiraSettingsService } from './jira-settings-service';
import { createHostLocalGitService } from './local-git-service';
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
import { createHostTaskContextService } from './task-context-service';
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

export function createHostPageServices(lifetime: AbortSignal, scope?: () => TaskReadScopeV1, caller?: string, fetcher: typeof fetch = apiFetch): PluginPageServices {
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  async function request(endpoint: string, input: UsageQuery, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ version: String(input.version), from: input.from, to: input.to });
    if (input.repo !== null) params.set('repo', input.repo);
    const response = await fetcher(`${endpoint}?${params}`, { signal: signalFor(signal) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof object(body)?.error === 'string' ? String(object(body)?.error) : `Plugin service failed (${response.status}).`);
    return body;
  }
  return Object.freeze({
    version: 1,
    ...(scope ? { tasks: createHostTaskReadService(lifetime, { scope, fetch: fetcher }), runs: createHostRunReadService(lifetime, { scope, fetch: fetcher }), runInspect: createHostRunInspectService(lifetime, { scope, fetch: fetcher }), downloads: createHostDownloadService(lifetime, scope),
      todoLegacyRecovery: createHostTodoLegacyRecoveryService(lifetime, { scope, fetch: fetcher }),
      taskEdit: createHostTaskEditService(lifetime, { scope, fetch: fetcher }), taskViews: createHostTaskViewsReadService(lifetime, { scope, fetch: fetcher }), taskContext: createHostTaskContextService(lifetime, { scope, fetch: fetcher }),
      pullRequests: createHostPullRequestReadService(lifetime, { scope, fetch: fetcher }),
      pullRequestInspect: createHostPullRequestInspectService(lifetime, { scope, fetch: fetcher }),
      activity: createHostActivityReadService(lifetime, { scope, fetch: fetcher }),
      ...(caller ? { runCommands: createHostRunCommandService(lifetime, { scope, caller, fetch: fetcher }),
        clarifications: createHostClarificationReadService(lifetime, { scope, caller, fetch: fetcher }),
        clarificationCommands: createHostClarificationCommandService(lifetime, { scope, caller, fetch: fetcher }),
        runInstructions: createHostRunInstructionService(lifetime, { scope, caller, fetch: fetcher }),
        postmortem: createHostPostmortemService(lifetime, { scope, caller, fetch: fetcher }),
        whiteboard: createHostWhiteboardService(lifetime, { scope, caller, fetch: fetcher }),
        pullRequestCommands: createHostPullRequestCommandService(lifetime, { scope, caller, fetch: fetcher }),
        terminal: createHostTerminalService(lifetime, { scope, caller, fetch: fetcher }),
        campaigns: createHostCampaignService(lifetime, { scope, caller, fetch: fetcher }),
        jiraSettings: createHostJiraSettingsService(lifetime, { scope, caller, fetch: fetcher }),
        githubSettings: createHostGithubSettingsService(lifetime, { scope, caller, fetch: fetcher }),
        profile: createHostProfileService(lifetime, { scope, caller, fetch: fetcher }),
        executionPolicy: createHostExecutionPolicyService(lifetime, { scope, caller, fetch: fetcher }),
        localGit: createHostLocalGitService(lifetime, { scope, caller, fetch: fetcher }),
        communication: createHostCommunicationService(lifetime, { scope, caller, fetch: fetcher }),
        communicationCommands: createHostCommunicationCommandService(lifetime, { scope, caller, fetch: fetcher }),
        feedbackCommands: createHostFeedbackCommandService(lifetime, { scope, caller, fetch: fetcher }),
        feedbackSettings: createHostFeedbackSettingsService(lifetime, { scope, caller, fetch: fetcher }),
        agentPrompts: createHostAgentPromptSettingsService(lifetime, { scope, caller, fetch: fetcher }),
        suggestedContacts: createHostSuggestedContactAdminService(lifetime, { scope, caller, fetch: fetcher }),
        sourceAdmin: createHostSourceAdminService(lifetime, { scope, caller, fetch: fetcher }),
        taskActions: createHostTaskActionService(lifetime, { scope, caller, fetch: fetcher }),
        sourceCommands: createHostSourceCommandService(lifetime, { scope, caller, fetch: fetcher }) } : {}) } : {}),
    usage: Object.freeze({ async query(input: UsageQuery, signal?: AbortSignal) {
      const body = await request('/api/usage/v1', input, signal);
      if (!usageSnapshot(body, input)) { rejectApiCache('/api/usage/v1'); throw new Error('Usage response was invalid.'); }
      return body;
    } }),
    outcomes: Object.freeze({
      summary: (repo, days, signal) => fetchOutcomes(repo, days, signalFor(signal), '/api/reports/outcomes/v1', fetcher),
      assessment: (runId, input, signal) => saveOutcomeAssessment(runId, input, signalFor(signal), '/api/reports/outcomes/v1', fetcher),
    } satisfies PluginPageServices['outcomes']),
    pricing: Object.freeze({ async estimate(input: UsageQuery, signal?: AbortSignal) {
      const body = await request('/api/pricing/v1', input, signal);
      if (!pricingEstimate(body)) { rejectApiCache('/api/pricing/v1'); throw new Error('Pricing response was invalid.'); }
      return body;
    } }),
  });
}
