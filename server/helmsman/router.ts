import { handleWhiteboardApi } from './whiteboard/routes';
import type { WhiteboardServerService } from './whiteboard/service';
import { handleRunInstructionApi } from './run-instruction-routes';
import type { createRunInstructionService } from './run-instruction-service';
import { handlePostmortemApi } from './postmortem/routes';
import type { PostmortemRunner } from './postmortem/runner';
import { handleExecutionPolicyApi } from './execution-policy-routes';
import type { ExecutionPolicyServerService } from './execution-policy-service';
import { handleFeedbackSettingsApi, type FeedbackSettingsServerService } from './feedback-settings-routes';
import { handleFeedbackCommandApi } from './feedback-command-routes';
import type { FeedbackCommandServerService } from './feedback-command-service';
import { handleProfileApi } from './profile-routes';
import type { ProfileServerService } from './profile-service';
import { handleIntegrationSettingsApi } from './integration-settings-routes';
import type { IntegrationSettingsServerService } from './integration-settings-service';
import { handleIntegrationStatusApi, type IntegrationStatusService } from './integration-status';
import { handleLocalGitApi } from './local-git-routes';
import type { LocalGitServerService } from './local-git-service';
import { handleCampaignPublicApi } from './campaigns-public-routes';
import type { CampaignPublicService } from './campaigns-public-service';
import { handleTerminalApi } from './terminal-routes';
import type { TerminalServerService } from './terminal-service';
import { handleCommunicationApi } from './communication-routes';
import { handleCommunicationCommandApi } from './communication-command-routes';
import type { CommunicationReadServerService } from './communication-read-service';
import type { CommunicationCommandServerService } from './communication-command-service';
import { handleClarificationServiceApi } from './clarification-service-routes';
import type { createApplicationClarifications } from './clarification-application';
import { handleSourceAdminApi } from './source-admin-routes';
import type { SourceAdminServerService } from './source-admin-service';
import { handleTodoLegacyRecoveryApi } from './todo-legacy-recovery-routes';
import { TodoConflictError, TodoValidationError } from './todos';
import type { Db, RunRow } from './db';
import { isGithubRepo } from '../pr-lists';
import type { SlackState } from '../../src/data/slack';
import { retryIntent, RetryError, type LaunchIntent } from './retry';
import { ResumeError } from './resume';
import type { OutcomeService } from './outcome-service';
import { OutcomeValidationError } from './outcomes';
import { ClarificationValidationError, type ClarificationStore } from './clarifications';
import type { PricingEstimate, UsageQueryService, UsageSnapshot } from '../../src/plugins/usage';
import { UsageValidationError } from './usage-store';
import { CapabilityResolutionError } from './plugins/backend';
import { handleRunCommandApi } from './run-command-routes';
import { handleSourceCommandApi } from './source-command-routes';
import type { SourceCommandServerService } from './source-command-coordinator';
import { handleTaskEditApi } from './task-edit-routes';
import type { TaskEditServerService } from './task-edit-service';
import { handleTaskViewsReadApi } from './task-views-read-routes';
import type { TaskViewsReadService } from './task-views-read-service';
import type { RunCommandServerService } from './run-command-coordinator';
import { handlePullRequestCommandApi } from './pull-request-command-routes';
import type { PullRequestCommandServerService } from './pull-request-command-service';
import { handlePullRequestReadApi } from './pull-request-read-routes';
import { handlePullRequestInspectApi } from './pull-request-inspect-routes';
import type { PullRequestInspectServerService } from './pull-request-inspect-service';
import type { PullRequestReadServerService } from './pull-request-read-service';
import { handleActivityReadApi } from './activity-read-routes';
import type { ActivityReadService } from './activity-read-service';
import { handleRunReadApi } from './run-read-routes';
import { handleTaskContextApi } from './task-context-routes';
import { handleRunInspectApi } from './run-inspect-routes';
import type { RunInspectServerService } from './run-inspect-service';
import type { RunReadServerService } from './run-read-service';
import type { TaskContextServerService } from './task-context-service';
import { handleTaskSourceApi } from './task-source-routes';
import type { TaskSourceService } from './task-source-service';
import { SourceTodoRejectedError, type TodoApi } from './task-source-todos';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import type { TaskSourceSchedule } from './task-source-schedule';

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface RunSummary {
  id: string;
  ticketId: string;
  repo: string;
  status: string;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  costUsd: number | null;
  reviewOutcome?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  reviewVerdict?: string;
}

function toRunSummary(row: RunRow, db: Db): RunSummary {
  const reviewVerdict = row.status === 'succeeded' ? db.latestReviewVerdict(row.id) : null;
  const verdictLabel = reviewVerdict?.match(/^Verdict: (Approve|Request changes|Comment only) — \S/)?.[1];
  const reviewOutcome = verdictLabel === 'Approve' ? 'APPROVE'
    : verdictLabel === 'Request changes' ? 'REQUEST_CHANGES'
    : verdictLabel === 'Comment only' ? 'COMMENT' : undefined;
  return {
    id: row.id,
    ticketId: row.ticketId,
    repo: row.repo,
    status: row.status,
    attempt: row.attempt,
    prNumber: row.prNumber,
    startedAt: row.startedAt,
    costUsd: row.costUsd,
    ...(reviewOutcome && reviewVerdict ? { reviewOutcome, reviewVerdict } : {}),
  };
}

export interface RouterDeps {
  publicClarifications?: ReturnType<typeof createApplicationClarifications>;
  runInstructions?: ReturnType<typeof createRunInstructionService>;
  clarificationCaller?: string;
  whiteboard?: WhiteboardServerService;
  whiteboardCaller?: string;
  whiteboardAuthorize?: (caller: string) => void;
  whiteboardRepos?: () => readonly string[];
  postmortem?: PostmortemRunner;
  postmortemCaller?: string;
  postmortemAuthorize?: (caller: string) => void;
  postmortemRepos?: () => readonly string[];
  runRead?: RunReadServerService;
  taskContext?: TaskContextServerService;
  taskContextSignal?: AbortSignal;
  runInspect?: RunInspectServerService;
  communication?: CommunicationReadServerService;
  feedbackSettings?: FeedbackSettingsServerService;
  feedbackCommands?: FeedbackCommandServerService;
  communicationCommands?: CommunicationCommandServerService;
  communicationCaller?: string;
  pullRequestCommands?: PullRequestCommandServerService;
  pullRequestCommandCaller?: string;
  pullRequestRead?: PullRequestReadServerService;
  pullRequestInspect?: PullRequestInspectServerService;
  pullRequestInspectSignal?: AbortSignal;
  activityRead?: ActivityReadService;
  runCommands?: RunCommandServerService;
  runCommandCaller?: string;
  sourceCommands?: SourceCommandServerService;
  sourceAdmin?: SourceAdminServerService;
  sourceAdminCaller?: string;
  sourceCommandCaller?: string;
  taskEdit?: TaskEditServerService;
  taskViews?: TaskViewsReadService;
  taskSources?: TaskSourceService;
  sourceSchedule?: TaskSourceSchedule;
  usage?: UsageQueryService;
  pricing?: (snapshot: UsageSnapshot) => Promise<PricingEstimate | null>;
  clarificationGate?: (runId: string, query: URLSearchParams) => boolean;
  feedbackClarifications?: (runId: string, query: URLSearchParams) => unknown;
  feedbackSnapshot?: (runId: string, query: URLSearchParams) => Promise<unknown>;
  outcomes?: OutcomeService;
  publicCampaigns?: CampaignPublicService;
  campaignCaller?: string;
  clarifications?: ClarificationStore;
  resumeRun?: (runId: string) => Promise<void>;
  executionPolicy?: ExecutionPolicyServerService;
  executionPolicyCaller?: string;
  profile?: ProfileServerService;
  profileCaller?: string;
  profileSignal?: AbortSignal;
  todos?: TodoApi;
  jiraEnabled?: () => boolean;
  outboundUsage?: () => unknown;
  context?: () => { repos: string[]; jiraBaseUrl: string | null; jiraEnabled?: boolean };
  slack?: { snapshot: () => SlackState };
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: LaunchIntent & { retryOf?: string }) => string | Promise<string>;
  stop: (runId: string) => boolean;
  setAutoClaim: (repo: string, enabled: boolean) => void;
  autoClaimRepos: () => string[];
  caps: () => { maxAttempts: number; maxCostUsd: number | null };
  getConfig: () => { config: Record<string, unknown>; overridden: string[]; jiraTokenSet?: boolean };
  setConfig: (key: string, value: string) => { ok: true } | { ok: false; error: string };
  integrationSettings?: IntegrationSettingsServerService;
  integrationStatus?: IntegrationStatusService;
  integrationSettingsCaller?: string;
  publicLocalGit?: LocalGitServerService;
  localGitCaller?: string;
  terminal?: TerminalServerService;
  terminalCaller?: string;
}

export async function handleApi(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: unknown,
  deps: RouterDeps,
): Promise<ApiResult | null> {
  const instructionsResult = await handleRunInstructionApi({ method, path, query, body: _body, caller: deps.clarificationCaller, service: deps.runInstructions });
  if (instructionsResult) return instructionsResult;
  const whiteboardResult = await handleWhiteboardApi({ method, path, query, body: _body, caller: deps.whiteboardCaller, service: deps.whiteboard, authorize: deps.whiteboardAuthorize, repos: deps.whiteboardRepos });
  if (whiteboardResult) return whiteboardResult;
  const postmortemResult = await handlePostmortemApi({ method, path, query, body: _body, caller: deps.postmortemCaller, service: deps.postmortem, authorize: deps.postmortemAuthorize, repos: deps.postmortemRepos });
  if (postmortemResult) return postmortemResult;
  const clarificationResult = handleClarificationServiceApi({ method, path, query, body: _body, caller: deps.clarificationCaller, ...deps.publicClarifications });
  if (clarificationResult) return clarificationResult;
  const sourceAdminResult = await handleSourceAdminApi({ method, path, query, body: _body, caller: deps.sourceAdminCaller, service: deps.sourceAdmin });
  if (sourceAdminResult) return sourceAdminResult;
  const sourceCommandResult = await handleSourceCommandApi({ method, path, query, body: _body, caller: deps.sourceCommandCaller, service: deps.sourceCommands });
  if (sourceCommandResult) return sourceCommandResult;
  const legacyTodoResult = handleTodoLegacyRecoveryApi({ method, path, body: _body, todos: deps.todos });
  if (legacyTodoResult) return legacyTodoResult;
  const taskEditResult = await handleTaskEditApi({ method, path, query, body: _body, service: deps.taskEdit });
  if (taskEditResult) return taskEditResult;
  const taskViewsResult = await handleTaskViewsReadApi({ method, path, query, service: deps.taskViews });
  if (taskViewsResult) return taskViewsResult;
  const commandResult = await handleRunCommandApi({ method, path, query, body: _body, caller: deps.runCommandCaller, service: deps.runCommands });
  if (commandResult) return commandResult;
  const communicationResult = handleCommunicationApi({ method, path, query, body: _body, caller: deps.communicationCaller, service: deps.communication });
  if (communicationResult) return communicationResult;
  const feedbackSettingsResult = await handleFeedbackSettingsApi({ method, path, query, body: _body, caller: deps.communicationCaller, service: deps.feedbackSettings });
  if (feedbackSettingsResult) return feedbackSettingsResult;
  const feedbackCommandResult = await handleFeedbackCommandApi({ method, path, query, body: _body, caller: deps.communicationCaller, service: deps.feedbackCommands });
  if (feedbackCommandResult) return feedbackCommandResult;
  const communicationCommandResult = await handleCommunicationCommandApi({ method, path, query, body: _body, caller: deps.communicationCaller, service: deps.communicationCommands });
  if (communicationCommandResult) return communicationCommandResult;
  const pullRequestCommandResult = await handlePullRequestCommandApi({ method, path, query, body: _body, caller: deps.pullRequestCommandCaller, service: deps.pullRequestCommands });
  if (pullRequestCommandResult) return pullRequestCommandResult;
  const pullRequestInspectResult = await handlePullRequestInspectApi({ method, path, query, service: deps.pullRequestInspect, signal: deps.pullRequestInspectSignal });
  if (pullRequestInspectResult) return pullRequestInspectResult;
  const pullRequestReadResult = await handlePullRequestReadApi({ method, path, query, service: deps.pullRequestRead });
  if (pullRequestReadResult) return pullRequestReadResult;
  const activityReadResult = await handleActivityReadApi({ method, path, query, service: deps.activityRead });
  if (activityReadResult) return activityReadResult;
  const runInspectResult = handleRunInspectApi({ method, path, query, service: deps.runInspect });
  if (runInspectResult) return runInspectResult;
  const runReadResult = handleRunReadApi({ method, path, query, service: deps.runRead });
  if (runReadResult) return runReadResult;
  const taskContextResult = await handleTaskContextApi({ method, path, query, service: deps.taskContext, signal: deps.taskContextSignal });
  if (taskContextResult) return taskContextResult;
  const sourceResult = await handleTaskSourceApi({ method, path, query, body: _body, service: deps.taskSources, schedule: deps.sourceSchedule, launch: deps.launch });
  if (sourceResult) return sourceResult;
  if ((path === '/api/usage/v1' || path === '/api/pricing/v1') && method === 'GET') {
    if (!deps.usage) return { status: 503, json: { error: 'Usage queries are unavailable.' } };
    if (query.get('version') !== '1') return { status: 400, json: { error: 'Usage query version must be 1.' } };
    try {
      const snapshot = await deps.usage.query({ version: 1, repo: query.get('repo'), from: query.get('from') ?? '', to: query.get('to') ?? '' });
      if (path === '/api/usage/v1') return { status: 200, json: snapshot };
      if (!deps.pricing) return { status: 503, json: { error: 'Pricing is unavailable.' } };
      return { status: 200, json: await deps.pricing(snapshot) };
    } catch (error) {
      if (error instanceof UsageValidationError) return { status: 400, json: { error: error.message } };
      if (error instanceof CapabilityResolutionError) return { status: 503, json: { error: error.message, code: error.code } };
      throw error;
    }
  }
  const feedbackRead = path.match(/^\/api\/runs\/([a-z\d_-]{1,128})\/(feedback-snapshot|feedback-clarifications)$/i);
  if (feedbackRead && method === 'GET') {
    const read = feedbackRead[2] === 'feedback-snapshot' ? deps.feedbackSnapshot : deps.feedbackClarifications;
    if (!read) return { status: 503, json: { error: 'Feedback evidence service is unavailable' } };
    try { return { status: 200, json: await read(feedbackRead[1]!, query) }; }
    catch { return { status: 409, json: { error: 'Current feedback evidence could not be verified' } }; }
  }
  const clarificationGate = path.match(/^\/api\/runs\/([a-z\d_-]{1,128})\/clarification-gate$/i);
  if (clarificationGate && method === 'GET') {
    try { return { status: 200, json: { ready: deps.clarificationGate?.(clarificationGate[1]!, query) === true } }; }
    catch { return { status: 200, json: { ready: false } }; }
  }
  const campaignResult = await handleCampaignPublicApi({ method, path, query, body: _body, caller: deps.campaignCaller, service: deps.publicCampaigns });
  if (campaignResult) return campaignResult;
  if (path === '/api/campaigns' || path.startsWith('/api/campaigns/')) return { status: 410, json: { error: 'Use scoped campaign services.' } };
  if (path.startsWith('/api/clarifications') || path === '/api/trusted-contacts') {
    if (method !== 'GET') return { status: 410, json: { error: 'Use the versioned clarification command or suggested-contact service. Worker ingestion requires its retained attempt channel.' } };
    const store = deps.clarifications;
    if (!store) return { status: 503, json: { error: 'Clarifications unavailable' } };
    try {
      store.timeoutDue(); store.cleanupOrphans();
      const repo = query.get('repo');
      if (repo !== null && !isGithubRepo(repo)) throw new ClarificationValidationError('Invalid galleon');
      if (path === '/api/clarifications' && method === 'GET') return { status: 200, json: { clarifications: store.list(repo) } };
      if (path === '/api/trusted-contacts' && method === 'GET') return { status: 200, json: { contacts: store.contacts() } };
      return { status: 404, json: { error: 'Clarification route not found' } };
    } catch (error) {
      if (error instanceof ClarificationValidationError) return { status: 400, json: { error: error.message } };
      throw error;
    }
  }
  if ((path === '/api/outcomes' || path === '/api/reports/outcomes/v1') && method === 'GET') {
    if (!deps.outcomes) return { status: 503, json: { error: 'Outcomes unavailable.' } };
    try {
      const summary = await deps.outcomes.summary(query);
      if (path === '/api/outcomes') return { status: 200, json: summary };
      const report = structuredClone(summary);
      delete report.costEstimate;
      for (const day of report.daily) delete day.costEstimate;
      for (const run of report.recentRuns) delete run.costEstimate;
      return { status: 200, json: report };
    }
    catch (error) {
      if (error instanceof OutcomeValidationError) return { status: 400, json: { error: error.message } };
      throw error;
    }
  }
  const assessmentMatch = path.match(/^\/api\/(?:outcomes|reports\/outcomes\/v1)\/([a-z\d_-]{1,128})\/assessment$/i);
  if (assessmentMatch && method === 'PUT') {
    if (!deps.outcomes) return { status: 503, json: { error: 'Outcomes unavailable.' } };
    try { return { status: 200, json: deps.outcomes.assessment(assessmentMatch[1], _body) }; }
    catch (error) {
      if (error instanceof OutcomeValidationError) return { status: 400, json: { error: error.message } };
      throw error;
    }
  }
  if (path === '/api/slack/review-request') return { status: 410, json: { error: 'Use the public communication command service.' } };
  const todoMatch = path.match(/^\/api\/todos\/(TODO-[1-9]\d*)$/);
  if (path === '/api/todos' || todoMatch) {
    if (!deps.todos) return { status: 503, json: { error: 'Todos unavailable.' } };
    const jiraEnabled = deps.jiraEnabled?.() ?? true;
    if (method === 'GET' && path === '/api/todos') return { status: 200, json: { todos: await deps.todos.list(), jiraEnabled } };
    if (method === 'GET' && todoMatch) {
      const todo = await deps.todos.get(todoMatch[1]);
      return todo ? { status: 200, json: { todo } } : { status: 404, json: { error: 'Todo not found.' } };
    }
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      try {
        const requestId = query.get('requestId') ?? undefined;
        if (method === 'POST' && path === '/api/todos') return { status: 201, json: { todo: await deps.todos.create(_body, requestId) } };
        if (method === 'PUT' && todoMatch) {
          const todo = await deps.todos.update(todoMatch[1], _body, requestId);
          return todo ? { status: 200, json: { todo } } : { status: 404, json: { error: 'Todo not found.' } };
        }
        if (method === 'DELETE' && todoMatch) {
          return await deps.todos.remove(todoMatch[1], requestId) ? { status: 200, json: { ok: true } } : { status: 404, json: { error: 'Todo not found.' } };
        }
      } catch (error) {
        if (error instanceof SourceTodoRejectedError) return { status: 409, json: { error: error.message, rejection: { version: 1, requestId: error.requestId, commandId: error.commandId } } };
        if (error instanceof TodoValidationError || error instanceof TodoConflictError || error instanceof PersistenceConflictError || error instanceof PersistenceValidationError) {
          return { status: error instanceof TodoConflictError || error instanceof PersistenceConflictError ? 409 : 400, json: { error: error.message } };
        }
        throw error;
      }
    }
    return { status: 404, json: { error: 'not found' } };
  }
  if (path === '/api/context' && method === 'GET') {
    return deps.context ? { status: 200, json: deps.context() } : { status: 503, json: { error: 'Context unavailable.' } };
  }
  if (path === '/api/github/profile') return { status: 410, json: { error: 'Use the public profile contribution service.' } };
  if (path === '/api/usage/external' && method === 'GET') {
    return { status: 200, json: deps.outboundUsage?.() ?? null };
  }
  if (path === '/api/slack' && method === 'GET') {
    return { status: 200, json: deps.slack?.snapshot() ?? {
      health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null },
      notifications: [],
    } };
  }
  const slackRead = path.match(/^\/api\/slack\/notifications\/([a-z\d_-]{1,128})\/read$/i);
  if (slackRead) return { status: 410, json: { error: 'Use the scoped communication notification service.' } };
  if (['/api/dashboard', '/api/triage', '/api/bugs'].includes(path)) {
    return { status: 410, json: { error: 'Use the versioned task, task-view and run-read services.' } };
  }
  if (path === '/api/agents' && method === 'GET') {
    return { status: 200, json: { runs: deps.db.listRuns(50).map((row) => toRunSummary(row, deps.db)), autoClaim: deps.autoClaimRepos(), caps: deps.caps() } };
  }
  if (path === '/api/runs' && method === 'GET') {
    const rawLimit = query.get('limit') ?? '25';
    const rawOffset = query.get('offset') ?? '0';
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const repo = query.get('repo');
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100
      || !/^(?:0|[1-9]\d*)$/.test(rawOffset) || !Number.isSafeInteger(offset)
      || repo !== null && !isGithubRepo(repo)) {
      return { status: 400, json: { error: 'Use a limit from 1 to 100, a nonnegative offset, and an optional owner/repo filter.' } };
    }
    const page = deps.db.runPage(limit, offset, repo);
    return { status: 200, json: { runs: page.runs.map((row) => toRunSummary(row, deps.db)), total: page.total, limit, offset } };
  }
  const runMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const runId = runMatch[1];
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId)) return { status: 400, json: { error: 'invalid run ID' } };
    const run = deps.db.getRun(runId);
    return run ? { status: 200, json: toRunSummary(run, deps.db) } : { status: 404, json: { error: 'run not found' } };
  }
  const resumeMatch = path.match(/^\/api\/agents\/([^/]+)\/resume$/);
  if (resumeMatch && method === 'POST') {
    const runId = resumeMatch[1];
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId)) return { status: 400, json: { error: 'invalid run ID' } };
    const run = deps.db.getRun(runId);
    if (!run) return { status: 404, json: { error: 'Voyage not found.' } };
    if (!deps.resumeRun) return { status: 503, json: { error: 'Voyage continuation is unavailable.' } };
    try {
      await deps.resumeRun(runId);
      return { status: 200, json: { runId } };
    } catch (error) {
      if (error instanceof ResumeError) return { status: 409, json: { error: error.message } };
      throw error;
    }
  }
  const retryMatch = path.match(/^\/api\/agents\/([^/]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    const runId = retryMatch[1];
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId)) return { status: 400, json: { error: 'invalid run ID' } };
    const run = deps.db.getRun(runId);
    if (!run) return { status: 404, json: { error: 'Voyage not found.' } };
    try {
      const intent = retryIntent(run);
      const allowed = deps.context?.().repos;
      if (allowed && !allowed.some(repo => repo.toLowerCase() === intent.repo.toLowerCase())) {
        return { status: 409, json: { error: 'This galleon is no longer configured. Configure it before retrying the voyage.' } };
      }
      const gate = deps.canStart(intent.repo);
      if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'Cannot start another voyage.' } };
      if (intent.mode === 'todo') {
        const todo = intent.todoId ? await deps.todos?.get(intent.todoId) : null;
        if (!todo || todo.repo !== run.repo || todo.runId !== run.id || !['todo', 'blocked'].includes(todo.state) || !todo.description.trim()) {
          return { status: 409, json: { error: 'The todo must still belong to this failed voyage, have a description, and be To do or Blocked. Start changed or completed todos from Todos.' } };
        }
      } else if (intent.mode === 'ticket' && deps.jiraEnabled?.() === false) {
        return { status: 409, json: { error: 'Enable Jira in Config before retrying a Jira voyage.' } };
      }
      return { status: 200, json: { runId: await deps.launch({ ...intent, retryOf: run.id }) } };
    } catch (error) {
      if (error instanceof RetryError || error instanceof TodoConflictError || error instanceof TodoValidationError || error instanceof PersistenceConflictError) {
        return { status: 409, json: { error: error.message } };
      }
      throw error;
    }
  }
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { todoId?: string; ticketId?: string; title?: string; repo?: string; task?: string; mode?: string; prNumber?: number; feedback?: string; model?: string; effort?: string; workRef?: unknown; sourceInstanceId?: unknown; sourceInstanceRevision?: unknown } | null;
    if (b?.mode === 'source') {
      if (typeof b.repo !== 'string' || !isGithubRepo(b.repo) || typeof b.sourceInstanceId !== 'string' || !/^[a-z\d-]{1,160}$/i.test(b.sourceInstanceId)) return { status: 400, json: { error: 'Valid source instance and galleon are required.' } };
      const gate = deps.canStart(b.repo);
      if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
      return handleTaskSourceApi({ method: 'POST', path: `/api/task-sources/${b.sourceInstanceId}/launch`, query: new URLSearchParams(),
        body: { instanceRevision: b.sourceInstanceRevision, repo: b.repo, ref: b.workRef, ...(typeof b.model === 'string' ? { model: b.model } : {}), ...(typeof b.effort === 'string' ? { effort: b.effort } : {}) },
        service: deps.taskSources, launch: deps.launch });
    }
    if (b?.mode === 'todo') {
      if (typeof b.todoId !== 'string') return { status: 400, json: { error: 'todoId required' } };
      const todo = await deps.todos?.get(b.todoId);
      if (!todo) return { status: 404, json: { error: 'Todo not found.' } };
      if (todo.state !== 'todo' || !todo.description.trim()) return { status: 409, json: { error: 'Todo must be in To do with a description before starting a voyage.' } };
      const gate = deps.canStart(todo.repo);
      if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
      try {
        const runId = await deps.launch({ mode: 'todo', todoId: todo.id, repo: todo.repo, model: b.model, effort: b.effort });
        return { status: 200, json: { runId } };
      } catch (error) {
        if (error instanceof TodoConflictError || error instanceof TodoValidationError) return { status: error instanceof TodoConflictError ? 409 : 400, json: { error: error.message } };
        throw error;
      }
    }
    if (typeof b?.repo !== 'string' || !b.repo.trim()) return { status: 400, json: { error: 'Galleon required' } };
    const gate = deps.canStart(b.repo);
    if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
    const tuning: { model?: string; effort?: string } = { model: b.model, effort: b.effort };
    if (b.mode === 'rerun') {
      if (typeof b.prNumber !== 'number' || !Number.isFinite(b.prNumber)) return { status: 400, json: { error: 'Galleon and PR number required' } };
      const runId: string = await deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'rerun', feedback: b.feedback, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'review') {
      if (typeof b.prNumber !== 'number' || !Number.isFinite(b.prNumber)) return { status: 400, json: { error: 'Galleon and PR number required' } };
      const runId: string = await deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'review', ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'freeform') {
      if (!b.task) return { status: 400, json: { error: 'task required' } };
      const runId = await deps.launch({ repo: b.repo, task: b.task, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode !== 'ticket' && typeof b.ticketId === 'string' && /^TODO-[1-9]\d*$/.test(b.ticketId) && await deps.todos?.get(b.ticketId)) return { status: 409, json: { error: 'Local todos must be launched from Todos.' } };
    if (deps.jiraEnabled?.() === false) return { status: 409, json: { error: 'Jira is disabled. Start a voyage from Todos.' } };
    if (!b.ticketId) return { status: 400, json: { error: 'Ticket ID and galleon required' } };
    const runId = await deps.launch({ ticketId: b.ticketId, title: b.title, repo: b.repo, ...tuning });
    return { status: 200, json: { runId } };
  }
  const stopMatch: RegExpMatchArray | null = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return { status: 200, json: { stopped: deps.stop(stopMatch[1]) } };
  }
  const autoClaimMatch: RegExpMatchArray | null = path.match(/^\/api\/repos\/(.+)\/auto-claim$/);
  if (autoClaimMatch && method === 'POST') {
    const repo: string = decodeURIComponent(autoClaimMatch[1]);
    if (!_body || typeof _body !== 'object' || Array.isArray(_body) || !('enabled' in _body) || typeof _body.enabled !== 'boolean') {
      return { status: 400, json: { error: 'enabled must be a boolean' } };
    }
    const enabled = _body.enabled;
    deps.setAutoClaim(repo, enabled);
    return { status: 200, json: { repo, enabled } };
  }
  const executionPolicyResult = handleExecutionPolicyApi({ method, path, query, body: _body, caller: deps.executionPolicyCaller, service: deps.executionPolicy });
  if (executionPolicyResult) return executionPolicyResult;
  const profileResult = await handleProfileApi({ method, path, query, caller: deps.profileCaller, service: deps.profile, signal: deps.profileSignal });
  if (profileResult) return profileResult;
  const integrationStatusResult = await handleIntegrationStatusApi({ method, path, query, service: deps.integrationStatus });
  if (integrationStatusResult) return integrationStatusResult;
  const settingsResult = await handleIntegrationSettingsApi({ method, path, query, body: _body, caller: deps.integrationSettingsCaller, service: deps.integrationSettings });
  if (settingsResult) return settingsResult;
  if (path === '/api/config' && method === 'GET') {
    return { status: 200, json: deps.getConfig() };
  }
  if (path === '/api/config' && method === 'PUT') {
    const b: { key?: string; value?: string } | null = _body as { key?: string; value?: string } | null;
    if (typeof b?.key !== 'string' || typeof b?.value !== 'string') {
      return { status: 400, json: { error: 'key and value required' } };
    }
    if (b.key === 'AGENT_ADAPTER' || b.key === 'AGENT_CMD') return { status: 410, json: { error: 'Use `helmsman plugins configure <plugin-id> …`, then `helmsman plugins select-agent <plugin/id>`.' } };
    if (b.key.startsWith('PRE_PR_')) return { status: 410, json: { error: 'Configure the selected workflow plugin; select reviewers with helmsman plugins select-agent-reviewers.' } };
    if (b.key === 'AUTO_CLAIM_INTERVAL_MS') return { status: 410, json: { error: 'Configure intervalMs on the selected scheduling plugin.' } };
    if (/^(?:JIRA_|GITHUB_)/.test(b.key)) return { status: 410, json: { error: 'Use revision-checked integration settings; live Jira source settings belong to Source settings.' } };
    if (b.key.startsWith('SLACK_')) return { status: 410, json: { error: 'Use revision-checked communication settings.' } };
    const r: { ok: true } | { ok: false; error: string } = deps.setConfig(b.key, b.value);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (['/api/pr', '/api/pr/diff', '/api/pr/open', '/api/pr/review-requests'].includes(path)) {
    return { status: 410, json: { error: 'Use the versioned pull request read and inspection services.' } };
  }
  if (path === '/api/pr/review') return { status: 410, json: { error: 'Use the public pull request command service.' } };
  const localGitResult = await handleLocalGitApi({ method, path, query, body: _body, caller: deps.localGitCaller, service: deps.publicLocalGit });
  if (localGitResult) return localGitResult;
  if (path === '/api/repo/local') return { status: 410, json: { error: 'Use scoped Local Git services.' } };
  const terminalResult = await handleTerminalApi({ method, path, query, body: _body, caller: deps.terminalCaller, service: deps.terminal });
  if (terminalResult) return terminalResult;
  if (path.startsWith('/api/cmux/')) return { status: 410, json: { error: 'Use scoped terminal services.' } };
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
