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
import { SlackReviewError, type SlackReviewResult } from './slack/review-request';
import type { Db, RunRow } from './db';
import type { PrStatus } from '../github';
import { isGithubRepo, type PrListResponse } from '../pr-lists';
import type { TriageResponse } from '../triage-endpoint';
import type { BugsResponse, PrFileDiff } from '../../src/types';
import type { CmuxTab } from './cmux/model';
import { isAllowedKey } from './cmux/keys';
import type { SlackState } from '../../src/data/slack';
import type { GithubProfile } from '../../src/data/profile';
import { retryIntent, RetryError, type LaunchIntent } from './retry';
import { ResumeError } from './resume';
import type { OutcomeService } from './outcome-service';
import { OutcomeValidationError } from './outcomes';
import type { CampaignService } from './campaign-service';
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
import { handleRunInspectApi } from './run-inspect-routes';
import type { RunInspectServerService } from './run-inspect-service';
import type { RunReadServerService } from './run-read-service';
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
  clarificationCaller?: string;
  runRead?: RunReadServerService;
  runInspect?: RunInspectServerService;
  communication?: CommunicationReadServerService;
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
  outcomes?: OutcomeService;
  campaigns?: CampaignService;
  clarifications?: ClarificationStore;
  resumeRun?: (runId: string) => Promise<void>;
  githubProfile?: () => Promise<GithubProfile>;
  slackReviewRequest?: (input: unknown) => Promise<SlackReviewResult>;
  todos?: TodoApi;
  jiraEnabled?: () => boolean;
  outboundUsage?: () => unknown;
  context?: () => { repos: string[]; jiraBaseUrl: string | null; jiraEnabled?: boolean };
  slack?: { snapshot: () => SlackState; markRead: (id: string) => boolean };
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  triage: (repo: string | null) => Promise<TriageResponse>;
  bugs: (repo: string | null) => Promise<BugsResponse>;
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: LaunchIntent & { retryOf?: string }) => string;
  stop: (runId: string) => boolean;
  setAutoClaim: (repo: string, enabled: boolean) => void;
  autoClaimRepos: () => string[];
  caps: () => { maxAttempts: number; maxCostUsd: number | null };
  getConfig: () => { config: Record<string, unknown>; overridden: string[]; jiraTokenSet: boolean };
  setConfig: (key: string, value: string) => { ok: true } | { ok: false; error: string };
  prStatus: (repo: string, prNumber: number) => Promise<PrStatus | null>;
  reviewRequestedPrs: (repo: string | null) => Promise<PrListResponse>;
  repoOpenPrs: (repo: string) => Promise<PrListResponse>;
  localGit: (repo: string) => Promise<ApiResult>;
  localGitAction?: (repo: string, body: unknown) => Promise<ApiResult>;
  prDiff: (repo: string, prNumber: number) => Promise<PrFileDiff[] | null>;
  submitReview: (
    repo: string,
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
    requestId?: string,
    expectedHeadSha?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  cmuxListTabs: () => Promise<{ connected: boolean; tabs: CmuxTab[] }>;
  cmuxReadScreen: (surface: string, lines: number) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  cmuxSend: (surface: string, text: string, enter: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  cmuxPasteImage: (surface: string, dataBase64: string, ext: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  cmuxAction: (surface: string, provider: string | null, action: string) => Promise<{ ok: true; keys: string[] } | { ok: false; error: string }>;
  cmuxKey: (surface: string, key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export async function handleApi(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: unknown,
  deps: RouterDeps,
): Promise<ApiResult | null> {
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
  const clarificationGate = path.match(/^\/api\/runs\/([a-z\d_-]{1,128})\/clarification-gate$/i);
  if (clarificationGate && method === 'GET') {
    try { return { status: 200, json: { ready: deps.clarificationGate?.(clarificationGate[1]!, query) === true } }; }
    catch { return { status: 200, json: { ready: false } }; }
  }
  if (path.startsWith('/api/campaigns') && deps.campaigns) return deps.campaigns.handle(path, method, query, _body);
  if (path.startsWith('/api/clarifications') || path === '/api/trusted-contacts') {
    if (deps.publicClarifications && method !== 'GET') return { status: 410, json: { error: 'Use the versioned clarification command or suggested-contact service. Worker ingestion requires its retained attempt channel.' } };
    const store = deps.clarifications;
    if (!store) return { status: 503, json: { error: 'Clarifications unavailable' } };
    try {
      store.timeoutDue(); store.cleanupOrphans();
      const repo = query.get('repo');
      if (repo !== null && !isGithubRepo(repo)) throw new ClarificationValidationError('Invalid galleon');
      if (path === '/api/clarifications' && method === 'POST') {
        if (!_body || typeof _body !== 'object' || !('runId' in _body) || typeof _body.runId !== 'string') throw new ClarificationValidationError('Provide a run ID');
        const run = deps.db.getRun(_body.runId);
        if (!run || repo && run.repo.toLowerCase() !== repo.toLowerCase()) throw new ClarificationValidationError('Run is not in the selected galleon');
        const { runId, ...record } = _body;
        return { status: 201, json: store.ingestQuestion(runId, { ...record, kind: 'question' }) };
      }
      if (path === '/api/clarifications' && method === 'GET') return { status: 200, json: { clarifications: store.list(repo) } };
      if (path === '/api/trusted-contacts' && method === 'GET') return { status: 200, json: { contacts: store.contacts() } };
      if (path === '/api/trusted-contacts' && method === 'POST') return { status: 201, json: store.saveContact(_body) };
      const answer = path.match(/^\/api\/clarifications\/([a-z\d_-]{1,128})\/answer$/i);
      if (answer && method === 'POST') {
        const question = store.list(repo).find(question => question.id === answer[1]);
        if (!question) return { status: 404, json: { error: 'Clarification not found in selected galleon' } };
        return { status: 200, json: store.answer(question.id, _body) };
      }
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
  if (path === '/api/slack/review-request' && method === 'POST') {
    if (deps.communicationCommands) return { status: 410, json: { error: 'Use the public communication command service.' } };
    if (!deps.slackReviewRequest) return { status: 503, json: { error: 'Slack review requests are unavailable.' } };
    try {
      return { status: 200, json: await deps.slackReviewRequest(_body) };
    } catch (error) {
      if (error instanceof SlackReviewError) return { status: error.status, json: { error: error.message, uncertain: error.uncertain } };
      return { status: 502, json: { error: 'Slack review request failed. Check Slack before retrying.', uncertain: true } };
    }
  }
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
  if (path === '/api/github/profile' && method === 'GET') {
    const profile = await deps.githubProfile?.();
    return { status: 200, json: { displayName: profile?.displayName ?? null, login: profile?.login ?? null } };
  }
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
  if (slackRead && method === 'POST') {
    if (deps.communication) return { status: 410, json: { error: 'Use the scoped communication notification service.' } };
    const ok = deps.slack?.markRead(slackRead[1]) ?? false;
    return { status: ok ? 200 : 404, json: ok ? { ok: true } : { error: 'notification not found' } };
  }
  if (path === '/api/dashboard' && method === 'GET') {
    const payload = await deps.dashboard(query.get('repo'));
    return { status: 200, json: payload };
  }
  if (path === '/api/triage' && method === 'GET') {
    return { status: 200, json: await deps.triage(query.get('repo')) };
  }
  if (path === '/api/bugs' && method === 'GET') {
    return { status: 200, json: await deps.bugs(query.get('repo')) };
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
      return { status: 200, json: { runId: deps.launch({ ...intent, retryOf: run.id }) } };
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
        const runId = deps.launch({ mode: 'todo', todoId: todo.id, repo: todo.repo, model: b.model, effort: b.effort });
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
      const runId: string = deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'rerun', feedback: b.feedback, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'review') {
      if (typeof b.prNumber !== 'number' || !Number.isFinite(b.prNumber)) return { status: 400, json: { error: 'Galleon and PR number required' } };
      const runId: string = deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'review', ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'freeform') {
      if (!b.task) return { status: 400, json: { error: 'task required' } };
      const runId = deps.launch({ repo: b.repo, task: b.task, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode !== 'ticket' && typeof b.ticketId === 'string' && /^TODO-[1-9]\d*$/.test(b.ticketId) && await deps.todos?.get(b.ticketId)) return { status: 409, json: { error: 'Local todos must be launched from Todos.' } };
    if (deps.jiraEnabled?.() === false) return { status: 409, json: { error: 'Jira is disabled. Start a voyage from Todos.' } };
    if (!b.ticketId) return { status: 400, json: { error: 'Ticket ID and galleon required' } };
    const runId = deps.launch({ ticketId: b.ticketId, title: b.title, repo: b.repo, ...tuning });
    return { status: 200, json: { runId } };
  }
  const stopMatch: RegExpMatchArray | null = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return { status: 200, json: { stopped: deps.stop(stopMatch[1]) } };
  }
  const autoClaimMatch: RegExpMatchArray | null = path.match(/^\/api\/repos\/(.+)\/auto-claim$/);
  if (autoClaimMatch && method === 'POST') {
    const repo: string = decodeURIComponent(autoClaimMatch[1]);
    const enabled: boolean = (_body as { enabled?: boolean } | null)?.enabled === true;
    deps.setAutoClaim(repo, enabled);
    return { status: 200, json: { repo, enabled } };
  }
  if (path === '/api/config' && method === 'GET') {
    return { status: 200, json: deps.getConfig() };
  }
  if (path === '/api/config' && method === 'PUT') {
    const b: { key?: string; value?: string } | null = _body as { key?: string; value?: string } | null;
    if (typeof b?.key !== 'string' || typeof b?.value !== 'string') {
      return { status: 400, json: { error: 'key and value required' } };
    }
    if (deps.communication && b.key.startsWith('SLACK_')) return { status: 410, json: { error: 'Use revision-checked communication settings.' } };
    const r: { ok: true } | { ok: false; error: string } = deps.setConfig(b.key, b.value);
    return r.ok ? { status: 200, json: { key: b.key, value: b.value } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/pr/review-requests' && method === 'GET') {
    const repo: string | null = query.get('repo');
    if (repo !== null && !isGithubRepo(repo)) return { status: 400, json: { error: 'Galleon must be owner/name' } };
    return { status: 200, json: await deps.reviewRequestedPrs(repo) };
  }
  if (path === '/api/pr/open' && method === 'GET') {
    const repo: string | null = query.get('repo');
    if (!repo || !isGithubRepo(repo)) return { status: 400, json: { error: 'Galleon must be owner/name' } };
    return { status: 200, json: await deps.repoOpenPrs(repo) };
  }
  if (path === '/api/repo/local' && method === 'POST') {
    const body = _body && typeof _body === 'object' && !Array.isArray(_body) ? _body as Record<string, unknown> : null;
    if (typeof body?.repo !== 'string' || !isGithubRepo(body.repo)) return { status: 400, json: { error: 'Galleon must be owner/name' } };
    if (!deps.localGitAction) return { status: 503, json: { error: 'Local Git actions are unavailable.' } };
    return deps.localGitAction(body.repo, body);
  }
  if (path === '/api/repo/local' && method === 'GET') {
    const repo = query.get('repo');
    if (!repo || !isGithubRepo(repo)) return { status: 400, json: { error: 'Galleon must be owner/name' } };
    return deps.localGit(repo);
  }
  if (path === '/api/pr' && method === 'GET') {
    const repo: string | null = query.get('repo');
    const numRaw: string | null = query.get('number');
    const n: number = Number(numRaw);
    if (!repo || !numRaw || !Number.isFinite(n)) {
      return { status: 400, json: { error: 'Galleon and PR number required' } };
    }
    const s: PrStatus | null = await deps.prStatus(repo, n);
    return s ? { status: 200, json: s } : { status: 404, json: { error: 'PR not found or GitHub not configured' } };
  }
  if (path === '/api/pr/diff' && method === 'GET') {
    const repo: string | null = query.get('repo');
    const numRaw: string | null = query.get('number');
    const n: number = Number(numRaw);
    if (!repo || !numRaw || !Number.isFinite(n)) {
      return { status: 400, json: { error: 'Galleon and PR number required' } };
    }
    const files: PrFileDiff[] | null = await deps.prDiff(repo, n);
    return files ? { status: 200, json: { files } } : { status: 404, json: { error: 'PR diff not found or GitHub not configured' } };
  }
  if (path === '/api/pr/review' && method === 'POST') {
    if (deps.pullRequestCommands) return { status: 410, json: { error: 'Use the public pull request command service.' } };
    const b: { repo?: string; number?: number; event?: string; body?: string; requestId?: string; expectedHeadSha?: string } | null = _body as
      | { repo?: string; number?: number; event?: string; body?: string; requestId?: string; expectedHeadSha?: string }
      | null;
    const EVENTS: string[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
    if (
      typeof b?.repo !== 'string' ||
      typeof b?.number !== 'number' ||
      !Number.isSafeInteger(b.number) || b.number < 1 ||
      b.requestId !== undefined && (typeof b.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(b.requestId)) ||
      b.expectedHeadSha !== undefined && (typeof b.expectedHeadSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(b.expectedHeadSha)) ||
      typeof b?.event !== 'string' ||
      !EVENTS.includes(b.event)
    ) {
      return { status: 400, json: { error: 'Galleon, PR number, and a valid event are required' } };
    }
    if ((b.event === 'REQUEST_CHANGES' || b.event === 'COMMENT') && (typeof b.body !== 'string' || b.body.trim() === '')) {
      return { status: 400, json: { error: 'body required for this review event' } };
    }
    const r: { ok: true } | { ok: false; error: string } = await deps.submitReview(
      b.repo,
      b.number,
      b.event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      b.body ?? '',
      ...(b.expectedHeadSha ? [b.requestId, b.expectedHeadSha] : b.requestId ? [b.requestId] : []),
    );
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/tabs' && method === 'GET') {
    return { status: 200, json: await deps.cmuxListTabs() };
  }
  if (path === '/api/cmux/screen' && method === 'GET') {
    const surface: string | null = query.get('surface');
    if (!surface) return { status: 400, json: { error: 'surface required' } };
    const lines: number = Number(query.get('lines') ?? '40');
    const r = await deps.cmuxReadScreen(surface, Number.isFinite(lines) ? lines : 40);
    return r.ok ? { status: 200, json: { surface, text: r.text } } : { status: 404, json: { error: r.error } };
  }
  if (path === '/api/cmux/send' && method === 'POST') {
    const b = _body as { surface?: string; text?: string; enter?: boolean } | null;
    if (typeof b?.surface !== 'string' || typeof b?.text !== 'string') {
      return { status: 400, json: { error: 'surface and text required' } };
    }
    const r = await deps.cmuxSend(b.surface, b.text, b.enter === true);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/paste-image' && method === 'POST') {
    const b = _body as { surface?: string; dataBase64?: string; ext?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.dataBase64 !== 'string') {
      return { status: 400, json: { error: 'surface and dataBase64 required' } };
    }
    const r = await deps.cmuxPasteImage(b.surface, b.dataBase64, typeof b.ext === 'string' ? b.ext : 'png');
    return r.ok ? { status: 200, json: { ok: true, path: r.path } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/action' && method === 'POST') {
    const b = _body as { surface?: string; provider?: string | null; action?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.action !== 'string') {
      return { status: 400, json: { error: 'surface and action required' } };
    }
    const r = await deps.cmuxAction(b.surface, b.provider ?? null, b.action);
    return r.ok ? { status: 200, json: { ok: true, keys: r.keys } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/key' && method === 'POST') {
    const b = _body as { surface?: string; key?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.key !== 'string') {
      return { status: 400, json: { error: 'surface and key required' } };
    }
    if (!isAllowedKey(b.key)) {
      return { status: 400, json: { error: 'unsupported key' } };
    }
    const r = await deps.cmuxKey(b.surface, b.key);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
