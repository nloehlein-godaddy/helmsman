import { openNotificationHistory } from './notification-history';
import { createRunInstructionService } from './run-instruction-service';
import { instructionDirectory } from './instruction-channel';
import { createExecutionPolicyService } from './execution-policy-service';
import { executionPolicyContributionEnabled } from './execution-policy-runtime';
import { openExecutionWorkspaceReceipts } from './execution-workspace-receipts';
import { executionMigrationReadiness } from './execution-schema';
import { openExecutionPolicy } from './execution-policy';
import { openExecutionOwnership } from './execution-ownership';
import { createExecutionCleanup } from './execution-cleanup';
import { localExecutionFootprint } from './execution-local-footprint';
import { mutateLocalGit } from '../local-git';
import { isContributionId } from '../../src/plugins/manifest';
import { readFeedbackSettings, writeFeedbackSettings } from './plugins/data';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import { builtinFeedbackTrackers } from './plugins/builtin-feedback-trackers';
import { createFeedbackCommandService } from './feedback-command-service';
import { resolveSelectedFeedbackTrackerProvider } from './feedback-tracker-providers';
import { loadRetainedFeedbackTrackerProvider } from './feedback-tracker-retained-loader';
import { createFeedbackTrackerProviderHttp } from './feedback-tracker-http';
import { createApplicationTaskActions } from './task-action-application';
import { handleTaskActionApi } from './task-action-routes';
import { COMMUNICATION_TIMEOUT_MS } from './communication-timeout';
import { createCommunicationConnectionHandler } from './communication-connection-http';
import { createRunLifetime } from './run-lifetime';
import { readPullRequestDetail, retainPullRequestSource, prepareCommunicationReview, readOutcomePullRequest, verifyPullRequestExecution, parsePullRequestSource } from './pull-request-source';
import { allowMutationRequest } from './request-origin';
import type { CampaignTriggerProviderV1, CommunicationReviewTriggerProviderV1, PullRequestReviewTriggerProviderV1, WebhookTriggerProviderV1 } from '../../src/plugins/trigger';
import type { SelectedTriggerCapture } from './trigger-runtime';
import type { ReviewNotificationProposal } from './slack/store';
import { prepareTriggerReview } from './trigger-review-preparation';
import { parseTriggerProvenanceV1, type TriggerProvenanceV1 } from './trigger-provenance';
import { verifyTriggerExecution } from './trigger-execution';
import { builtinTriggers } from './plugins/builtin-triggers';
import { initializeTriggerSettings, migrateCommunicationProviderDefault } from './plugins/data';
import { resolveTriggerSelection, assertTriggerSelectionCurrent } from './trigger-selection';
import type { TriggerSelectionRoleV1 } from '../../src/plugins/trigger';
import { captureTriggerReviewSource } from './trigger-read-source';
import { builtinWorkflows } from './plugins/builtin-workflows';
import { initializeWorkflowSettings, initializeWorkflowReviewerSelection, readWorkflowProviderSelection } from './plugins/data';
import { resolveWorkflowSelection, assertWorkflowSelectionCurrent } from './workflow-selection';
import { parseWorkflowRetainedProviderV1 } from './workflow-providers';
import { verifyWorkflowExecution } from './workflow-execution';
import type { WorkflowModeV1 } from '../../src/plugins/workflow';
import { createProfileService } from './profile-service';
import { profileContributionEnabled } from './profile-runtime';
import { createIntegrationSettingsService } from './integration-settings-service';
import { jiraSettingsContributionEnabled, githubSettingsContributionEnabled } from './integration-settings-runtime';
import { createLocalGitService } from './local-git-service';
import { localGitContributionEnabled } from './local-git-runtime';
import { createCampaignPublicService } from './campaigns-public-service';
import { campaignContributionEnabled } from './campaigns-runtime';
import { createTerminalService } from './terminal-service';
import { terminalContributionEnabled } from './terminal-runtime';
import { createSelectedNativeTerminalRuntime } from './native-terminal-runtime';
import { builtinNativeTerminals } from './plugins/builtin-terminals';
import { nativeTerminalProviderSelectionInitialized, initializeNativeTerminalProviderSelection, initializeNativeTerminalSettings } from './plugins/data';
import { createCommunicationRuntime, communicationContributionEnabled } from './communication-runtime';
import { createCommunicationReadService } from './communication-read-service';
import { createCommunicationCommandService } from './communication-command-service';
import { bootstrapCommunicationProviderSelection } from './communication-providers';
import { builtinCommunications } from './plugins/builtin-communications';
import { clarificationContributionEnabled, createApplicationClarifications } from './clarification-application';
import { createApplicationSourceAdmin } from './source-admin-application';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAppPagePath } from '../../src/logic/routes';
import { appPages } from '../../src/plugins/builtins';
import { createPluginCoordinator, loadPluginSnapshot, pluginDirectory } from './plugins/store';
import { createPluginManager, PluginManagementError } from './plugins/manager';
import { builtinFrontendArtifacts } from './plugins/builtin-frontend';
import { createPullRequestReadService } from './pull-request-read-service';
import { createPullRequestInspectService } from './pull-request-inspect-service';
import { createPullRequestCommandService, pullRequestCommandContributionEnabled } from './pull-request-command-service';
import { ClarificationServiceError } from './clarification-service-common';
import { createPullRequestProviderEffects } from './pull-request-provider-effects';
import { createPullRequestProviderHttp } from './pull-request-provider-http';
import { bootstrapPullRequestProviderSelection, resolveSelectedPullRequestProvider } from './pull-request-providers';
import { createActivityReadService } from './activity-read-service';
import { createRunReadService } from './run-read-service';
import { createTaskContextService } from './task-context-service';
import { createRunInspectService } from './run-inspect-service';
import { handleRunInspectExport } from './run-inspect-export';
import { openRunCommandStore } from './run-command-store';
import { createApplicationRunCommands, type RunCommandAdmissionBinding } from './run-command-application';
import { createApplicationSourceCommands } from './source-command-application';
import { openSourceCommandStore } from './source-command-store';
import { createTaskEditService } from './task-edit-service';
import { createTaskViewsReadService } from './task-views-read-service';
import { createServerPageCatalog } from './plugins/page-catalog';
import { handlePluginRequest } from './plugins/http';
import { applicationRoot, retainedRuntimePath } from './runtime-paths';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../config';
import { openDb } from './db';
import { openPersistence, persistedJson, persistenceHash, claimApplicationStartup } from './persistence';
import { openExecutionStore } from './execution-store';
import { openExecutionControls } from './execution-controls';
import { openLegacyExecutionAdoption } from './legacy-execution-adoption';
import { openPluginLifecycle } from './plugins/lifecycle';
import { openOperationStore } from './operations';
import { authorizeRunEffect, createLegacyRunEffects, type LegacyRunEffects } from './legacy-run-effects';
import { createPublicationService } from './publication-service';
import { createLegacySlackEffects } from './legacy-slack-effects';
import { createManualReviewEffects } from './manual-review-effects';
import { dispatchOperation } from './operation-dispatcher';
import { openAdmissionStore } from './admission-store';
import { createRunnerDurability } from './runner-durability';
import { legacyExecutionSnapshot, legacyExecutionSettings, nonsecretExecutionTask, restoreExecutionConfig } from './legacy-execution-snapshot';
import { retainLegacyRuntime, verifyLegacyRuntime } from './legacy-runtime-artifact';
import { openOutcomeStore, createOutcomeTelemetrySink } from './outcomes';
import { openUsageStore } from './usage-store';
import { createUsageQueryService } from './usage-service';
import { builtinPricing } from './plugins/builtin-pricing';
import { builtinAgents } from './plugins/builtin-agents';
import { builtinExecutionHosts } from './plugins/builtin-hosts';
import { resolveExecutionHostSelection, assertExecutionHostSelectionCurrent, assertExecutionHostCoordinatorSupport } from './execution-host-selection';
import { parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { loadExecutionHost, executionHostAdapter, verifyHostExecution, retainedLegacyHostKind } from './execution-host-execution';
import { initializeExecutionHostProviderSelection, executionHostProviderSelectionInitialized, readExecutionHostProviderSelection, initializeExecutionHostSettings } from './plugins/data';
import { resolveAgentSelection, assertAgentSelectionCurrent } from './agent-selection';
import { parseAgentSelectionV1 } from './agent-providers';
import { mergeExecutionArtifacts, loadExecutionAgents, verifyAgentExecution } from './agent-execution';
import { readAgentProviderSelection, initializeAgentProviderSelection, initializeCommandAgentSettings } from './plugins/data';
import { builtinScheduling } from './plugins/builtin-scheduling';
import { initializeSchedulingInterval } from './plugins/data';
import { resolveSelectedSchedulingProvider } from './scheduling-runtime';
import { builtinTaskSources } from './plugins/builtin-task-sources';
import { builtinPullRequests } from './plugins/builtin-pull-requests';
import { readPluginArtifact } from './plugins/artifacts';
import { openTaskSourceStore, type WorkClaimRecord } from './task-sources/store';
import { openSourceConnectionStore } from './task-source-connections';
import { bootstrapTaskSources } from './task-source-bootstrap';
import { createTaskSourceRuntime } from './task-source-runtime';
import { sourceExecutionSettings, sourceExecutionSnapshot } from './task-source-execution';
import type { SourceInstanceV1 } from '../../src/plugins/tasks';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { activateBackendPlugins } from './plugins/backend';
import { retainActivatedPluginPages } from './plugins/activation';
import { openRunTelemetry } from './run-telemetry';
import { prepareExecution } from './prepare-run';
import { openWebhookIntake, WebhookError } from './webhooks';
import { openWorkflowStore } from './workflow-snapshots';
import { openCampaignStore } from './campaigns';
import { createCampaignDispatcher } from './campaign-dispatcher';
import { openClarificationStore } from './clarifications';
import { createScopedGateway } from './scoped-gateway';
import { createGoCaaSUpstream, GoCaaSConfigurationError } from './gocaas';
import { listenScopedGateway } from './gateway-listener';
import { createDockerWorkspace, removeDockerWorkspace } from './docker-workspace';
import { dockerHost, dockerRun } from './docker-host';
import { createClarificationRuntime } from './clarification-runtime';
import { createClarificationChannel } from './clarification-protocol-store';
import { createClarificationGate } from './clarification-gate';
import { createOutcomeService } from './outcome-service';
import { startRunRecovery, type AttachmentHandshake } from './recovery';
import { createRecoveryService } from './recovery-service';
import { handleRecoveryRequest } from './recovery-http';
import { recoveryPage } from './recovery-page';
import { handleApi } from './router';
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { handleRunLog } from './run-log';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { resumeFailedPrePrRun, ResumeError } from './resume';
import { cmuxHost, weztermHost, detachedHost, type RunHost } from './run-host';
import { feedbackUpdateAdapter, isFeedbackUpdateAdapter } from './agents/feedback-update';
import { createFeedbackClarificationService } from './feedback-clarifications';
import { createFeedbackSnapshotService } from './feedback-snapshot-service';
import { parsePullRequestFeedbackSnapshotV1, fingerprintPullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';
import { isPrePrAdapter, prePrAdapter } from './agents/pre-pr';
import { dockerReviewAdapter } from './agents/docker-review';
import { restoreRunAdapter } from './agents/restore';
import { readReviewArtifact } from './review-artifacts';
import { captureManagedWorktreeIdentity, assertManagedWorktreeIdentity, verifyWorktreeDetached, type ManagedWorktreeIdentity, describeLocalCheckout, verifyWorktreeAbsent, withWorktreeMaintenance, createWorktree, createWorktreeFromBranch, detachRetainedFeedbackWorktree, createReviewWorktree, discoverRepoDirs, listAgentWorktrees, removeCleanWorktreeAt, removeWorktree, repoBasename, sweepOrphanedWorktrees } from './worktree';
import { findPrNumberByBranch, fetchPrStatus } from '../github';
import { openTodoStore } from './todos';
import { reconcileTodoRuns } from './todo-source';
import { repositoryScope } from './repository-scope';
import { AutoClaimScheduler, type BacklogItem } from './scheduler';
import { ConfigStore, publicConfig } from './config-store';
import { launchIntentJson, RetryError, type LaunchIntent } from './retry';
import { openSlackStore } from './slack/store';
import { openVoyageNotifications } from './voyage-notifications';
import { createSlackWatcher, type SlackWatcher } from './slack/watcher';
import { createSlackBrowserReviewSender } from './slack/browser-review';
import { slackIntegrationEnabled, slackSettings, SLACK_INTERVAL_MS } from './slack/config';
import { openSlackReviewRequester, slackReviewSettings } from './slack/review-request';
import { observeAutomaticReviewOwnership } from './automatic-review-ownership';
import type { SlackState } from '../../src/data/slack';
import { createGithubReviewWatcher } from './github-review-watcher';
import { createCreatedPrReviews } from './created-pr-reviews';
import { fetchReviewHead, selectReviewModel } from './review-policy';
import { createOutboundMeter } from './outbound-meter';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import { DEFAULT_SERVER_PORT } from './ports';

let pluginSnapshot = await loadPluginSnapshot(pluginDirectory(), process.env.HELMSMAN_PLUGIN_UI_SAFE_MODE === '1');
const outboundMeter = createOutboundMeter();

const PORT: number = Number(process.env.HELMSMAN_PORT ?? DEFAULT_SERVER_PORT);
const DIST: string = join(applicationRoot(), 'dist');
const dbPath = process.env.HELMSMAN_DB ?? join(process.cwd(), '.helmsman.sqlite');
const persistence = openPersistence(dbPath);
const applicationStartup = claimApplicationStartup(persistence);
process.once('exit', applicationStartup.close);
const db = openDb(persistence.sql);
const executions = openExecutionStore(persistence, Date.now, { preferSchema: 2 });
const executionPolicies = openExecutionPolicy(persistence);
const executionOwnership = executionMigrationReadiness(persistence.sql).currentVersion === 2 ? openExecutionOwnership(persistence) : null;
const executionWorkspaceReceipts = openExecutionWorkspaceReceipts(persistence);
const executionCleanup = executionOwnership ? createExecutionCleanup({ persistence, executions, withMaintenance: withWorktreeMaintenance,
  verifyAbsent: async (repo, workspace) => { if (!await verifyWorktreeAbsent(repo, workspace)) throw new Error('Execution workspace removal is unconfirmed'); } }) : null;
const galleonMaximum = (repo: string) => executionOwnership ? executionPolicies.read(repo).maxConcurrentRuns : 1;
const executionControls = openExecutionControls(persistence);
const legacyExecutions = openLegacyExecutionAdoption({ persistence, executions });
legacyExecutions.audit(db.listRuns(-1));
const admissions = openAdmissionStore(persistence, executions);
const lifecycle = openPluginLifecycle(persistence, executions);
const operations = openOperationStore(persistence, executions);
const sourceStore = openTaskSourceStore(persistence);
const sourceConnections = openSourceConnectionStore(persistence);
const todos = openTodoStore(persistence.sql);
reconcileTodoRuns(todos, db, runId => Boolean(admissions.get(runId)?.state.match(/^(pending|blocked)$/)) || sourceStore.claims().some(claim => claim.runId === runId && !claim.id.startsWith('legacy-')));
for (const admission of admissions.pending()) admissions.block(admission.runId, 'Restart interrupted preparation; retained bindings require reconciliation');
const slackStore = openSlackStore(persistence.sql);
const voyageNotifications = openVoyageNotifications(persistence.sql);
const notificationHistory = openNotificationHistory(persistence.sql, function* () {
  yield* slackStore.notificationIdentities();
  yield* voyageNotifications.notificationIdentities();
});
const maxConcurrency = Number(process.env.AGENT_MAX_CONCURRENCY ?? '3');
const pm: ProcessManager = new ProcessManager(maxConcurrency, { reservations: () => {
  const reservations = new Map(executions.reservations().map(row => [row.runId, row]));
  for (const row of db.activeRuns()) if (!reservations.has(row.id)) reservations.set(row.id, { runId: row.id, repo: row.repo, reason: 'unresolved' });
  return [...reservations.values()];
} }, galleonMaximum);
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();
const RUNS_DIR: string = resolve(process.env.RUNS_DIR ?? join(AGENTS_ROOT, '.helmsman-runs'));
mkdirSync(RUNS_DIR, { recursive: true });
const runtimeArtifactsRoot = join(RUNS_DIR, '.runtime-artifacts');
const currentRuntime = await retainLegacyRuntime(applicationRoot(), runtimeArtifactsRoot);

const WRAPPER = join(currentRuntime.root, 'server', 'helmsman', 'run-wrapper.mjs');
const configStore: ConfigStore = new ConfigStore(process.env, db);
configStore.initializeWebhookCredential(() => new Date().toISOString());
const usageStore = openUsageStore(persistence.sql);
const outcomeStore = openOutcomeStore(persistence.sql, undefined, usageStore);
const runTelemetry = openRunTelemetry(persistence.sql, usageStore, createOutcomeTelemetrySink(outcomeStore));
const usageQueries = createUsageQueryService({ db, usage: usageStore });
initializeSchedulingInterval(pluginDirectory(), builtinScheduling.package, configStore.current().autoClaimIntervalMs);
const agentDefaults = { writer: 'helmsman.agent-codex/codex', reviewers: ['helmsman.agent-codex/codex', 'helmsman.agent-claude/claude-code'] };
function canonicalAgentId(id: string): string {
  return ({ codex: 'helmsman.agent-codex/codex', 'claude-code': 'helmsman.agent-claude/claude-code', command: 'helmsman.agent-command/command' } as Record<string, string>)[id] ?? id;
}
initializeAgentProviderSelection(pluginDirectory(), { writer: canonicalAgentId(configStore.current().agentAdapter), reviewers: null });
initializeWorkflowReviewerSelection(pluginDirectory(), [...new Set([readAgentProviderSelection(pluginDirectory()).writer ?? agentDefaults.writer, ...agentDefaults.reviewers])].slice(0, configStore.current().prePr.reviewerCount));
const commandAgentPackage = builtinAgents.find(value => value.package.manifest.id === 'helmsman.agent-command')?.package;
if (commandAgentPackage && initializeCommandAgentSettings(pluginDirectory(), commandAgentPackage, configStore.current().agentCmd)) {
  process.stderr.write('Legacy command agent requires an explicit nonsecret commandTemplate setting on helmsman.agent-command before new launches.\n');
}
if (!executionHostProviderSelectionInitialized(pluginDirectory())) {
  const legacy = process.env.RUN_HOST?.trim() || 'detached';
  const providerId = ({ detached: 'helmsman.host-local/detached', cmux: 'helmsman.host-local/cmux', wezterm: 'helmsman.host-local/wezterm', docker: 'helmsman.host-docker/docker' } as Record<string, string>)[legacy];
  if (!providerId) throw new Error('Unknown RUN_HOST. Select an execution host with plugins select-execution-host.');
  initializeExecutionHostProviderSelection(pluginDirectory(), providerId);
}
for (const plugin of builtinExecutionHosts) {
  const mapping = plugin.package.manifest.id === 'helmsman.host-local'
    ? { weztermBin: process.env.WEZTERM_BIN, weztermRunWorkspace: process.env.WEZTERM_RUN_WORKSPACE, cmuxSocketPath: process.env.CMUX_SOCKET_PATH }
    : plugin.package.manifest.id === 'helmsman.host-docker' ? { image: process.env.HELMSMAN_DOCKER_IMAGE } : {};
  const values = Object.fromEntries(Object.entries(mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
  initializeExecutionHostSettings(pluginDirectory(), plugin.package, values);
}
const defaultNativeTerminal = process.platform === 'win32' ? 'helmsman.terminal-wezterm/wezterm' : 'helmsman.terminal-cmux/cmux';
for (const kind of ['terminal', 'browser'] as const) {
  if (nativeTerminalProviderSelectionInitialized(pluginDirectory(), kind)) continue;
  const legacy = kind === 'browser' ? 'cmux' : process.env.TERM_BRIDGE?.trim() || (process.platform === 'win32' ? 'wezterm' : 'cmux');
  const providerId = ({ cmux: 'helmsman.terminal-cmux/cmux', wezterm: 'helmsman.terminal-wezterm/wezterm' } as Record<string, string>)[legacy];
  if (!providerId) throw new Error('Unknown TERM_BRIDGE. Select a native terminal with plugins select-native-terminal.');
  initializeNativeTerminalProviderSelection(pluginDirectory(), kind, providerId);
}
for (const plugin of builtinNativeTerminals) {
  const mapping = plugin.package.manifest.id === 'helmsman.terminal-cmux'
    ? { socketPath: process.env.CMUX_SOCKET_PATH }
    : { binary: process.env.WEZTERM_BIN, socketPath: process.env.WEZTERM_UNIX_SOCKET };
  const values = Object.fromEntries(Object.entries(mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
  initializeNativeTerminalSettings(pluginDirectory(), plugin.package, values);
}
for (const plugin of builtinWorkflows) {
  if (plugin.package.manifest.id !== 'helmsman.workflow-coding') continue;
  initializeWorkflowSettings(pluginDirectory(), plugin.package, { maxRounds: configStore.current().prePr.maxRounds, stageTimeoutMinutes: configStore.current().prePr.stageTimeoutMinutes });
}
for (const plugin of builtinTriggers) {
  const env = configStore.effectiveEnv();
  const values: Record<string, string | boolean> = plugin.package.manifest.id === 'helmsman.trigger-slack-review' ? { enabled: env.SLACK_WATCH_ENABLED === 'true' }
    : plugin.package.manifest.id === 'helmsman.trigger-github-review' ? { enabled: env.GITHUB_REVIEW_WATCH_ENABLED === 'true' }
    : plugin.package.manifest.id === 'helmsman.trigger-github-webhook' ? { enabled: Boolean(configStore.webhookCredential() && env.HELMSMAN_WEBHOOK_ROUTES), routesJson: env.HELMSMAN_WEBHOOK_ROUTES ?? '[]' } : {};
  initializeTriggerSettings(pluginDirectory(), plugin.package, values);
}
const builtinBackends = [...builtinTriggers, ...builtinWorkflows, ...builtinNativeTerminals, ...builtinExecutionHosts, ...builtinAgents, builtinScheduling, builtinPricing, ...builtinTaskSources, ...builtinPullRequests, ...builtinCommunications, ...builtinFeedbackTrackers];
const pluginCoordinator = await createPluginCoordinator({ root: pluginDirectory(), persistence, executions, lifecycle,
  runtimeArtifact: currentRuntime.artifact, builtins: [...builtinBackends.map(plugin => ({ package: plugin.package, artifactHash: currentRuntime.artifact.artifactHash })),
    ...builtinFrontendArtifacts(currentRuntime.artifact.artifactHash)], resetHealth: true });
const pluginManager = createPluginManager({ root: pluginDirectory(), coordinator: pluginCoordinator, builtins: builtinBackends.map(plugin => plugin.package) });
pluginSnapshot = await loadPluginSnapshot(pluginDirectory(), process.env.HELMSMAN_PLUGIN_UI_SAFE_MODE === '1', pluginCoordinator);
const backendPlugins = await activateBackendPlugins({ root: pluginDirectory(), coordinator: pluginCoordinator,
  snapshot: process.env.HELMSMAN_PLUGIN_UI_SAFE_MODE === '1' ? await loadPluginSnapshot(pluginDirectory(), false, pluginCoordinator) : pluginSnapshot,
  usage: usageQueries, builtins: builtinBackends, defaultPricingProvider: 'helmsman.standard-pricing/standard' });
bootstrapPullRequestProviderSelection(pluginDirectory(), 'helmsman.github/github');
migrateCommunicationProviderDefault(pluginDirectory(), 'helmsman.slack/slack', 'helmsman.slack-companion/slack');
bootstrapCommunicationProviderSelection(pluginDirectory(), 'helmsman.slack-companion/slack');
for (const error of backendPlugins.errors) process.stderr.write(`${error}\n`);
pluginSnapshot = retainActivatedPluginPages(await loadPluginSnapshot(pluginDirectory(), process.env.HELMSMAN_PLUGIN_UI_SAFE_MODE === '1', pluginCoordinator), backendPlugins.activePluginIds());
const serverPages = createServerPageCatalog(appPages);
serverPages.apply(pluginSnapshot.catalog);
let pluginSnapshotRefresh = Promise.resolve();
function refreshPluginSnapshot(): Promise<void> {
  const refresh = pluginSnapshotRefresh.then(async () => {
    const next = retainActivatedPluginPages(await loadPluginSnapshot(pluginDirectory(), process.env.HELMSMAN_PLUGIN_UI_SAFE_MODE === '1', pluginCoordinator), backendPlugins.activePluginIds());
    for (const previous of pluginSnapshot.catalog.plugins) if (!next.catalog.plugins.some(plugin => plugin.package.manifest.id === previous.package.manifest.id)) {
      const id = previous.package.manifest.id;
      const state = pluginCoordinator.state(id);
      if (!previous.package.backend && state?.desiredEnabled === false) lifecycle.recordHealth(id, state.artifactHash, 'inactive', null);
    }
    serverPages.apply(next.catalog);
    pluginSnapshot = next;
  });
  pluginSnapshotRefresh = refresh.catch(() => {});
  return refresh;
}
pluginCoordinator.subscribe(refreshPluginSnapshot);
for (const error of pluginSnapshot.errors) process.stderr.write(`${error}\n`);
const workflows = openWorkflowStore(persistence.sql);
const clarifications = openClarificationStore(persistence.sql, { getRun: id => db.getRun(id) });
function clarificationBinding(runId: string, expectedAttempt?: number) {
  const row = db.getRun(runId);
  if (!row || expectedAttempt !== undefined && row.attempt !== expectedAttempt) throw new Error('Clarification attempt is unavailable');
  return { attempt: row.attempt, channel: clarifications.protocol.verify(executionSnapshot(row)), active: row.status === 'running' && !stopRequested(runId) };
}
const clarificationRuntime = createClarificationRuntime(clarifications, RUNS_DIR, { resolve: clarificationBinding });
function clarificationReady(runId: string, attempt?: number, channelId?: string): boolean {
  clarificationRuntime.poll(runId, attempt, channelId);
  return !clarificationRuntime.hasUnanswered(runId, attempt, channelId);
}
const clarificationGate = createClarificationGate({ resolve: clarificationBinding, ready: clarificationReady });
const feedbackClarifications = createFeedbackClarificationService({ resolve: clarificationBinding, store: clarifications, poll: clarificationRuntime.poll });
clarifications.cleanupOrphans();
const outcomes = createOutcomeService({ db, store: outcomeStore, sourceIdentity: () => {
  try { const source = captureTriggerPullRequest(AbortSignal.timeout(3000)); return persistenceHash({ revision: source.revision, repos: source.repos }); } catch { return null; }
}, fetchPr: (repo, number) => readOutcomePullRequest({ repo, number }, captureTriggerPullRequest(AbortSignal.timeout(3000))) });
const slackReviewRequester = openSlackReviewRequester(persistence.sql, {
  settings: () => slackReviewSettings(configStore.effectiveEnv()),
  send: input => createSlackBrowserReviewSender(slackSettings(configStore.effectiveEnv())).send(input),
  getPr: (repo, prNumber) => {
    const github = configStore.current().github;
    return github ? fetchPrStatus(github, repo, prNumber) : Promise.resolve(null);
  },
});
const manualReviewEffects = createManualReviewEffects({ persistence, operations,
  assertAdmission: () => { if (!pluginCoordinator.canActivate(currentRuntime.artifact.pluginId, currentRuntime.artifact.artifactHash)) throw new Error('Retained review provider is disabled'); },
  currentConfig: () => configStore.current(),
  artifact: currentRuntime.artifact, verifyArtifacts: verifyEffectArtifacts });
const slackEffects = createLegacySlackEffects({ persistence, operations, artifact: currentRuntime.artifact,
  requester: slackReviewRequester, verifyArtifacts: verifyEffectArtifacts,
  assertAdmission: () => { if (!pluginCoordinator.canActivate(currentRuntime.artifact.pluginId, currentRuntime.artifact.artifactHash)) throw new Error('Retained Slack provider is disabled'); },
  currentTarget: () => {
    const env = configStore.effectiveEnv();
    const settings = slackReviewSettings(env);
    const browser = slackSettings(env);
    return { ...settings, workspace: browser.clientId,
      connectionId: persistenceHash({ workspace: browser.clientId, surface: browser.surface ?? null }) };
  },
});
const startupCfg: AppConfig = configStore.current();
const unmaskedConfig = () => loadConfig({ ...configStore.effectiveEnv(), JIRA_ENABLED: 'true' });
const sourceBootstrap = await bootstrapTaskSources({ store: sourceStore, connections: sourceConnections, registry: backendPlugins.taskSources,
  config: { ...unmaskedConfig(), jiraEnabled: startupCfg.jiraEnabled }, repos: repositoryScope(unmaskedConfig(), todos.list()),
  jiraCredentials: () => unmaskedConfig().jira, signal: AbortSignal.timeout(30_000) });
for (const diagnostic of sourceBootstrap.diagnostics) process.stderr.write(`${diagnostic}\n`);
const schedulingSelection = () => resolveSelectedSchedulingProvider({ root: pluginDirectory(), registry: backendPlugins.scheduling, defaultProvider: 'helmsman.scheduling/round-robin' });
export const taskSourceRuntime = createTaskSourceRuntime({ scheduling: schedulingSelection, store: sourceStore, registry: backendPlugins.taskSources, connections: sourceConnections,
  executions, admissions, operations, db, ...sourceBootstrap, config: () => configStore.current(), jiraCredentials: () => unmaskedConfig().jira,
  artifacts: sourceArtifactClosure, verifyArtifacts: verifyEffectArtifacts, isStopped: stopRequested,
  report: message => process.stderr.write(`${message}\n`) });
taskSourceRuntime.schedule.initialize({ repos: taskSourceRuntime.repos(), defaultSourceId: startupCfg.jiraEnabled ? sourceBootstrap.jiraSourceId : sourceBootstrap.todoSourceId });
const sourceTodos = taskSourceRuntime.todoApi ?? {
  list: () => { throw new Error('Local task source is unavailable'); }, get: () => { throw new Error('Local task source is unavailable'); },
  create: () => { throw new Error('Local task source is unavailable'); }, update: () => { throw new Error('Local task source is unavailable'); }, remove: () => { throw new Error('Local task source is unavailable'); },
};
function applicationRepos(cfg = configStore.current()) { return [...new Set([...repositoryScope(cfg, []), ...taskSourceRuntime.repos()])]; }
const activityRead = createActivityReadService({ sources: taskSourceRuntime.service, repos: applicationRepos });
const taskEdit = createTaskEditService({ ...taskSourceRuntime, repos: applicationRepos, getRun: id => db.getRun(id) });
const taskViews = createTaskViewsReadService({ sources: taskSourceRuntime.service, repos: applicationRepos, relatedRun(ref, repo) {
  const claim = taskSourceRuntime.store.latestClaim(ref);
  const run = claim ? db.getRun(claim.runId) : null;
  return run?.repo === repo ? { repo, runId: run.id } : null;
} });
const sourceCommands = createApplicationSourceCommands({ ...taskSourceRuntime, repos: applicationRepos,
  commands: openSourceCommandStore(persistence), catalog: () => pluginSnapshot.catalog });

const taskActions = createApplicationTaskActions({ ...taskSourceRuntime, operations, repos: applicationRepos,
  verifyArtifacts: verifyEffectArtifacts, catalog: () => pluginSnapshot.catalog });

const scheduler: AutoClaimScheduler = new AutoClaimScheduler({
  canStart: (r: string) => pm.canStart(r).ok,
  fetchTopBacklog,
  launch,
  onLog: (m: string) => process.stderr.write(m + '\n'),
});

const sourceAdmin = createApplicationSourceAdmin({ ...taskSourceRuntime, scheduler, repos: applicationRepos, catalog: () => pluginSnapshot.catalog });

const runSettlement = (runId: string): { state: 'settled' | 'operator-required' | 'pending' } | null => {
  const claim = taskSourceRuntime.claimForRun(runId);
  return claim ? { state: claim.state === 'settled' ? 'settled' : claim.settlement?.disposition === 'retained-for-operator' ? 'operator-required' : 'pending' } : null;
};
const runRead = createRunReadService({ db, repos: applicationRepos, settlement: runSettlement });
const taskContext = createTaskContextService({ sources: taskSourceRuntime.service, store: taskSourceRuntime.store, db, repos: applicationRepos });
const runInspect = createRunInspectService({ db, repos: applicationRepos, settlement: runSettlement });
const publicClarifications = createApplicationClarifications({ persistence, clarifications, executions, controls: executionControls,
  repos: applicationRepos, catalog: () => pluginSnapshot.catalog });
const runInstructions = createRunInstructionService({ persistence, runsDir: RUNS_DIR, repos: applicationRepos,
  authorize(caller) { if (!clarificationContributionEnabled(pluginSnapshot.catalog, caller, 'run-instructions')) throw new ClarificationServiceError(403, 'forbidden'); },
  resolve(runId) {
    const run = db.getRun(runId); if (!run) return null;
    const bound = clarificationBinding(runId);
    const snapshot = executionSnapshot(run);
    const task = snapshot.task as unknown as AgentTask;
    return { repo: run.repo, attempt: run.attempt, channelId: bound?.channel?.channelId ?? null,
      active: bound?.active === true, supported: Boolean(task.instructions && bound?.channel && !task.dockerExecution && !task.hostIsolation
        && task.instructions.runId === runId && task.instructions.attempt === run.attempt && task.instructions.channelId === bound.channel.channelId
        && task.instructions.directory === instructionDirectory(RUNS_DIR, runId, run.attempt, bound.channel.channelId)) };
  },
});
const runCommands = createApplicationRunCommands({ store: openRunCommandStore(persistence), db, admissions, executions, controls: executionControls,
  catalog: () => pluginSnapshot.catalog, repos: applicationRepos, todos: sourceTodos, jiraEnabled: () => taskSourceRuntime.jiraEnabled(),
  canStart: repo => pm.canStart(repo), launch: input => launch(input), stop: runId => pm.stop(runId) });

const nativeTerminal = createSelectedNativeTerminalRuntime({ root: pluginDirectory(), registry: backendPlugins.nativeTerminals, defaultProviderId: defaultNativeTerminal });
const terminal = createTerminalService({ persistence, bridge: nativeTerminal.bridge, sessionIdentity: nativeTerminal.sessionIdentity,
  repos: applicationRepos,
  roots: () => [...applicationRepos().map(repo => ({ repo, path: join(AGENTS_ROOT, repoBasename(repo)) })),
    ...db.listRuns(10_000).flatMap(run => run.worktreePath && applicationRepos().includes(run.repo) ? [{ repo: run.repo, path: run.worktreePath }] : [])],
  authorize: caller => {
    if (!terminalContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden');
  },
  async pasteImage(surface, dataBase64, mimeType) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType];
    if (!extension) return { ok: false, error: 'Unsupported image type' };
    const file = join(tmpdir(), `helmsman-clip-${randomUUID()}.${extension}`);
    const session = nativeTerminal.sessionIdentity();
    await writeFile(file, Buffer.from(dataBase64, 'base64'), { mode: 0o600 });
    if (session !== nativeTerminal.sessionIdentity()) throw new ClarificationServiceError(409, 'conflict');
    return nativeTerminal.bridge.send(surface, `${file} `, false);
  },
});

const executionHostOptions = { root: pluginDirectory(), registry: backendPlugins.executionHosts };
const selectExecutionHost = () => resolveExecutionHostSelection({ ...executionHostOptions, defaultProviderId: 'helmsman.host-local/detached' });
const DOCKER_WORKSPACES = join(AGENTS_ROOT, '.helmsman-docker-workspaces');
function stopRequested(runId: string): boolean {
  return executionControls.isStopRequested({ runId, attempt: db.getRun(runId)?.attempt ?? 1 });
}
function recordStopRequest(runId: string): void {
  executionControls.requestStop({ runId, attempt: db.getRun(runId)?.attempt ?? 1 });
}
const publicationService = createPublicationService({ persistence, operations, executions, runsDir: RUNS_DIR,
  getRun: id => db.getRun(id), currentConfig: () => configStore.current(),
  verifyArtifacts: verifyEffectArtifacts,
  clarificationReady,
  isStopped: runId => stopRequested(runId),
});

const goCaas = createGoCaaSUpstream(process.env);
const gateway = createScopedGateway({ path: persistence.sql, modelUpstream: goCaas, githubKey: () => configStore.current().github?.token,
  active: runId => db.getRun(runId)?.status === 'running' && !stopRequested(runId),
  push: publicationService.push, publication: publicationService.publish,
  scope: runId => {
    const run = db.getRun(runId);
    if (!run) return null;
    const task = run.taskJson ? JSON.parse(run.taskJson) as AgentTask : null;
    return { repo: run.repo, branch: task?.prBranch ?? `agent/${runId}`, readOnly: Boolean(task?.review) };
  },
  clarificationReady, clarificationGate,
});
const integrationSettings = createIntegrationSettingsService({ persistence,
  githubValues: () => { const env = configStore.effectiveEnv(); return { defaultRepo: env.GITHUB_REPO ?? '', author: env.GITHUB_PR_AUTHOR ?? '', reviewWatchEnabled: triggerEnabled('github-review') }; },
  writeGithub: values => {
    if (values.reviewWatchEnabled !== triggerEnabled('github-review')) throw new Error('Configure the selected GitHub review trigger to change automatic reviews.');
    for (const [key, value] of Object.entries({ GITHUB_REPO: values.defaultRepo, GITHUB_PR_AUTHOR: values.author })) configStore.setOverride(key, value, () => new Date().toISOString());
  },
  afterGithubSave: () => { queueMicrotask(() => { void pollGithubReviews(); }); },
  githubTokenSet: () => Boolean(configStore.effectiveEnv().GITHUB_TOKEN?.trim()),
  jiraTokenSet: () => configStore.hasJiraToken(),
  writeJiraToken: token => configStore.setSecret('JIRA_API_TOKEN', token, () => new Date().toISOString()),
  sourceConfigured: () => taskSourceRuntime.store.sources().some(source => source.provisioningKey === 'legacy-jira'),
  bootstrapEnabled: () => configStore.current().jiraEnabled,
  authorize: (caller, namespace) => {
    const enabled = namespace === 'helmsman.jira/settings' ? jiraSettingsContributionEnabled(pluginSnapshot.catalog, caller) : githubSettingsContributionEnabled(pluginSnapshot.catalog, caller);
    if (!enabled) throw new ClarificationServiceError(403, 'forbidden');
  },
});
const executionPolicy = createExecutionPolicyService({ persistence, repos: applicationRepos,
  safetyReady: () => true,
  limits: repo => ({ globalMaxConcurrentRuns: maxConcurrency, perRunCostCapUsd: configStore.current().maxCostUsd,
    activeRuns: executions.reservations().filter(row => row.repo.toLowerCase() === repo.toLowerCase()).length }),
  authorize: caller => { if (!executionPolicyContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden'); },
});
function protectedExecutionBranches(repo: string): string[] {
  return executionOwnership?.held().filter(owner => owner.footprint.repo === repo.toLowerCase()).flatMap(owner => owner.footprint.completeness === 'exclusive' ? ['*']
    : owner.footprint.resources.filter(resource => resource.kind === 'branch' && resource.namespace === `github.com/${repo.toLowerCase()}`).map(resource => resource.identity.replace(/^refs\/heads\//, ''))) ?? [];
}
const publicLocalGit = createLocalGitService({ persistence, agentsRoot: AGENTS_ROOT, repos: applicationRepos,
  mutate: (root, repo, repos, action, options) => withWorktreeMaintenance(describeLocalCheckout(root, repo, 'local-git').path, () => mutateLocalGit(root, repo, repos, action, options)),
  activeWorktreePaths: () => [...db.listRuns(-1).flatMap(run => run.worktreePath && (run.status === 'running' || !executions.cleanupEligibility(run.id).allowed) ? [run.worktreePath] : []),
    ...(executionOwnership?.held().filter(owner => !executions.cleanupEligibility(owner.footprint.runId).allowed).flatMap(owner => owner.footprint.resources.filter(resource => resource.kind === 'workspace').map(resource => resource.identity)) ?? [])],
  protectedBranches: protectedExecutionBranches,
  protectOperation: (repo, operation) => {
    const branches = operation.action === 'delete-branch' ? [operation.branch] : operation.action === 'delete-untracked-branches' ? operation.branches.map(item => item.branch) : [];
    const protectedBranches = protectedExecutionBranches(repo);
    if (branches.some(branch => protectedBranches.includes('*') || protectedBranches.includes(branch))) throw new Error('Branch remains owned by an execution');
  },
  mutateWorktree: async (repo, path, operation, effect) => {
    const row = db.listRuns(-1).find(run => run.repo.toLowerCase() === repo.toLowerCase() && run.worktreePath === path);
    const owner = row ? executionOwnership?.get(row.id) : executionOwnership?.held().find(item => item.footprint.resources.some(resource => resource.kind === 'workspace' && resource.identity === path));
    if (!owner || owner.state === 'released') { await effect(); return; }
    if (operation === 'release') { await detachOwnedWorkspace(owner.footprint.runId, repo, path, effect); return; }
    await cleanupWorkspace(owner.footprint.runId, repo, path, effect);
  },
  authorize: caller => {
    if (!localGitContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden');
  },
});
const campaignsStore = openCampaignStore(persistence.sql, { galleonMaximum });
const publicCampaigns = createCampaignPublicService({ persistence, store: campaignsStore, repos: applicationRepos,
  workflowAvailable: providerId => { try { resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: 'coding', providerId }); return true; } catch { return false; } },
  workflows: () => backendPlugins.workflows.list().filter(value => value.record.metadata.modes.includes('coding')).map(value => ({ ref: `${value.record.binding.providerId}@1`, name: value.record.metadata.label })),
  authorize: caller => {
    if (!campaignContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden');
  },
});
const webhooks = openWebhookIntake(persistence.sql, {
  secret: () => configStore.webhookCredential()?.secret, credentialHandle: () => configStore.webhookCredential()?.handle ?? null,
  captureTrigger: () => captureTrigger<WebhookTriggerProviderV1>('github-webhook'),
  retainPins: executions.retainPins, releaseTriggerPins: executions.releaseTriggerPins,
  assertWorkflow: input => { resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: input.mode === 'review' ? 'review' : 'coding', providerId: input.workflowRef }); },
  verifyLaunch: input => { resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: input.mode === 'review' ? 'review' : 'coding', providerId: input.workflowRef }); },
  allowedRepos: () => { const cfg = configStore.current(); return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])]; },
  canStart: repo => pm.canStart(repo).ok, getRun: triggerRun, isRunActive: id => pm.hasRun(id), launch,
});
await taskSourceRuntime.recoverAdmissions();
applicationStartup.ready();
const gatewayServer = gateway.server();
const retainedIsolation = (persistence.sql.prepare('SELECT taskJson FROM runs WHERE taskJson IS NOT NULL').all() as Array<{ taskJson: string }>).some(row => {
  try { const task = JSON.parse(row.taskJson) as AgentTask | null; return Boolean(task?.hostIsolation || task?.dockerExecution); } catch { return false; }
});
let selectedIsolation = false;
try { selectedIsolation = selectExecutionHost().record.metadata.stageExecution === 'isolated'; } catch {}
const gatewayAllowsIsolation = selectedIsolation || retainedIsolation;
const gatewayPort = await listenScopedGateway(gatewayServer, { runsDir: RUNS_DIR, docker: gatewayAllowsIsolation,
  configuredPort: process.env.HELMSMAN_GATEWAY_PORT === undefined ? undefined : Number(process.env.HELMSMAN_GATEWAY_PORT) });
const gatewayUrl = `http://host.docker.internal:${gatewayPort}`;
function publicationConnection(runId: string) {
  return { url: `http://127.0.0.1:${gatewayPort}/publication/v1`, token: gateway.issuePublication(runId, 86_400_000).token };
}
interface RunHostContext { host: RunHost; workspace: 'worktree' | 'clone'; isolated: boolean; }
function boundRunHost(runId: string, task: AgentTask, loaded: Awaited<ReturnType<typeof loadExecutionHost>>): RunHostContext {
  if (!task.executionHost || task.hostConfiguration === undefined) throw new Error('Retained execution host is incomplete');
  return { host: executionHostAdapter({ runId, providerId: task.executionHost.binding.providerId, provider: loaded.provider,
    configuration: task.hostConfiguration, wrapperPath: WRAPPER, runtimeRoot: currentRuntime.root }),
    workspace: task.executionHost.metadata.workspace, isolated: task.executionHost.metadata.stageExecution === 'isolated' };
}
function legacyRunHost(row: RunRow, task: AgentTask | null): RunHostContext {
  const retainedKind = retainedLegacyHostKind(row, executionSnapshot(row));
  let host: RunHost;
  if (retainedKind === 'detached') host = detachedHost(WRAPPER);
  else if (retainedKind === 'cmux') host = cmuxHost(WRAPPER);
  else if (retainedKind === 'wezterm') host = weztermHost(WRAPPER);
  else if (retainedKind === 'docker' && task?.dockerExecution?.image) host = dockerHost({ image: task.dockerExecution.image,
    runtimeRoot: RUNS_DIR, wrapperPath: WRAPPER, run: dockerRun, enabled: true });
  else throw new Error('The original legacy execution host is unavailable');
  const selected = host;
  host = { ...selected, launch: spec => {
    const remap = (value: string) => retainedRuntimePath(value, applicationRoot(), currentRuntime.root);
    return selected.launch({ ...spec, cmd: remap(spec.cmd), args: spec.args.map(remap) });
  } };
  return { host, workspace: task?.dockerExecution ? 'clone' : 'worktree', isolated: Boolean(task?.dockerExecution) };
}
async function retainedRunHost(row: RunRow) {
  const task = row.taskJson ? JSON.parse(row.taskJson) as AgentTask : null;
  if (!task?.executionHost) return { context: legacyRunHost(row, task), async dispose() {} };
  const snapshot = executionSnapshot(row);
  if (persistenceHash(nonsecretExecutionTask(task)) !== persistenceHash(snapshot.task)) throw new Error('Saved host task differs from its immutable snapshot');
  verifyHostExecution(task, snapshot);
  const loaded = await loadExecutionHost({ ...task, hostRuntime: { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot), artifacts: snapshot.artifacts } });
  return { context: boundRunHost(row.id, task, loaded), dispose: () => releaseRunHost(row.id, loaded) };
}
async function releaseRunHost(runId: string, loaded: Awaited<ReturnType<typeof loadExecutionHost>>): Promise<void> {
  try {
    const row = db.getRun(runId);
    if (row && executions.attempt({ runId, attempt: row.attempt })?.outcome) await loaded.provider.stopStages?.(runId);
  } catch (error) { process.stderr.write(`Retained host stage cleanup failed: ${String(error)}\n`); }
  finally { await loaded.dispose(); }
}
async function stopLegacyDockerStages(runId: string): Promise<void> {
  if (!/^[a-z\d_-]{1,128}$/i.test(runId)) return;
  try {
    const result = await dockerRun(['docker', 'ps', '-aq', '--filter', `label=helmsman.runId=${runId}`]);
    const ids = result.stdout.trim().split(/\s+/).filter(id => /^[a-f\d]{12,64}$/.test(id));
    if (ids.length) await dockerRun(['docker', 'rm', '-f', ...ids]);
    const networks = await dockerRun(['docker', 'network', 'ls', '-q', '--filter', `label=helmsman.runId=${runId}`]);
    const networkIds = networks.stdout.trim().split(/\s+/).filter(id => /^[a-f\d]{12,64}$/.test(id));
    if (networkIds.length) await dockerRun(['docker', 'network', 'rm', ...networkIds]);
  } catch (error) { process.stderr.write(`Docker stage cleanup failed: ${String(error)}\n`); }
}
async function standaloneWorkspace(context: RunHostContext, repo: string, runId: string, mode: 'fresh' | 'review' | 'branch',
  create: () => Promise<{ path: string; branch: string }>, headSha?: string): Promise<{ path: string; branch: string }> {
  const source = await create();
  if (context.workspace !== 'clone') return source;
  const checkout = describeLocalCheckout(AGENTS_ROOT, repo, runId);
  const stagingIdentity = await captureManagedWorktreeIdentity(checkout.path, source.path);
  executionWorkspaceReceipts.record(runId, source.path, stagingIdentity);
  try {
    return await createDockerWorkspace({ source: source.path, root: DOCKER_WORKSPACES, runId, mode,
      branch: source.branch, ...(headSha ? { headSha } : {}) });
  } finally {
    await assertManagedWorktreeIdentity(checkout.path, source.path, stagingIdentity);
    await removeWorktree(AGENTS_ROOT, repo, source.path);
  }
}

try { process.stdout.write(`execution host: ${selectExecutionHost().record.binding.providerId}\n`); }
catch (error) { process.stderr.write(`Execution host unavailable for new launches: ${String(error)}\n`); }
for (const row of db.listRuns(10_000)) {
  if (row.status === 'running') continue;
  if (row.taskJson?.includes('hostIsolation') && executions.attempt({ runId: row.id, attempt: row.attempt })?.outcome) {
    void retainedRunHost(row).then(loaded => loaded.dispose()).catch(error => process.stderr.write(`Retained host cleanup blocked: ${String(error)}\n`));
  } else if (executions.cleanupEligibility(row.id).allowed && row.taskJson?.includes('dockerExecution')) void stopLegacyDockerStages(row.id);
}


function sourceArtifactClosure(instance: SourceInstanceV1, claim?: WorkClaimRecord): readonly ArtifactBinding[] {
  const captured = claim ? executions.pins().filter(pin => pin.kind === 'dependency' && pin.ownerId === `source-claim:${claim.id}`) : [];
  const result = new Map<string, ArtifactBinding>();
  function visit(pluginId: string, artifactHash: string): void {
    const prior = result.get(pluginId);
    if (prior) { if (prior.artifactHash !== artifactHash) throw new Error('Source artifact closure conflicts'); return; }
    const row = persistence.sql.prepare('SELECT json FROM plugin_artifacts WHERE pluginId=? AND artifactHash=?').get(pluginId, artifactHash) as { json: string } | undefined;
    const artifact = row ? (persistedJson(JSON.parse(row.json)) as unknown as { artifact: ArtifactBinding }).artifact : null;
    if (!artifact || artifact.pluginId !== pluginId || artifact.artifactHash !== artifactHash || !Array.isArray(artifact.requires)) throw new Error('Source artifact closure is unavailable');
    result.set(pluginId, artifact);
    for (const dependency of artifact.requires) {
      const hash = captured.find(pin => pin.pluginId === dependency)?.artifactHash ?? pluginCoordinator.state(dependency)?.artifactHash;
      if (!hash) throw new Error('Source artifact dependency is unavailable');
      visit(dependency, hash);
    }
  }
  visit(instance.binding.pluginId, instance.binding.artifactHash);
  return [...result.values()];
}
async function verifyEffectArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.pluginId === currentRuntime.artifact.pluginId || builtinBackends.some(plugin => plugin.package.manifest.id === artifact.pluginId)) {
      if (artifact.artifactHash !== currentRuntime.artifact.artifactHash || !await verifyLegacyRuntime(runtimeArtifactsRoot, artifact.artifactHash)) throw new Error('Retained effect runtime is unavailable');
    } else {
      const archive = await readPluginArtifact(pluginDirectory(), artifact.artifactHash);
      if (archive.package.manifest.id !== artifact.pluginId || archive.package.manifest.version !== artifact.packageVersion) throw new Error('Retained source artifact is unavailable');
    }
  }
}
function pullRequestConnection(): { connectionId: string; credentialHandle: string } | null {
  const github = configStore.current().github;
  if (!github?.token || typeof github.author !== 'string' || !github.author.trim()) return null;
  return { connectionId: persistenceHash({ host: 'api.github.com', author: github.author }), credentialHandle: 'github-primary' };
}
function selectedPullRequestProvider(): ProviderBinding | null {
  return resolveSelectedPullRequestProvider({ root: pluginDirectory(), registry: backendPlugins.pullRequests, connection: pullRequestConnection });
}
function samePullRequestBinding(first: ProviderBinding, second: ProviderBinding | null): boolean {
  return second !== null && first.role === second.role && first.capability === second.capability && first.contractVersion === second.contractVersion
    && first.contributionId === second.contributionId && first.pluginId === second.pluginId && first.artifactHash === second.artifactHash
    && first.connectionId === second.connectionId && first.credentialHandle === second.credentialHandle;
}
function pullRequestSelectionChanged(): Error & { reason: 'selection-changed' } {
  return Object.assign(new Error('selection-changed'), { reason: 'selection-changed' as const });
}
function pullRequestRegistration(binding: ProviderBinding, purpose: 'admission' | 'obligation') {
  return backendPlugins.pullRequests.resolve({ providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash,
    contractVersion: 1, connectionId: null, credentialHandle: null }, purpose);
}
function providerArtifacts(binding: Pick<ProviderBinding, 'pluginId' | 'artifactHash'>): readonly ArtifactBinding[] {
  const result = new Map<string, ArtifactBinding>();
  function visit(pluginId: string, artifactHash: string): void {
    const prior = result.get(pluginId);
    if (prior) { if (prior.artifactHash !== artifactHash) throw new Error('Provider artifact closure conflicts'); return; }
    const row = persistence.sql.prepare('SELECT json FROM plugin_artifacts WHERE pluginId=? AND artifactHash=?').get(pluginId, artifactHash) as { json: string } | undefined;
    const artifact = row ? (persistedJson(JSON.parse(row.json)) as unknown as { artifact: ArtifactBinding }).artifact : null;
    if (!artifact || artifact.pluginId !== pluginId || artifact.artifactHash !== artifactHash || !Array.isArray(artifact.requires)) throw new Error('Provider artifact closure is unavailable');
    result.set(pluginId, artifact);
    for (const dependency of artifact.requires) {
      const hash = pluginCoordinator.state(dependency)?.artifactHash;
      if (!hash) throw new Error('Provider artifact dependency is unavailable');
      visit(dependency, hash);
    }
  }
  visit(binding.pluginId, binding.artifactHash);
  return [...result.values()];
}
function pullRequestContext(binding: ProviderBinding, signal: AbortSignal, mutation: boolean) {
  const requireConnection = () => {
    const github = configStore.current().github;
    const connection = pullRequestConnection();
    if (!github?.token || !connection || connection.connectionId !== binding.connectionId || connection.credentialHandle !== binding.credentialHandle) throw new Error('Pinned GitHub pull request connection is unavailable.');
    return github;
  };
  const github = requireConnection();
  return { signal, configuredAuthor: github.author, http: createPullRequestProviderHttp({
    connection: { id: binding.connectionId!, credentialHandle: binding.credentialHandle!, origin: 'https://api.github.com', subject: github.author }, signal, mutation,
    authorize: () => { requireConnection(); },
    resolve: async () => {
      const current = requireConnection();
      return { id: binding.connectionId!, credentialHandle: binding.credentialHandle!, origin: 'https://api.github.com', subject: current.author,
        headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    },
  }) };
}
function feedbackTrackerContext(binding: ProviderBinding, signal: AbortSignal, mutation: boolean) {
  const requireConnection = () => {
    const github = configStore.current().github;
    const connection = pullRequestConnection();
    if (!github?.token || !connection || connection.connectionId !== binding.connectionId || connection.credentialHandle !== binding.credentialHandle) throw new Error('Pinned GitHub feedback tracker connection is unavailable.');
    return github;
  };
  const github = requireConnection();
  return { signal, configuredAuthor: github.author, http: createFeedbackTrackerProviderHttp({
    connection: { id: binding.connectionId!, credentialHandle: binding.credentialHandle!, origin: 'https://api.github.com', subject: github.author }, signal, mutation,
    authorize: () => { requireConnection(); },
    resolve: async () => {
      const current = requireConnection();
      return { id: binding.connectionId!, credentialHandle: binding.credentialHandle!, origin: 'https://api.github.com', subject: current.author,
        headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    },
  }) };
}
function pullRequestReadContext(binding: ProviderBinding, signal: AbortSignal) {
  const initial = configStore.current().github;
  if (!initial?.token || typeof initial.author !== 'string' || !initial.author.trim()) throw pullRequestSelectionChanged();
  const context = pullRequestContext(binding, signal, false);
  return { context, assertCurrent() {
    const current = configStore.current().github;
    if (!samePullRequestBinding(binding, selectedPullRequestProvider()) || current?.token !== initial.token || current.author !== initial.author) throw pullRequestSelectionChanged();
  } };
}
function selectedTrigger(kind: TriggerSelectionRoleV1) {
  const options = { root: pluginDirectory(), registry: backendPlugins.triggers };
  const selection = resolveTriggerSelection({ ...options, kind });
  if (!selection.record || selection.record.settings.enabled === false) return null;
  const registration = backendPlugins.triggers.resolve(selection.record.binding);
  return { instanceId: kind, selectionRevision: selection.revision, record: selection.record,
    provider: registration.provider, artifacts: providerArtifacts(selection.record.binding),
    assertCurrent() { assertTriggerSelectionCurrent(options, selection); } };
}
function captureTrigger<T>(kind: TriggerSelectionRoleV1): SelectedTriggerCapture<T> | null {
  return selectedTrigger(kind) as SelectedTriggerCapture<T> | null;
}
function triggerRun(id: string) {
  const run = db.getRun(id); if (run) return run;
  const admission = admissions.get(id);
  return admission ? { status: admission.state === 'failed' ? 'failed' as const : 'running' as const } : null;
}
function defaultReviewWorkflow(): string {
  return `${resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: 'review' }).record.binding.providerId}@1`;
}
async function verifyReviewProposal(proposal: ReviewNotificationProposal, trigger: TriggerProvenanceV1): Promise<void> {
  if (trigger.instanceId !== 'slack-review' && trigger.instanceId !== 'github-review') throw new Error('Invalid review trigger instance');
  const source = captureReviewSource(trigger.instanceId, AbortSignal.timeout(30_000));
  if (persistenceHash(source.source) !== persistenceHash(trigger.source)) throw new Error('Recorded review source changed');
  const target = await source.detail({ repo: proposal.repo, number: proposal.number });
  source.assertCurrent();
  if (!target || target.headSha !== proposal.headSha || target.status !== 'open' || target.draft) throw new Error('Recorded PR target changed');
  resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: 'review', providerId: proposal.workflowRef });
}
function scheduleTriggerPoll(kind: TriggerSelectionRoleV1, poll: () => Promise<unknown>, fallback: number): void {
  let interval = fallback;
  try { const selected = selectedTrigger(kind); if (selected?.record.metadata.kind !== 'webhook') interval = selected?.record.metadata.intervalMs ?? fallback; } catch {}
  setTimeout(() => { void poll().finally(() => scheduleTriggerPoll(kind, poll, fallback)); }, interval);
}
function triggerEnabled(kind: TriggerSelectionRoleV1): boolean {
  try { return selectedTrigger(kind) !== null; } catch { return false; }
}
function triggerEnvironment(): Record<string, string | undefined> {
  return { ...configStore.effectiveEnv(), SLACK_WATCH_ENABLED: String(triggerEnabled('slack-review')) };
}
function captureTriggerPullRequest(signal: AbortSignal) {
  const binding = selectedPullRequestProvider();
  if (!binding) throw new Error('Selected pull request source is unavailable');
  const read = pullRequestReadContext(binding, signal); const registration = pullRequestRegistration(binding, 'admission');
  const repos = [...applicationRepos()].map(repo => repo.toLowerCase()).sort();
  return { binding, repos, provider: registration.provider, context: read.context, artifacts: providerArtifacts(binding), settings: registration.settings ?? {},
    revision: persistenceHash({ binding, settings: registration.settings ?? {} }),
    assertCurrent() { signal.throwIfAborted(); read.assertCurrent(); if (pullRequestRegistration(binding, 'admission') !== registration
      || persistenceHash(repos) !== persistenceHash([...applicationRepos()].map(repo => repo.toLowerCase()).sort())) throw new Error('Pull request source changed'); } };
}
function captureReviewSource(role: 'slack-review' | 'github-review', signal: AbortSignal, pullRequest = captureTriggerPullRequest(signal)) {
  const communication = role === 'slack-review' ? communicationRuntime.captureScan() : undefined;
  return captureTriggerReviewSource({ role, signal, repos: applicationRepos, pullRequest,
    ...(communication ? { communication: { ...communication, messages: (input: { since: string | null }) => communicationRuntime.scan(input, signal) } } : {}) });
}
function assertPullRequestAdmission(): void {
  const binding = selectedPullRequestProvider();
  if (!binding) throw new Error('Selected pull request provider is unavailable.');
  pullRequestRegistration(binding, 'admission');
}
const pullRequestProviderEffects = createPullRequestProviderEffects({
  registry: backendPlugins.pullRequests,
  selected: selectedPullRequestProvider,
  artifacts: providerArtifacts,
  verifyArtifacts: verifyEffectArtifacts,
  http: (binding, signal, mutation) => pullRequestContext(binding, signal, mutation).http,
  authorize: async (binding, operation, context) => {
    const live = operations.get(operation.id);
    if (!live || live.contentHash !== operation.contentHash || live.generation !== context.generation || live.status !== 'leased'
      || !live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= Date.now()) return { allowed: false as const, reason: 'The pull request review operation lease is no longer current.' };
    try { pullRequestContext(binding, new AbortController().signal, true); return { allowed: true as const }; }
    catch (error) { return { allowed: false as const, reason: error instanceof Error ? error.message : 'Pinned GitHub pull request connection is unavailable.' }; }
  },
  assertAdmission: assertPullRequestAdmission,
});
const feedbackSnapshot = createFeedbackSnapshotService({
  resolve: clarificationBinding,
  task(runId) {
    const row = db.getRun(runId);
    if (!row?.taskJson) throw new Error('Feedback task is unavailable');
    const task = JSON.parse(row.taskJson) as AgentTask;
    verifyPullRequestExecution(task, executionSnapshot(row));
    verifyWorkflowExecution(task, executionSnapshot(row));
    return task;
  },
  async source(record, signal) {
    await verifyEffectArtifacts(record.artifacts);
    const registration = pullRequestRegistration(record.binding, 'obligation');
    if (persistenceHash(registration.settings ?? {}) !== persistenceHash(record.settings)) throw new Error('Retained PR source settings changed');
    return { provider: registration.provider, context: pullRequestContext(record.binding, signal, false) };
  },
});
const pullRequestInspect = createPullRequestInspectService({ repos: applicationRepos, provider: {
  async detail(query, signal) {
    const binding = selectedPullRequestProvider();
    if (!binding) throw new Error('Selected pull request provider is unavailable.');
    const read = pullRequestReadContext(binding, signal);
    const result = await pullRequestRegistration(binding, 'admission').provider.detail(query, read.context);
    read.assertCurrent(); return result;
  },
  async diff(query, signal) {
    const binding = selectedPullRequestProvider();
    if (!binding) throw new Error('Selected pull request provider is unavailable.');
    const read = pullRequestReadContext(binding, signal);
    const result = await pullRequestRegistration(binding, 'admission').provider.diff(query, read.context);
    read.assertCurrent(); return result;
  },
} });
const pullRequestRead = createPullRequestReadService({ repos: applicationRepos, async read(query, repos, signal) {
  const binding = selectedPullRequestProvider();
  if (!binding) throw new Error('Selected pull request provider is unavailable.');
  const read = pullRequestReadContext(binding, signal);
  const result = await pullRequestRegistration(binding, 'admission').provider.list({ query, repos }, read.context);
  read.assertCurrent(); return result;
} });
const profile = createProfileService({
  authorize: caller => { if (!profileContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden'); },
  async read(signal) {
    const binding = selectedPullRequestProvider();
    if (!binding) return { displayName: null, login: null };
    const provider = pullRequestRegistration(binding, 'admission').provider;
    if (!provider.profile) return { displayName: null, login: null };
    const read = pullRequestReadContext(binding, signal);
    const result = await provider.profile(read.context);
    read.assertCurrent(); return result;
  },
});
const pullRequestCommands = createPullRequestCommandService({ persistence, operations, repos: applicationRepos,
  authorize: caller => {
    if (!pullRequestCommandContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden');
  },
  assertAdmission: assertPullRequestAdmission,
  prepareReview: pullRequestProviderEffects.prepareReview,
  resolve: pullRequestProviderEffects.resolve,
});
const communicationRuntime = createCommunicationRuntime({ root: pluginDirectory(), registry: backendPlugins.communications, operations,
  nativeTerminals: backendPlugins.nativeTerminals, defaultBrowserProviderId: 'helmsman.terminal-cmux/cmux',
  browserRuntime: { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot) },
  env: triggerEnvironment, artifacts: providerArtifacts, verifyArtifacts: verifyEffectArtifacts, assertReviewable: assertCommunicationReviewable });
async function assertCommunicationReviewable(repo: string, number: number, source?: unknown): Promise<void> {
  if (source !== undefined) {
    const retained = parsePullRequestSource(source);
    if (retained.target.repo !== repo || retained.target.number !== number) throw new Error('Retained PR source target changed');
    const registration = pullRequestRegistration(retained.binding, 'obligation');
    const signal = AbortSignal.timeout(30_000);
    const context = pullRequestContext(retained.binding, signal, false);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (pullRequestRegistration(retained.binding, 'obligation') !== registration
        || persistenceHash(registration.settings ?? {}) !== persistenceHash(retained.settings)) throw new Error('Retained PR source settings changed');
    };
    await verifyEffectArtifacts(retained.artifacts);
    await prepareCommunicationReview({ repo, number }, { ...retained, provider: registration.provider, context, assertCurrent });
    return;
  }
  const github = configStore.current().github;
  const pr = github ? await fetchPrStatus(github, repo, number) : null;
  if (!pr || pr.isOwnPr !== true || pr.state !== 'open' || pr.merged) throw new ClarificationServiceError(409, 'conflict');
}
function selectedFeedbackTrackerProvider(): ProviderBinding | null {
  return resolveSelectedFeedbackTrackerProvider({ root: pluginDirectory(), registry: backendPlugins.feedbackTrackers, connection: pullRequestConnection });
}
function authorizeFeedback(caller: string, capability: string) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    const catalog = pluginSnapshot.catalog; const [pluginId, localId] = caller.split('/');
    const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
      ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
    const contribution = manifest?.pages.find(page => page.id === localId)
      ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
    if (catalog.safeMode || !contribution?.requires?.some(requirement => requirement.id === capability && requirement.version === 1)) throw new ClarificationServiceError(403, 'forbidden');
}
const feedbackSettingsPackages = () => [...builtinFeedbackTrackers.map(value => value.package), ...pluginSnapshot.catalog.plugins.map(value => value.package).filter(pkg => pkg.backend?.feedbackTrackers)];
const feedbackSettings = {
  snapshot(caller: string) { authorizeFeedback(caller, 'helmsman/feedback-settings'); return readFeedbackSettings(pluginDirectory(), feedbackSettingsPackages()); },
  save(caller: string, input: unknown) { authorizeFeedback(caller, 'helmsman/feedback-settings'); return writeFeedbackSettings(pluginDirectory(), feedbackSettingsPackages(), input); },
};
const feedbackCommands = createFeedbackCommandService({ persistence, operations, repos: applicationRepos,
  authorize: caller => authorizeFeedback(caller, 'helmsman/feedback-command'),
  capture() {
    const binding = selectedFeedbackTrackerProvider(); if (!binding) return null;
    const key = { providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
    const registration = backendPlugins.feedbackTrackers.resolve(key, 'admission'); const settings = registration.settings ?? {};
    return { binding, artifacts: providerArtifacts(binding), settings, provider: registration.provider, assertCurrent() {
      if (!samePullRequestBinding(binding, selectedFeedbackTrackerProvider()) || backendPlugins.feedbackTrackers.resolve(key, 'admission') !== registration) throw new Error('Feedback tracker selection changed');
    } };
  },
  async verifyArtifacts(artifacts) {
    for (const artifact of artifacts) {
      if (artifact.pluginId.startsWith('helmsman.')) { if (!await verifyLegacyRuntime(runtimeArtifactsRoot, artifact.artifactHash)) throw new Error('Retained feedback runtime is unavailable'); }
      else { const archive = await readPluginArtifact(pluginDirectory(), artifact.artifactHash); if (archive.package.manifest.id !== artifact.pluginId || archive.package.manifest.version !== artifact.packageVersion) throw new Error('Retained feedback artifact is unavailable'); }
    }
  },
  http: (binding, signal, mutation) => feedbackTrackerContext(binding, signal, mutation).http,
  retained: (operation, settings, signal) => loadRetainedFeedbackTrackerProvider({ pluginsRoot: pluginDirectory(), runtimeArtifactsRoot, artifacts: operation.artifacts, signal,
    record: { origin: operation.binding.pluginId.startsWith('helmsman.') ? 'builtin' : 'plugin', settings,
      binding: { providerId: operation.binding.contributionId, pluginId: operation.binding.pluginId, artifactHash: operation.binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null } } }),
  async authorizeDelivery(operation, context) {
    const live = operations.get(operation.id);
    if (!live || live.contentHash !== operation.contentHash || live.generation !== context.generation || live.status !== 'leased'
      || !live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= Date.now()) return { allowed: false, reason: 'The feedback operation lease is no longer current.' };
    try { feedbackTrackerContext(operation.binding, context.signal, false); return { allowed: true }; }
    catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : 'Pinned feedback connection is unavailable.' }; }
  },
});
const communicationCommands = createCommunicationCommandService({ persistence, operations, repos: applicationRepos,
  authorize: caller => {
    if (!communicationContributionEnabled(pluginSnapshot.catalog, caller, true)) throw new ClarificationServiceError(403, 'forbidden');
  },
  assertAdmission: communicationRuntime.assertAdmission,
  async assertReviewable(repo, number) {
    const recent = persistence.sql.prepare(`SELECT requestId FROM slack_review_requests WHERE repo = ? COLLATE NOCASE AND prNumber = ?
      AND createdAt > ? AND status IN ('pending', 'sent', 'uncertain') LIMIT 1`).get(repo, number, Date.now() - 60_000);
    if (recent) throw new ClarificationServiceError(409, 'conflict');
  },
  async prepareReviewRequest(input, signal = AbortSignal.timeout(COMMUNICATION_TIMEOUT_MS)) {
    const source = captureTriggerPullRequest(signal);
    const retained = await prepareCommunicationReview(input, source);
    const prepared = await communicationRuntime.effects.prepareReviewRequest(input, signal);
    source.assertCurrent();
    return { ...prepared, artifacts: mergeExecutionArtifacts(prepared.artifacts, retained.artifacts),
      target: { ...prepared.target, pullRequestSource: retained }, assertCurrent: () => source.assertCurrent() };
  },
  resolve: communicationRuntime.effects.resolve,
});
const communication = createCommunicationReadService({ persistence, repos: applicationRepos,
  authorize: caller => {
    if (!communicationContributionEnabled(pluginSnapshot.catalog, caller)) throw new ClarificationServiceError(403, 'forbidden');
  },
  snapshot: slackSnapshot,
  notificationHistory,
  markRead: (id, now) => id.startsWith('voyage-') ? voyageNotifications.markRead(id, now) : slackStore.markRead(id, now),
  values: () => {
    const env = configStore.effectiveEnv(); const browser = slackSettings(env); const review = slackReviewSettings(env);
    return { enabled: review.enabled, watchEnabled: triggerEnabled('slack-review'), clientId: browser.clientId,
      channelId: browser.channelId, channelName: browser.channelName, browserSurface: browser.surface ?? '',
      reviewChannel: review.channel, reviewMention: review.mention };
  },
  destination: communicationRuntime.destination,
  write: values => {
    if (values.watchEnabled !== triggerEnabled('slack-review')) throw new Error('Configure the selected Slack review trigger to change automatic reviews.');
    const mapping = { SLACK_ENABLED: String(values.enabled),
      SLACK_CLIENT_ID: values.clientId, SLACK_CHANNEL_ID: values.channelId, SLACK_CHANNEL_NAME: values.channelName,
      SLACK_BROWSER_SURFACE: values.browserSurface, SLACK_REVIEW_CHANNEL: values.reviewChannel, SLACK_REVIEW_MENTION: values.reviewMention };
    for (const [key, value] of Object.entries(mapping)) configStore.setOverride(key, value, () => new Date().toISOString());
  },
});
const runEffects = new Map<string, LegacyRunEffects>();
function effectsFor(runId: string): LegacyRunEffects {
  const existing = runEffects.get(runId);
  if (existing) return existing;
  const effects = createLegacyRunEffects({ persistence, runId, operations, executions, getRun: id => db.getRun(id),
    currentConfig: () => loadConfig({ ...configStore.effectiveEnv(), JIRA_ENABLED: 'true' }),
    verifyArtifacts: verifyEffectArtifacts,
    createdReviews: { enqueue: input => createdPrReviews.enqueue(input), find: input => createdPrReviews.find(input) },
    authorize: async operation => {
      const run = operation.origin.runId ? db.getRun(operation.origin.runId) : null;
      const authorization = authorizeRunEffect(operation, run);
      if (!authorization.allowed) return authorization;
      if (!run || operation.origin.attempt === null || stopRequested(run.id)) return { allowed: false, reason: 'The originating voyage is unavailable or stopped' };
      clarificationRuntime.poll(run.id, operation.origin.attempt, undefined, run.status !== 'running');
      return clarificationRuntime.hasUnanswered(run.id, operation.origin.attempt) ? { allowed: false, reason: 'A required clarification remains unanswered' } : { allowed: true };
    },
  });
  runEffects.set(runId, effects);
  return effects;
}
function executionSnapshot(row: RunRow) {
  const attempt = executions.attempt({ runId: row.id, attempt: row.attempt });
  const snapshot = attempt && executions.snapshot(attempt.snapshotId);
  if (!snapshot) throw new Error('Retained execution bindings are unavailable');
  if (row.taskJson) {
    const task = JSON.parse(row.taskJson) as AgentTask;
    verifyTriggerExecution(task, snapshot); verifyPullRequestExecution(task, snapshot);
  }
  return snapshot;
}

const runnerShutdown = new AbortController();

function runnerDurability(cfg: AppConfig) {
  return createRunnerDurability({ shutdownSignal: runnerShutdown.signal, persistence, db, executions, admissions, lifecycle, operations, clarificationProtocol: clarifications.protocol, runsDir: RUNS_DIR, maxConcurrency,
    finalize: (row, snapshot) => { taskSourceRuntime.finalize(row); effectsFor(row.id).prepareFinalization(row, snapshot); },
    snapshot: (run, task) => {
      const hostKind = task.executionHost ? 'plugin' as const : retainedLegacyHostKind(run, executionSnapshot(db.getRun(run.id) ?? run));
      const input = { run, task, artifact: currentRuntime.artifact, host: hostKind, config: cfg, executionSchemaMaximum: 2 as const };
      if (!task.source) return legacyExecutionSnapshot(input);
      const claim = sourceStore.claim(task.source.claimId);
      const source = sourceStore.taskSnapshot(task.source.taskSnapshotHash);
      if (!claim || !source) throw new Error('Source execution bindings are unavailable');
      return sourceExecutionSnapshot({ ...input, claim, source, sourceArtifacts: taskSourceRuntime.sourceArtifacts(claim) });
    },
    verify: async snapshot => {
      const runtime = snapshot.artifacts.find(artifact => artifact.pluginId === currentRuntime.artifact.pluginId);
      if (!runtime || runtime.artifactHash !== currentRuntime.artifact.artifactHash
        || !await verifyLegacyRuntime(runtimeArtifactsRoot, runtime.artifactHash)) throw new Error('Restore the exact retained runtime before recovering this voyage');
      const savedRun = db.getRun(snapshot.runId);
      if (!savedRun?.taskJson || persistenceHash(nonsecretExecutionTask(JSON.parse(savedRun.taskJson) as AgentTask)) !== persistenceHash(snapshot.task)) throw new Error('Saved task differs from the immutable execution snapshot');
      const savedTask = JSON.parse(savedRun.taskJson) as AgentTask;
      if (executionOwnership && savedRun.worktreePath && !savedTask.hostIsolation) {
        const checkout = describeLocalCheckout(AGENTS_ROOT, savedRun.repo, savedRun.id);
        const receipt = executionWorkspaceReceipts.get(savedRun.id, savedRun.worktreePath);
        if (!receipt) throw new Error('Retained workspace has no allocation identity');
        await assertManagedWorktreeIdentity(checkout.path, savedRun.worktreePath, receipt as ManagedWorktreeIdentity);
      }
      if (savedTask.executionHost) verifyHostExecution(savedTask, snapshot);
      else retainedLegacyHostKind(savedRun, snapshot);
      await verifyEffectArtifacts(snapshot.artifacts);
      verifyAgentExecution(savedTask, snapshot);
      verifyWorkflowExecution(savedTask, snapshot);
      verifyPullRequestExecution(savedTask, snapshot);
      const expected = snapshot.bindings.some(binding => binding.capability === 'helmsman/task-source') ? sourceExecutionSettings(cfg, snapshot.settings.agents !== undefined, snapshot.settings.workflow !== undefined) : legacyExecutionSettings(cfg, snapshot.settings.agents !== undefined, snapshot.settings.workflow !== undefined);
      if (persistenceHash(snapshot.settings.execution) !== persistenceHash(expected)) throw new Error('Execution settings or connection identity changed; restore the retained binding before recovery');
      if (snapshot.workflowSnapshotId && !workflows.resolveSnapshot(snapshot.workflowSnapshotId)) throw new Error('Retained workflow snapshot is unavailable');
    },
  });
}

async function guardedWorkspace(repo: string, runId: string, mode: 'coding' | 'branch' | 'review', resource: string | number | undefined,
  create: () => Promise<{ path: string; branch: string }>): Promise<{ path: string; branch: string }> {
  const checkout = describeLocalCheckout(AGENTS_ROOT, repo, runId);
  return withWorktreeMaintenance(checkout.path, async () => {
    if (executionOwnership) {
      const owner = executionOwnership.get(runId);
      if (owner?.state !== 'held' || owner.footprint.repo !== repo.toLowerCase()) throw new Error('Execution workspace has no current ownership');
      if (owner.footprint.checkout && (owner.footprint.checkout.path !== checkout.path || owner.footprint.checkout.commonDirectory !== checkout.commonDirectory)) throw new Error('Execution checkout differs from admission');
      if (owner.footprint.completeness === 'verified') {
        const kind = mode === 'review' ? 'pull-request' : 'branch';
        const identity = mode === 'review' ? String(resource) : `refs/heads/${mode === 'coding' ? `agent/${runId}` : resource}`;
        if (!owner.footprint.resources.some(item => item.kind === kind && item.identity === identity)) throw new Error('Execution workspace resource differs from admission');
      }
    }
    const created = await create();
    if (executionWorkspaceReceipts) {
      if (created.path === checkout.workspacePath) executionWorkspaceReceipts.record(runId, created.path, await captureManagedWorktreeIdentity(checkout.path, created.path));
      else {
        const info = await lstat(created.path, { bigint: true });
        if (info.isSymbolicLink() || await realpath(created.path) !== join(await realpath(DOCKER_WORKSPACES), runId)) throw new Error('Isolated allocation identity differs from the owned run');
        executionWorkspaceReceipts.record(runId, created.path, { kind: 'isolated', path: created.path, canonicalPath: await realpath(created.path), dev: info.dev.toString(), ino: info.ino.toString(), birthtime: info.birthtimeNs.toString() });
      }
    }
    if (executionOwnership?.get(runId)?.footprint.completeness === 'verified' && created.path !== checkout.workspacePath) throw new Error('Execution workspace allocation differs from admission');
    return created;
  });
}
async function detachOwnedWorkspace(runId: string, repo: string, path: string, detach: () => Promise<void>): Promise<void> {
  const owner = executionOwnership?.get(runId);
  if (!executionOwnership || !owner || owner.state === 'released') { await detach(); return; }
  const checkout = describeLocalCheckout(AGENTS_ROOT, repo, runId);
  if (path !== checkout.workspacePath) throw new Error('Detached workspace differs from the owned run');
  const eligible = () => executions.cleanupEligibility(runId).allowed;
  const token = executionOwnership.beginCleanup(runId, eligible);
  await withWorktreeMaintenance(checkout.path, async () => {
    const current = executionOwnership.get(runId);
    if (current?.cleanupToken !== token || !eligible()) throw new Error('Detached execution owner changed');
    try { await lstat(join(resolve(DOCKER_WORKSPACES), runId)); throw new Error('Isolated allocation must be reconciled before branch release'); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    const receipt = executionWorkspaceReceipts?.get(runId, path);
    if (!receipt) throw new Error('Retained workspace requires allocation identity reconciliation before detachment');
    await assertManagedWorktreeIdentity(checkout.path, path, receipt as ManagedWorktreeIdentity);
    await detach();
    await assertManagedWorktreeIdentity(checkout.path, path, receipt as ManagedWorktreeIdentity);
    if (!await verifyWorktreeDetached(checkout.path, path)) throw new Error('Worktree detachment was not confirmed');
    executionOwnership.completeDetach(runId, token, { version: 1, runId, repo: repo.toLowerCase(), completeness: 'verified',
      checkout: { path: checkout.path, commonDirectory: checkout.commonDirectory }, resources: [{ kind: 'workspace', namespace: 'filesystem', identity: path }] }, eligible);
  });
}
async function cleanupWorkspace(runId: string, repo: string, path: string, remove: () => Promise<void>): Promise<void> {
  if (!executionCleanup || !executionOwnership?.get(runId)) { await remove(); return; }
  const checkout = describeLocalCheckout(AGENTS_ROOT, repo, runId);
  const isolatedPath = join(resolve(DOCKER_WORKSPACES), runId);
  if (path !== checkout.workspacePath && path !== isolatedPath) throw new Error('Cleanup path differs from the owned run workspace');
  await executionCleanup.remove({ runId, repoDirectory: checkout.path, commonDirectory: checkout.commonDirectory, workspace: checkout.workspacePath,
    remove: async () => {
      if (path === isolatedPath) {
        const receipt = executionWorkspaceReceipts?.get(runId, path) as { kind?: string; path?: string; canonicalPath?: string; dev?: string; ino?: string; birthtime?: string } | null;
        const present = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; });
        if (present && (!receipt || receipt.kind !== 'isolated' || receipt.path !== path || receipt.canonicalPath !== await realpath(path) || receipt.dev !== present.dev.toString() || receipt.ino !== present.ino.toString() || receipt.birthtime !== present.birthtimeNs.toString() || present.isSymbolicLink())) throw new Error('Isolated workspace allocation changed before cleanup');
        await remove();
        try { await lstat(isolatedPath); throw new Error('Isolated workspace remains present'); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      } else if (!await verifyWorktreeAbsent(checkout.path, path)) {
        const receipt = executionWorkspaceReceipts?.get(runId, path);
        if (!receipt) throw new Error('Execution workspace has no retained allocation identity');
        await assertManagedWorktreeIdentity(checkout.path, path, receipt as ManagedWorktreeIdentity);
        await remove();
      }
      if (path !== isolatedPath) {
        try { await lstat(isolatedPath); throw new Error('Unreconciled isolated allocation retains execution ownership'); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      }
    } });
}

function baseRunnerDeps(cfg: AppConfig, runId: string, context: RunHostContext): Omit<RunnerDeps, 'adapter' | 'genId' | 'onLaunch' | 'isStopped'> {
  return {
    db,
    durable: runnerDurability(cfg),
    bus,
    host: context.host,
    runsDir: RUNS_DIR,
    recordAgentEvent: runTelemetry.record,
    pollClarifications: (runId, attempt, terminal) => clarificationRuntime.poll(runId, attempt, undefined, terminal),
    hasRequiredUnanswered: clarificationRuntime.hasUnanswered,
    onRunComplete: run => {
      try { runTelemetry.complete(run); clarificationRuntime.complete(run.id, run.attempt); }
      finally { gateway.revokeRun(run.id); if (context.isolated && context.host.kind !== 'plugin') void stopLegacyDockerStages(run.id); }
    },
    createWorktree: (repo: string, id: string) => guardedWorkspace(repo, id, 'coding', undefined, () => standaloneWorkspace(context, repo, id, 'fresh', () => createWorktree(AGENTS_ROOT, repo, id))),
    createWorktreeFromBranch: (repo: string, id: string, branch: string, expectedHeadSha?: string) => guardedWorkspace(repo, id, 'branch', branch, () => standaloneWorkspace(context, repo, id, 'branch', () => createWorktreeFromBranch(AGENTS_ROOT, repo, id, branch, expectedHeadSha, db.getRun(id)?.attempt ?? 1))),
    createReviewWorktree: (repo, id, number, headSha) => guardedWorkspace(repo, id, 'review', number, () => standaloneWorkspace(context, repo, id, 'review', () => createReviewWorktree(AGENTS_ROOT, repo, id, number, headSha, db.getRun(id)?.attempt ?? 1), headSha)),
    removeWorktree: (repo: string, path: string) => cleanupWorkspace(runId, repo, path, () => path.startsWith(`${DOCKER_WORKSPACES}${sep}`) ? removeDockerWorkspace(DOCKER_WORKSPACES, path) : removeWorktree(AGENTS_ROOT, repo, path)),
    now: () => new Date().toISOString(),
    jira: cfg.jira ? effectsFor(runId).jira : null,
    prepareFinalization: async row => { await taskSourceRuntime.prepareFinalization(row); await effectsFor(runId).prepareFinalizationLookups(row, executionSnapshot(row)); },
    botAccountId: cfg.botAccountId ?? undefined,
    statusInProgress: cfg.statusInProgress,
    statusInReview: cfg.statusInReview,
    findPrNumber: (repo: string, branch: string) =>
      cfg.github ? findPrNumberByBranch(cfg.github, repo, branch) : Promise.resolve(null),
    maxAttempts: cfg.maxAttempts,
    maxCostUsd: cfg.maxCostUsd,
    readReview: worktreePath => readReviewArtifact(worktreePath, '.agent-review.md'),
    readReviewComments: worktreePath => readReviewArtifact(worktreePath, '.agent-review-comments.json'),
    postReview: effectsFor(runId).postReview,
    requestCopilotReview: effectsFor(runId).requestCopilotReview,
    enqueueCreatedPrReview: effectsFor(runId).enqueueCreatedPrReview,
  };
}

function findExistingReview(repo: string, number: number, headSha: string): string | null {
  for (const run of db.listRuns(1000)) {
    if (run.repo.toLowerCase() !== repo.toLowerCase() || run.prNumber !== number || !['running', 'succeeded'].includes(run.status)) continue;
    try {
      const task: unknown = run.taskJson ? JSON.parse(run.taskJson) : null;
      if (task && typeof task === 'object' && 'review' in task && task.review === true && 'prHeadSha' in task && task.prHeadSha === headSha) return run.id;
    } catch { continue; }
  }
  return null;
}

const createdPrReviews = createCreatedPrReviews({
  store: slackStore,
  getRun: (id) => db.getRun(id),
  isRunActive: (id) => pm.hasRun(id),
  canLaunch: (repo) => Boolean(configStore.current().github) && pm.canStart(repo).ok,
  fetchPr: (repo, number) => {
    const github = configStore.current().github;
    return github ? fetchReviewHead(github, repo, number) : Promise.resolve(null);
  },
  findExistingReview,
  launch,
});

let drainingEffects: Promise<void> | null = null;
function drainEffects(): Promise<void> {
  drainingEffects ??= (async () => {
    const runIds = new Set(operations.list({ statuses: ['pending', 'leased', 'retrying', 'blocked', 'uncertain'] }).flatMap(operation => operation.origin.runId ? [operation.origin.runId] : []));
    for (const runId of runIds) await effectsFor(runId).drainPending(runId);
    await publicationService.drainPending();
    await slackEffects.drainPending();
    await manualReviewEffects.drainPending();
    await pullRequestCommands.drainPending();
    if (slackIntegrationEnabled(triggerEnvironment())) {
      try { await communicationRuntime.refreshConnection(AbortSignal.timeout(30_000)); } catch {}
    }
    await communicationCommands.drainPending();
    await feedbackCommands.drainPending();
    await taskSourceRuntime.drain();
  })().catch(error => { process.stderr.write(`Operation recovery failed: ${String(error)}\n`); }).finally(() => { drainingEffects = null; });
  return drainingEffects;
}
const effectTimer = setInterval(() => { void drainEffects(); }, 10_000);
effectTimer.unref();
void drainEffects();

function pollCreatedPrReviews(): Promise<void> {
  return createdPrReviews.poll().catch((error: unknown) => { process.stderr.write(`Created PR review queue failed: ${String(error)}\n`); });
}

async function retainedRunAgents(row: RunRow) {
  const task = row.taskJson ? JSON.parse(row.taskJson) as AgentTask : null;
  if (!task?.agentSelection) return null;
  const snapshot = executionSnapshot(row);
  if (persistenceHash(nonsecretExecutionTask(task)) !== persistenceHash(snapshot.task)) throw new Error('Saved task differs from its immutable execution snapshot');
  verifyAgentExecution(task, snapshot);
  verifyWorkflowExecution(task, snapshot);
  return loadExecutionAgents({ ...task, agentRuntime: { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot), artifacts: snapshot.artifacts } });
}

async function dispatchReattach(row: RunRow, control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null }): Promise<AttachmentHandshake> {
  const cfg = executions.attempt({ runId: row.id, attempt: row.attempt })
    ? restoreExecutionConfig(executionSnapshot(row), loadConfig({ ...configStore.effectiveEnv(), JIRA_ENABLED: 'true' })) : configStore.current();
  const retained = await retainedRunAgents(row);
  let hosting: Awaited<ReturnType<typeof retainedRunHost>>;
  try { hosting = await retainedRunHost(row); } catch (error) { await retained?.dispose(); throw error; }
  let adapter: AgentAdapter;
  try { adapter = restoreRunAdapter(row, { retained: retained?.writer, runsDir: RUNS_DIR, agentCmd: cfg.agentCmd, reviewSettings: cfg.prePr, publication: isPrePrAdapter(row.adapter) ? publicationConnection(row.id) : undefined }); }
  catch (error) { await retained?.dispose(); await hosting.dispose(); throw error; }
  pm.add(row.id, row.repo, () => {
    recordStopRequest(row.id);
    control.stopped = true;
    void control.stop?.();
  });
  const deps: RunnerDeps = {
    ...baseRunnerDeps(cfg, row.id, hosting.context),
    adapter,
    preserveWorktreeOnFailure: isPrePrAdapter(row.adapter) || isFeedbackUpdateAdapter(row.adapter),
    genId: () => row.id,
    onLaunch: (_runId: string, stop: () => Promise<void>) => {
      control.stop = stop;
      if (control.stopped) void stop();
    },
    isStopped: () => control.stopped || stopRequested(row.id),
  };
  let result: Awaited<ReturnType<typeof reattachRun>>;
  try { result = await reattachRun(row, deps); } catch (error) { await retained?.dispose(); await hosting.dispose(); pm.remove(row.id); throw error; }
  if (!result) { await retained?.dispose(); await hosting.dispose(); pm.remove(row.id); return { status: 'blocked', reason: 'Worker ownership needs verified recovery' }; }
  if (result.status !== 'attached') { await retained?.dispose(); await hosting.dispose(); pm.remove(row.id); return result; }
  return { ...result, completion: result.completion.finally(async () => {
    await retained?.dispose();
    await hosting.dispose();
    const status = db.getRun(row.id)?.status;
    if (status && status !== 'running' && !taskSourceRuntime.claimForRun(row.id)) todos.finishRun(row.id, status);
    pm.remove(row.id);
    void drainEffects().then(pollCreatedPrReviews);
  }) };
}

async function resumeVoyage(runId: string): Promise<void> {
  const row = db.getRun(runId);
  if (!row) throw new ResumeError('Voyage not found.');
  const sourceClaim = taskSourceRuntime.claimForRun(runId);
  if (sourceClaim && (sourceClaim.state !== 'claimed' || !sourceClaim.receipt || !sourceClaim.taskSnapshotHash)) throw new ResumeError('The retained task source claim is no longer available for continuation.');
  if (operations.list({ runId }).some(operation => operation.status !== 'completed')) throw new ResumeError('Reconcile the previous attempt’s external operations before continuing.');
  const cfg = restoreExecutionConfig(executionSnapshot(row), loadConfig({ ...configStore.effectiveEnv(), JIRA_ENABLED: 'true' }));
  const repos = applicationRepos(cfg);
  if (!repos.some(repo => repo.toLowerCase() === row.repo.toLowerCase())) throw new ResumeError('Configure this galleon before continuing the voyage.');
  const gate = pm.canStart(row.repo);
  if (!gate.ok) throw new ResumeError(gate.reason ?? 'Cannot continue this voyage while another voyage is active.');
  if (cfg.maxCostUsd !== null && (row.costUsd ?? 0) >= cfg.maxCostUsd) throw new ResumeError('The voyage has reached its cost cap. Update the cap before continuing.');
  const task = row.taskJson ? JSON.parse(row.taskJson) as Partial<AgentTask> | null : null;
  if (sourceClaim && (!task?.source || task.source.claimId !== sourceClaim.id || task.source.taskSnapshotHash !== sourceClaim.taskSnapshotHash
    || task.source.instanceId !== sourceClaim.instance.id)) throw new ResumeError('The saved task no longer matches its retained source claim.');
  if (!task?.task && !task?.todoId && !cfg.jira) throw new ResumeError('Configure Jira before continuing this Jira voyage.');
  if (executionOwnership && row.worktreePath && !task?.hostIsolation) {
    const checkout = describeLocalCheckout(AGENTS_ROOT, row.repo, row.id);
    const receipt = executionWorkspaceReceipts.get(row.id, row.worktreePath);
    if (!receipt) throw new ResumeError('Retained workspace has no allocation identity');
    await assertManagedWorktreeIdentity(checkout.path, row.worktreePath, receipt as ManagedWorktreeIdentity);
  }
  const retained = await retainedRunAgents(row);
  await retained?.dispose();
  const hosting = await retainedRunHost(row);
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  pm.add(row.id, row.repo, () => { recordStopRequest(row.id); control.stopped = true; void control.stop?.(); });
  try {
    const resumed = await resumeFailedPrePrRun(row, { db, durable: runnerDurability(cfg), host: hosting.context.host,
      runsDir: RUNS_DIR, publication: publicationConnection(runId), now: () => new Date().toISOString(), isStopped: () => control.stopped,
      prepareTask: async task => {
        goCaas.assertReady();
        if (task.agentSelection && [task.agentSelection.writer, ...task.agentSelection.reviewers].some(record => !record.metadata.docker)) {
          throw new ResumeError('Retained agent must declare a supported transport for GoCaaS routing.');
        }
        task.modelGateway = { url: `http://127.0.0.1:${gatewayPort}`, token: gateway.issue(runId, 86_400_000).token };
        task.clarification = createClarificationChannel(RUNS_DIR, { runId, attempt: row.attempt + 1, gateUrl: `http://127.0.0.1:${PORT}/api/runs/${runId}/clarification-gate` });
        task.instructions = { directory: instructionDirectory(RUNS_DIR, runId, task.clarification.attempt!, task.clarification.channelId!), runId, attempt: task.clarification.attempt!, channelId: task.clarification.channelId! };
        const prepared = await prepareExecution({ runId, runsDir: RUNS_DIR, workflowDbPath: dbPath, store: workflows, task, provider: row.adapter.replace(/^(?:pre-pr|feedback):/, ''), workflow: 'coding', reviewSettings: cfg.prePr, model: task.model, effort: task.effort, allowPromptUpgrade: true });
        if (prepared.task.hostIsolation) {
          if (!hosting.context.isolated) throw new ResumeError('The retained host cannot continue an isolated voyage.');
          prepared.task.hostIsolation = { ...prepared.task.hostIsolation, capability: gateway.issue(runId, 86_400_000).token };
        }
        if (prepared.task.dockerExecution) {
          if (!hosting.context.isolated) throw new ResumeError('The retained host cannot continue an isolated voyage.');
          prepared.task.dockerExecution = { ...prepared.task.dockerExecution, capability: gateway.issue(runId, 86_400_000).token };
        }
        return prepared.task;
      } });
    void dispatchReattach(resumed, control).catch(error => { process.stderr.write(`Voyage continuation failed: ${String(error)}\n`); });
  } catch (error) {
    pm.remove(row.id);
    throw error;
  } finally { await hosting.dispose(); }
}

const reattachIds: string[] = db.reattachableRuns().map((r: RunRow) => r.id);

for (const owner of executionOwnership?.held() ?? []) {
  const { runId, repo } = owner.footprint;
  if (!executions.cleanupEligibility(runId).allowed) continue;
  try {
    const checkout = describeLocalCheckout(AGENTS_ROOT, repo, runId);
    const row = db.getRun(runId);
    if (row?.worktreePath && row.worktreePath !== checkout.workspacePath) continue;
    if (!await verifyWorktreeAbsent(checkout.path, checkout.workspacePath)) {
      if (owner.state === 'cleanup-pending' && await verifyWorktreeDetached(checkout.path, checkout.workspacePath)) {
        await detachOwnedWorkspace(runId, repo, checkout.workspacePath, async () => undefined);
      }
      continue;
    }
    await cleanupWorkspace(runId, repo, checkout.workspacePath, async () => undefined);
  } catch (error) { process.stderr.write(`Execution cleanup reconciliation blocked for ${runId}: ${String(error)}\n`); }
}

try {
  const repos: string[] = [...Object.keys(startupCfg.repoProjectMap), ...(startupCfg.github?.repo ? [startupCfg.github.repo] : [])];
  const configuredDirs: string[] = repos.map((repo: string) => join(AGENTS_ROOT, repoBasename(repo)));
  const discoveredDirs: string[] = await discoverRepoDirs(AGENTS_ROOT);
  const repoDirs: string[] = [...new Set([...configuredDirs, ...discoveredDirs])];
  if (repoDirs.length > 0) {
    const removed: string[] = await sweepOrphanedWorktrees({
      listAgentWorktrees,
      remove: async (repoDirectory, path) => {
        const row = db.listRuns(-1).find(run => run.worktreePath === path);
        if (!row) throw new Error('Worktree has no retained execution owner');
        await cleanupWorkspace(row.id, row.repo, path, () => removeCleanWorktreeAt(repoDirectory, path));
      },
      isActiveRunId: (id: string) => {
        if (pm.hasRun(id) || reattachIds.includes(id) || !executions.cleanupEligibility(id).allowed) return true;
        const row = db.getRun(id);
        return Boolean(row && (isPrePrAdapter(row.adapter) || isFeedbackUpdateAdapter(row.adapter)) && row.status !== 'succeeded');
      },
      isEligibleWorktree: async (repoDir: string, path: string, runId: string): Promise<boolean> => {
        const row = db.getRun(runId);
        if (!row?.worktreePath || !['succeeded', 'failed', 'stopped'].includes(row.status) || !executions.cleanupEligibility(runId).allowed
          || (isPrePrAdapter(row.adapter) || isFeedbackUpdateAdapter(row.adapter)) && row.status !== 'succeeded') return false;
        try {
          const [workspace, recordedWorkspace, galleon, recordedGalleon] = await Promise.all([
            realpath(path), realpath(row.worktreePath), realpath(repoDir), realpath(join(AGENTS_ROOT, repoBasename(row.repo))),
          ]);
          return workspace === recordedWorkspace && galleon === recordedGalleon;
        } catch { return false; }
      },
      repoDirs,
    });
    if (removed.length > 0) process.stdout.write(`swept ${removed.length} orphaned worktree(s)\n`);
  }
} catch (err: unknown) {
  process.stderr.write(`worktree sweep failed: ${String(err)}\n`);
}

const runRecovery = startRunRecovery(db, {
  reattach: (row: RunRow) => dispatchReattach(row),
  recordAttachment: (row, state, reason) => {
    if (state === 'blocked' || state === 'failed') process.stderr.write(`Run ${row.id} recovery ${state}: ${reason}\n`);
  },
  onResult: result => {
    if (result.reattached.length > 0) process.stdout.write(`reattached ${result.reattached.length} run(s)\n`);
  },
  onError: error => process.stderr.write(`run recovery failed: ${String(error)}\n`),
});
void runRecovery.initial.catch(() => {});

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

async function launch(body: LaunchIntent & { runId?: string; headSha?: string; retryOf?: string; workflowRef?: string; trigger?: TriggerProvenanceV1; commandBinding?: RunCommandAdmissionBinding }): Promise<string> {
  const runId: string = body.runId ?? randomUUID();
  if (db.getRun(runId) || pm.hasRun(runId) || admissions.get(runId)) return runId;
  const capacity = pm.canStart(body.repo);
  if (!capacity.ok) throw new Error(capacity.reason ?? 'Cannot launch while another voyage is active');
  const cfg: AppConfig = configStore.current();
  const priorRun = body.retryOf ? db.getRun(body.retryOf) : null;
  const adapterId = priorRun?.adapter.replace(/^(?:pre-pr|feedback):/, '') ?? body.adapter;
  const priorTask = priorRun?.taskJson ? JSON.parse(priorRun.taskJson) as AgentTask | null : null;
  if (priorRun && !priorTask?.agentSelection) throw new RetryError('Legacy agent bindings cannot be migrated by retry. Continue the original retained voyage or start a new voyage.');
  if (priorRun && !priorTask?.executionHost) throw new RetryError('Legacy execution hosts cannot be migrated by retry. Continue the retained voyage or start a new voyage.');
  if (priorRun && !priorTask?.workflow) throw new RetryError('Legacy workflows cannot be migrated by retry. Continue the retained voyage or start a new voyage.');
  const trigger = body.trigger ? parseTriggerProvenanceV1(body.trigger) : priorTask?.trigger ? parseTriggerProvenanceV1(priorTask.trigger) : undefined;
  const pullRequestSource = !priorTask && (body.mode === 'review' || body.mode === 'rerun') ? captureTriggerPullRequest(AbortSignal.timeout(30_000)) : null;
  let preparedPullRequestSource = priorTask?.pullRequestSource;
  if (priorTask && priorRun) verifyPullRequestExecution(priorTask, executionSnapshot(priorRun));
  const recordedPullRequest = trigger?.source.bindings.find(binding => binding.capability === 'helmsman/pull-request');
  if (recordedPullRequest && pullRequestSource && !samePullRequestBinding(recordedPullRequest, pullRequestSource.binding)) throw new Error('Recorded trigger PR source changed');
  const workflowMode: WorkflowModeV1 = body.mode === 'review' ? 'review' : body.mode === 'rerun' ? 'branch' : 'coding';
  const workflowOptions = { root: pluginDirectory(), registry: backendPlugins.workflows };
  const selectedWorkflow = priorTask?.workflow
    ? { record: parseWorkflowRetainedProviderV1(priorTask.workflow), revision: readWorkflowProviderSelection(pluginDirectory(), workflowMode).revision, mode: workflowMode }
    : resolveWorkflowSelection({ ...workflowOptions, mode: workflowMode, ...(body.workflowRef ? { providerId: body.workflowRef } : {}) });
  if (!selectedWorkflow.record.metadata.modes.includes(workflowMode)) throw new Error('Workflow does not support this task mode');
  if (priorTask && priorRun) verifyWorkflowExecution(priorTask, executionSnapshot(priorRun));
  const workflowArtifacts = priorTask?.workflowRuntime?.artifacts ?? providerArtifacts(selectedWorkflow.record.binding);
  const workflowRuntime = { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot), artifacts: workflowArtifacts };
  const selectedExecutionHost = priorTask?.executionHost
    ? { revision: readExecutionHostProviderSelection(pluginDirectory()).revision, record: parseExecutionHostRetainedProviderV1(priorTask.executionHost) }
    : selectExecutionHost();
  assertExecutionHostCoordinatorSupport(selectedExecutionHost.record.metadata, (selectedWorkflow.record.metadata.execution === 'staged' || selectedWorkflow.record.metadata.feedbackCompletion === true)
    || workflowMode === 'review' && selectedExecutionHost.record.metadata.stageExecution === 'isolated');
  if (selectedExecutionHost.record.metadata.stageExecution === 'isolated' && !gatewayAllowsIsolation) throw new Error('Restart Helmsman after selecting an isolated execution host so its scoped gateway is reachable.');
  if (priorTask && priorRun) verifyHostExecution(priorTask, executionSnapshot(priorRun));
  const hostArtifacts = priorTask?.hostRuntime?.artifacts ?? providerArtifacts(selectedExecutionHost.record.binding);
  const hostRuntime = { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot), artifacts: hostArtifacts };
  const agentOptions = { root: pluginDirectory(), registry: backendPlugins.agents };
  const selectedAgents = priorTask?.agentSelection
    ? { selection: parseAgentSelectionV1(priorTask.agentSelection), revision: readAgentProviderSelection(pluginDirectory()).revision }
    : resolveAgentSelection({ ...agentOptions, ...(adapterId ? { writer: canonicalAgentId(adapterId) } : {}),
      reviewerCount: selectedWorkflow.record.metadata.execution === 'direct' && !selectedWorkflow.record.metadata.feedbackCompletion ? 0 : readAgentProviderSelection(pluginDirectory()).reviewers?.length ?? agentDefaults.reviewers.length, defaults: agentDefaults });
  if (priorTask && priorRun) verifyAgentExecution(priorTask, executionSnapshot(priorRun));
  const agentArtifacts = priorTask?.agentRuntime?.artifacts ?? mergeExecutionArtifacts(...[selectedAgents.selection.writer, ...selectedAgents.selection.reviewers].map(record => providerArtifacts(record.binding)));
  const agentRuntime = { pluginsRoot: resolve(pluginDirectory()), runtimeArtifactsRoot: resolve(runtimeArtifactsRoot), artifacts: agentArtifacts };
  for (const record of [selectedAgents.selection.writer, ...selectedAgents.selection.reviewers]) {
    if (!record.metadata.docker) throw new GoCaaSConfigurationError('Selected agent must declare an OpenAI Responses or Anthropic Messages transport for GoCaaS routing.');
  }
  goCaas.assertReady();
  const selectedWriterId = selectedAgents.selection.writer.binding.providerId;
  let sourceSelection = taskSourceRuntime.selection(body, body.retryOf);
  if (sourceSelection && !sourceSelection.ref && sourceSelection.displayKey) {
    const ref = await taskSourceRuntime.service.lookup({ instanceId: sourceSelection.instance.id, instanceRevision: sourceSelection.instance.revision,
      repo: body.repo, displayKey: sourceSelection.displayKey }, AbortSignal.timeout(30_000));
    if (!ref) throw new Error('Task was not found');
    sourceSelection = { ...sourceSelection, ref, displayKey: null };
  }
  if (sourceSelection) body = taskSourceRuntime.canonical(body, sourceSelection);
  let launchJson = launchIntentJson(body);
  let detachedRetry = false;
  if (priorRun && priorTask?.prBranch && isFeedbackUpdateAdapter(priorRun.adapter) && priorRun.worktreePath && existsSync(priorRun.worktreePath)) {
    if (priorRun.status === 'running' || pm.hasRun(priorRun.id) || !executions.cleanupEligibility(priorRun.id).allowed) throw new RetryError('Previous feedback execution is still protected');
    const source = priorTask.pullRequestSource;
    if (!source) throw new RetryError('Retained feedback source is unavailable');
    await verifyEffectArtifacts(source.artifacts);
    const registration = pullRequestRegistration(source.binding, 'obligation');
    if (!registration.provider.feedbackSnapshot || persistenceHash(registration.settings ?? {}) !== persistenceHash(source.settings)) throw new RetryError('Retained feedback source changed');
    const query = { version: 1 as const, repo: body.repo, number: priorTask.prNumber! };
    const feedback = parsePullRequestFeedbackSnapshotV1(await registration.provider.feedbackSnapshot(query, pullRequestContext(source.binding, AbortSignal.timeout(30_000), false)), query);
    if (feedback.state !== 'OPEN' || feedback.headBranch !== priorTask.prBranch || feedback.fingerprint !== await fingerprintPullRequestFeedbackSnapshotV1(feedback)) throw new RetryError('Current feedback branch could not be verified');
    await detachOwnedWorkspace(priorRun.id, body.repo, priorRun.worktreePath, () => detachRetainedFeedbackWorktree(AGENTS_ROOT, body.repo, priorRun.id, priorRun.worktreePath!, priorTask.prBranch!));
    detachedRetry = true;
  }
  if (db.getRun(runId) || pm.hasRun(runId) || admissions.get(runId)) return runId;
  const checkout = describeLocalCheckout(AGENTS_ROOT, body.repo, runId);
  const hostBinding = selectedExecutionHost.record.binding;
  const footprint = localExecutionFootprint({ runId, repo: body.repo, checkout, mode: workflowMode,
    trustedLocalHost: hostBinding.pluginId === 'helmsman.host-local' && hostBinding.artifactHash === currentRuntime.artifact.artifactHash
      && selectedExecutionHost.record.metadata.workspace === 'worktree' && selectedExecutionHost.record.metadata.stageExecution === 'local',
    source: sourceSelection?.ref ?? null, unknownTask: Boolean(sourceSelection && !sourceSelection.ref),
    pullRequestNumber: body.prNumber, retry: Boolean(priorRun) && !detachedRetry, ...(detachedRetry ? { branch: priorTask?.prBranch } : {}) });
  const admissionArtifacts = mergeExecutionArtifacts([currentRuntime.artifact], agentArtifacts, hostArtifacts, workflowArtifacts, trigger?.artifacts ?? [], pullRequestSource?.artifacts ?? priorTask?.pullRequestSource?.artifacts ?? priorTask?.triggerReviewSource?.artifacts ?? [], sourceSelection ? sourceArtifactClosure(sourceSelection.instance) : []);
  persistence.transaction(() => {
    assertAgentSelectionCurrent(agentOptions, selectedAgents);
    assertExecutionHostSelectionCurrent(executionHostOptions, selectedExecutionHost);
    if (!priorTask) assertWorkflowSelectionCurrent(workflowOptions, selectedWorkflow);
    if (body.trigger) {
      const selected = selectedTrigger(body.trigger.instanceId as TriggerSelectionRoleV1);
      if (!selected) throw new Error('Trigger is disabled'); selected.assertCurrent();
      if (body.trigger.instanceId === 'slack-review' || body.trigger.instanceId === 'github-review') {
        const source = captureReviewSource(body.trigger.instanceId, AbortSignal.timeout(30_000));
        if (persistenceHash(source.source) !== persistenceHash(body.trigger.source)) throw new Error('Recorded trigger source changed before admission');
        source.assertCurrent();
      }
    }
    pullRequestSource?.assertCurrent();
    if (persistenceHash(describeLocalCheckout(AGENTS_ROOT, body.repo, runId)) !== persistenceHash(checkout)) throw new Error('Checkout identity changed before admission');
    const scheduling = taskSourceRuntime.schedule.assertAdmission(body);
    const admit = () => { admissions.admit({ runId, repo: body.repo, ...(executionOwnership ? { footprint } : {}), request: persistedJson({ ...JSON.parse(launchJson), agents: selectedAgents.selection, host: selectedExecutionHost.record, workflow: selectedWorkflow.record, ...(scheduling ? { scheduling } : {}), ...(trigger ? { trigger } : {}), ...(pullRequestSource ? { pullRequestSource: { binding: pullRequestSource.binding, revision: pullRequestSource.revision, settings: pullRequestSource.settings } } : preparedPullRequestSource ? { pullRequestSource: preparedPullRequestSource } : {}), ...(body.commandBinding ? { commandBinding: body.commandBinding } : {}) }),
      settings: sourceSelection ? sourceExecutionSettings(cfg, true, true) : legacyExecutionSettings(cfg, true, true), artifacts: admissionArtifacts }, maxConcurrency); };
    if (sourceSelection) taskSourceRuntime.reserve(runId, body.repo, sourceSelection, admit, body.retryOf);
    else admit();
  });
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  const lifetime = createRunLifetime();
  pm.add(runId, body.repo, () => {
    recordStopRequest(runId);
    control.stopped = true;
    lifetime.stop();
    void control.stop?.();
  });
  void (async (): Promise<void> => {
    let loadedAgents: Awaited<ReturnType<typeof loadExecutionAgents>> | undefined;
    let loadedHost: Awaited<ReturnType<typeof loadExecutionHost>> | undefined;
    try {
      loadedAgents = await loadExecutionAgents({ agentSelection: selectedAgents.selection, agentRuntime, workflow: selectedWorkflow.record, workflowRuntime }, lifetime.providerSignal);
      loadedHost = await loadExecutionHost({ executionHost: selectedExecutionHost.record, hostRuntime }, lifetime.providerSignal);
      const hostConfiguration = priorTask?.hostConfiguration !== undefined ? priorTask.hostConfiguration : await loadedHost.provider.prepareRun({ version: 1, runId, repo: body.repo, mode: body.mode === 'review' ? 'review' : body.mode === 'rerun' ? 'branch' : 'coding' });
      const adapter = loadedAgents.writer;
      let taskObj: AgentTask;
      if (sourceSelection) {
        const preparedSource = await taskSourceRuntime.prepare(runId, body.repo, sourceSelection, lifetime.admissionSignal, body.retryOf);
        sourceSelection = preparedSource.selection;
        body = taskSourceRuntime.canonical(body, sourceSelection);
        launchJson = launchIntentJson(body);
        taskObj = preparedSource.task;
      } else if (priorTask) {
        if (priorTask.repo.toLowerCase() !== body.repo.toLowerCase()) throw new RetryError('Saved task belongs to another galleon.');
        taskObj = { ...priorTask, prePrResume: undefined };
      } else if (body.mode === 'rerun') {
        if (!pullRequestSource || !body.prNumber) throw new Error('Selected pull request source is unavailable');
        const pr = await readPullRequestDetail({ repo: body.repo, number: body.prNumber, headSha: body.headSha }, pullRequestSource);
        if (pr.status !== 'open') throw new Error('Pull request is no longer open for rerun');
        preparedPullRequestSource = retainPullRequestSource(pullRequestSource, pr.target);
        taskObj = {
          ticketId: 'rerun', title: `rerun #${pr.target.number}`, repo: body.repo,
          jiraBaseUrl: cfg.jira?.baseUrl ?? '', task: body.feedback ?? '',
          prBranch: pr.headRefName, prNumber: pr.target.number, prHeadSha: pr.target.headSha,
        };
      } else if (body.mode === 'review') {
        if (!pullRequestSource || !body.prNumber) throw new Error('Selected pull request source is unavailable');
        const prepared = await prepareTriggerReview({ repo: body.repo, number: body.prNumber, headSha: body.headSha, allowDraft: !trigger }, pullRequestSource);
        const { pr, scope } = prepared;
        preparedPullRequestSource = retainPullRequestSource(pullRequestSource, prepared.target);
        const choice = selectReviewModel(scope?.headSha === pr.headSha ? scope : null, adapter.metadata ?? adapter.id, body);
        taskObj = {
          ticketId: 'review', title: pr.title, repo: body.repo,
          jiraBaseUrl: cfg.jira?.baseUrl ?? '',
          prBranch: pr.headRefName, prNumber: pr.number, review: true,
          model: choice.model, effort: choice.effort, reviewComplexity: choice.complexity,
          reviewReason: choice.reason, prHeadSha: scope?.headSha ?? pr.headSha,
        };
      } else {
        const ticketId: string = body.ticketId ?? 'freeform';
        taskObj = { ticketId, title: body.title ?? ticketId, repo: body.repo, jiraBaseUrl: cfg.jira?.baseUrl ?? '', task: body.task };
      }
      if (trigger) taskObj.trigger = trigger;
      if (preparedPullRequestSource) taskObj.pullRequestSource = preparedPullRequestSource;
      taskObj.workflow = selectedWorkflow.record;
      taskObj.workflowRuntime = workflowRuntime;
      taskObj.executionHost = selectedExecutionHost.record;
      taskObj.hostRuntime = hostRuntime;
      taskObj.hostConfiguration = hostConfiguration;
      const hosting = boundRunHost(runId, taskObj, loadedHost);
      taskObj.agentSelection = selectedAgents.selection;
      taskObj.agentRuntime = agentRuntime;
      taskObj.model ??= body.model;
      taskObj.effort ??= body.effort;
      if (body.retryOf) {
        const previous = db.getRun(body.retryOf);
        const priorTask = previous?.taskJson ? JSON.parse(previous.taskJson) as Partial<AgentTask> | null : null;
        if (priorTask?.workflowSnapshotId) taskObj.workflowSnapshotId = priorTask.workflowSnapshotId;
      }
      taskObj.modelGateway = { url: `http://127.0.0.1:${gatewayPort}`, token: gateway.issue(runId, 86_400_000).token };
      if (hosting.isolated) {
        if (taskObj.prBranch && !taskObj.review) throw new Error('Docker branch reruns require host publication support; use the trusted local run host for this mode.');
        for (const record of [selectedAgents.selection.writer, ...selectedAgents.selection.reviewers]) {
          const transport = record.metadata.docker;
          if (!transport) throw new Error('Selected agent does not support Docker execution');
        }
        const capability = gateway.issue(runId, 86_400_000);
        taskObj.hostIsolation = { gatewayUrl, capability: capability.token, runId };
        taskObj.dockerExecution = undefined;
      }
      if (selectedWorkflow.record.metadata.feedbackCompletion === true) {
        if (!taskObj.pullRequestSource || !pullRequestRegistration(taskObj.pullRequestSource.binding, 'obligation').provider.feedbackSnapshot) {
          throw new Error('Retained PR source does not provide complete feedback snapshots');
        }
        if (priorRun) {
          const source = taskObj.pullRequestSource;
          await verifyEffectArtifacts(source.artifacts);
          const registration = pullRequestRegistration(source.binding, 'obligation');
          if (persistenceHash(registration.settings ?? {}) !== persistenceHash(source.settings)) throw new Error('Retained PR source settings changed');
          const query = { version: 1 as const, repo: taskObj.repo, number: taskObj.prNumber! };
          const snapshot = parsePullRequestFeedbackSnapshotV1(await registration.provider.feedbackSnapshot!(query, pullRequestContext(source.binding, lifetime.admissionSignal, false)), query);
          if (snapshot.state !== 'OPEN' || snapshot.headBranch !== taskObj.prBranch || snapshot.fingerprint !== await fingerprintPullRequestFeedbackSnapshotV1(snapshot)) {
            throw new Error('Current PR feedback revision could not be verified for retry');
          }
          taskObj.prHeadSha = snapshot.headSha;
          if (priorRun.worktreePath && existsSync(priorRun.worktreePath)) {
            if (!isFeedbackUpdateAdapter(priorRun.adapter) || priorRun.status === 'running' || pm.hasRun(priorRun.id)
              || !runnerDurability(cfg).cleanupEligibility(priorRun.id).allowed) throw new Error('Previous feedback worktree is still protected by an execution');
            await detachOwnedWorkspace(priorRun.id, taskObj.repo, priorRun.worktreePath, () => detachRetainedFeedbackWorktree(AGENTS_ROOT, taskObj.repo, priorRun.id, priorRun.worktreePath!, taskObj.prBranch!));
          }
        }
      }
      taskObj.clarification = createClarificationChannel(RUNS_DIR, { runId, attempt: 1, gateUrl: `http://127.0.0.1:${PORT}/api/runs/${runId}/clarification-gate` });
      taskObj.instructions = { directory: instructionDirectory(RUNS_DIR, runId, taskObj.clarification.attempt!, taskObj.clarification.channelId!), runId, attempt: taskObj.clarification.attempt!, channelId: taskObj.clarification.channelId! };
      const prepared = await prepareExecution({ runId, runsDir: RUNS_DIR, workflowDbPath: dbPath, store: workflows, task: taskObj,
        provider: adapter.id, workflow: taskObj.review ? 'review' : 'coding', reviewSettings: cfg.prePr, model: taskObj.model, effort: taskObj.effort });
      taskObj = prepared.task;
      const runAdapter = selectedWorkflow.record.metadata.execution === 'staged' ? prePrAdapter(adapter, RUNS_DIR, prepared.reviewSettings, publicationConnection(runId)) : selectedWorkflow.record.metadata.feedbackCompletion === true ? feedbackUpdateAdapter(adapter, RUNS_DIR) : taskObj.review && taskObj.hostIsolation ? dockerReviewAdapter(adapter) : adapter;
      lifetime.admissionSignal.throwIfAborted();
      pullRequestSource?.assertCurrent();
      lifetime.startExecution();
      await startRun(taskObj, {
        ...baseRunnerDeps(cfg, runId, hosting),
        launchJson,
        adapter: runAdapter,
        ...((isPrePrAdapter(runAdapter.id) || isFeedbackUpdateAdapter(runAdapter.id)) ? { maxAttempts: 1, preserveWorktreeOnFailure: true } : {}),
        genId: () => runId,
        onLaunch: (_runId: string, stop: () => Promise<void>) => {
          control.stop = stop;
          if (control.stopped) void stop();
        },
        isStopped: () => control.stopped,
      });
    } catch (error: unknown) {
      const ts = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const durableAttempt = executions.attempt({ runId, attempt: db.getRun(runId)?.attempt ?? 1 });
      if (durableAttempt) {
        db.appendEvent(runId, 'recovery-blocked', message, ts);
        bus.publish(runId, { kind: 'error', text: message });
        return;
      }
      if (taskSourceRuntime.claimForRun(runId)) {
        try { await taskSourceRuntime.abort(runId, control.stopped ? 'stopped-before-launch' : 'preflight-failed'); }
        catch (settlementError) { process.stderr.write(`Source admission ${runId} remains protected: ${String(settlementError)}\n`); }
      }
      if (db.getRun(runId)) db.updateRun(runId, { status: 'failed', endedAt: ts });
      else db.insertRun({
        id: runId, ticketId: body.ticketId ?? body.mode ?? 'freeform', repo: body.repo,
        adapter: selectedWriterId, status: 'failed', attempt: 1, prNumber: body.prNumber ?? null,
        startedAt: ts, endedAt: ts, costUsd: null, worktreePath: null, launchJson,
      });
      db.appendEvent(runId, 'error', message, ts);
      db.appendEvent(runId, 'run-complete', 'failed', ts);
      bus.publish(runId, { kind: 'error', text: message });
      bus.publish(runId, { kind: 'run-complete', text: 'failed' });
    } finally {
      lifetime.dispose();
      await loadedAgents?.dispose();
      if (loadedHost) await releaseRunHost(runId, loadedHost);
      const finalRun = db.getRun(runId);
      if (finalRun?.status === 'failed' && !finalRun.taskJson && !outcomeStore.getAssessment(runId)) {
        outcomeStore.saveAssessment({ runId, state: 'not-assessed', outcome: 'unknown', summary: 'Launch preflight failed before execution.', evidence: [], failureStage: 'preflight', correctionRounds: null });
      }
      if (finalRun?.status !== 'running') gateway.revokeRun(runId);
      const status = finalRun?.status;
      if (status && status !== 'running' && !taskSourceRuntime.claimForRun(runId)) todos.finishRun(runId, status);
      const admission = admissions.get(runId);
      if (admission && ['pending', 'blocked'].includes(admission.state) && finalRun?.status === 'failed') admissions.fail(runId, 'Preflight failed before a worker attempt was prepared');
      pm.remove(runId);
      void drainEffects().then(pollCreatedPrReviews);
    }
  })();
  return runId;
}

function fetchTopBacklog(repo: string): Promise<BacklogItem | null> {
  return taskSourceRuntime.schedule.next(repo, AbortSignal.timeout(30_000));
}

function scheduleAutomaticTick(): void {
  let intervalMs = 60_000;
  try { intervalMs = schedulingSelection().registration.provider.intervalMs; } catch {}
  setTimeout(() => { void scheduler.tick().finally(scheduleAutomaticTick); }, intervalMs);
}
scheduleAutomaticTick();

let slackWatcher: SlackWatcher | null = null;
let slackSettingsKey = '';
let slackTick: Promise<void> | null = null;

function configuredSlackWatcher(): SlackWatcher | null {
  const settings = slackSettings(triggerEnvironment());
  const key = JSON.stringify([settings.clientId, settings.channelId]);
  if (key === slackSettingsKey) return slackWatcher;
  slackSettingsKey = key;
  slackWatcher = settings.clientId && settings.channelId ? createSlackWatcher({
    ...settings, store: slackStore,
    allowedRepos: () => {
      const cfg = configStore.current();
      return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
    },
    canLaunch: (repo) => triggerEnabled('slack-review') && pm.canStart(repo).ok,
    getRun: triggerRun, isRunActive: (id) => pm.hasRun(id), launch,
    captureTrigger: () => captureTrigger<CommunicationReviewTriggerProviderV1>('slack-review'),
    captureSource: signal => { const source = captureReviewSource('slack-review', signal); if (source.kind !== 'communication') throw new Error('Invalid Slack trigger source'); return source; },
    defaultWorkflowRef: defaultReviewWorkflow,
    observeOwnership: (proposal, trigger, signal) => {
      const pullRequest = captureTriggerPullRequest(signal);
      const source = captureReviewSource('slack-review', signal, pullRequest);
      const capture = captureTrigger<CommunicationReviewTriggerProviderV1>('slack-review');
      if (!capture) throw new Error('Slack review trigger is disabled');
      return observeAutomaticReviewOwnership({ proposal, trigger, pullRequest, source, assertCurrent() {
        capture.assertCurrent();
        resolveWorkflowSelection({ root: pluginDirectory(), registry: backendPlugins.workflows, mode: 'review', providerId: proposal.workflowRef });
      } });
    },
    retainPins: executions.retainPins, releaseTriggerPins: executions.releaseTriggerPins,
    intervalMs: SLACK_INTERVAL_MS,
  }) : null;
  return slackWatcher;
}

function slackSnapshot(repo: string | null = null): SlackState {
  const settings = slackSettings(triggerEnvironment());
  const watcher = configuredSlackWatcher();
  return {
    health: watcher?.health() ?? {
      enabled: settings.enabled, status: settings.enabled ? 'unavailable' : 'disabled',
      channelName: settings.channelName, intervalMs: SLACK_INTERVAL_MS,
      lastSuccessAt: null, error: settings.error,
    },
    githubHealth: githubReviewWatcher.health(),
    notifications: [...slackStore.listNotifications(100, repo).map(({ sourceKey: _sourceKey, proposal: _proposal, trigger: _trigger, policy: _policy, ...notification }) => {
      const run = notification.runId ? db.getRun(notification.runId) : null;
      let task: Partial<AgentTask> | null = null;
      try {
        const parsed: unknown = run?.taskJson ? JSON.parse(run.taskJson) : null;
        if (parsed && typeof parsed === 'object') task = parsed as Partial<AgentTask>;
      } catch { task = null; }
      return { ...notification, runId: run?.id ?? null,
        model: task?.model ?? null, effort: task?.effort ?? null, complexity: task?.reviewComplexity ?? null };
    }), ...voyageNotifications.listNotifications(100, repo)].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || b.id.localeCompare(a.id)),
  };
}

function reconcileTriggerReviewReceipts(): void {
  for (const notification of [...slackStore.notificationsByStatus('queued'), ...slackStore.notificationsByStatus('launched')]) {
    if (!notification.trigger || !notification.runId) continue;
    const run = triggerRun(notification.runId);
    if (!run) continue;
    const status = run.status === 'failed' ? 'failed' : 'launched';
    if (notification.status !== status) slackStore.updateNotification(notification.id, status, new Date().toISOString(), status === 'failed' ? 'PR run failed; open the run for details' : null);
  }
  for (const pin of executions.pins()) {
    if (pin.kind !== 'dependency' || !pin.ownerId.startsWith('trigger:review:')) continue;
    try { executions.releaseTriggerPins({ store: 'review', rowId: pin.ownerId.slice('trigger:review:'.length) }); } catch {}
  }
}
function pollSlack(): Promise<void> {
  slackTick ??= Promise.resolve().then(async () => {
    reconcileTriggerReviewReceipts();
    if (slackSettings(triggerEnvironment()).enabled) await communicationRuntime.refreshConnection(AbortSignal.timeout(30_000));
    await configuredSlackWatcher()?.poll();
  }).catch((error: unknown) => process.stderr.write(`Slack watcher failed: ${String(error)}\n`))
    .then(() => undefined).finally(() => { slackTick = null; });
  return slackTick;
}

scheduleTriggerPoll('slack-review', pollSlack, SLACK_INTERVAL_MS);

const githubReviewEnabled = () => triggerEnabled('github-review');
const githubReviewWatcher = createGithubReviewWatcher({
  store: slackStore,
  fetchPr: (repo, number) => {
    const github = configStore.current().github;
    return github ? fetchReviewHead(github, repo, number) : Promise.resolve(null);
  },
  allowedRepos: () => {
    const cfg = configStore.current();
    return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
  },
  canLaunch: (repo) => githubReviewEnabled() && pm.canStart(repo).ok,
  getRun: triggerRun, isRunActive: (id) => pm.hasRun(id), launch,
  captureTrigger: () => captureTrigger<PullRequestReviewTriggerProviderV1>('github-review'),
  captureSource: signal => { const source = captureReviewSource('github-review', signal); if (source.kind !== 'pull-request') throw new Error('Invalid requested-review trigger source'); return source; },
  defaultWorkflowRef: defaultReviewWorkflow, verifyProposal: verifyReviewProposal,
  retainPins: executions.retainPins, releaseTriggerPins: executions.releaseTriggerPins,
  findExistingReview,
  intervalMs: SLACK_INTERVAL_MS,
});

const pollGithubReviews = () => githubReviewWatcher.poll().catch((error: unknown) => process.stderr.write(`GitHub review watcher failed: ${String(error)}\n`));
setInterval(() => { void pollCreatedPrReviews(); }, SLACK_INTERVAL_MS);
scheduleTriggerPoll('github-review', pollGithubReviews, SLACK_INTERVAL_MS);
void pollCreatedPrReviews();
void pollSlack();
void pollGithubReviews();

const campaignDispatcher = createCampaignDispatcher({ store: campaignsStore, canStart: repo => applicationRepos().some(allowed => allowed.toLowerCase() === repo.toLowerCase()) && pm.canStart(repo).ok,
  getRun: triggerRun, hasAdmission: id => Boolean(admissions.get(id)), stop: id => pm.stop(id),
  captureTrigger: () => captureTrigger<CampaignTriggerProviderV1>('campaign'), retainPins: executions.retainPins, releaseTriggerPins: executions.releaseTriggerPins,
  launch: input => launch({ repo: input.repo, mode: input.mode, runId: input.runId, workflowRef: input.workflowRef, trigger: input.trigger,
    ...(input.task === null ? {} : { task: input.task }), ...(input.ticketId === null ? {} : { ticketId: input.ticketId }),
    ...(input.title === null ? {} : { title: input.title }), ...(input.retryOf ? { retryOf: input.retryOf } : {}) }),
});

scheduleTriggerPoll('campaign', () => campaignDispatcher.poll().catch(error => process.stderr.write(`Campaign dispatch failed: ${String(error)}\n`)), 5000);

setInterval(() => { void webhooks.poll().catch(error => process.stderr.write(`Webhook dispatch failed: ${String(error)}\n`)); }, 5000);

class RequestBodyError extends Error {
  readonly status: 400 | 413;
  constructor(message: string, status: 400 | 413) { super(message); this.status = status; }
}

async function readRawBody(req: IncomingMessage, maximum = 2_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > maximum) throw new RequestBodyError('Request payload too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, maximum?: number): Promise<unknown> {
  const raw = await readRawBody(req, maximum);
  if (!raw.length) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new RequestBodyError('Invalid JSON request body', 400);
  }
}

const recoveryService = createRecoveryService({ db, executions, admissions, operations, lifecycle, runCommands, sourceCommands, legacy: legacyExecutions, taskSources: taskSourceRuntime.store, callbacks: {
  requestStop: runId => { if (!pm.hasAttached(runId) || !pm.stop(runId)) throw new Error('Verified worker attachment is unavailable'); },
  retryAttachment: async runId => {
    if (pm.hasAttached(runId)) throw new Error('This voyage already has an attachment');
    const row = db.getRun(runId);
    if (!row) throw new Error('Voyage is unavailable');
    const result = await dispatchReattach(row);
    if (result.status !== 'attached') throw new Error(result.reason);
    void result.completion.catch(error => { process.stderr.write(`Recovery completion failed: ${String(error)}\n`); });
  },
  reconcileOperation: async id => {
    const operation = operations.get(id);
    if (operation?.kind === 'task-source.effect') { await dispatchOperation(operations, id, taskSourceRuntime.effects.resolve, { reconcile: operation.requiresReconciliation }); await taskSourceRuntime.drain(); return; }
    if (operation?.origin.kind === 'public-source-action') { await taskActions.recover(id); return; }
    if (operation?.origin.kind === 'public-feedback') { await feedbackCommands.dispatch(id); return; }
    if (operation?.origin.kind === 'public-communication-review-request') { await communicationCommands.dispatch(id); return; }
    if (operation?.origin.kind === 'public-pull-request-review') { await pullRequestCommands.dispatch(id); return; }
    if (operation?.origin.kind === 'manual-review') { await manualReviewEffects.dispatch(id); return; }
    if (operation?.kind === 'slack.review-request') { await slackEffects.dispatch(id); return; }
    if (operation && ['git.push', 'github.pr-create', 'github.pr-edit'].includes(operation.kind)) {
      await dispatchOperation(operations, id, publicationService.resolve, { reconcile: true });
      return;
    }
    if (!operation?.origin.runId) throw new Error('Recorded operation origin is unavailable');
    await effectsFor(operation.origin.runId).dispatch(id);
  },
  cancelAdmission: async (runId, resolution) => {
    if (taskSourceRuntime.claimForRun(runId)) await taskSourceRuntime.abort(runId, 'cancelled');
    persistence.transaction(() => {
    const admission = admissions.get(runId);
    if (!admission) throw new Error('Admission is unavailable');
    admissions.fail(runId, `${resolution.actor}: ${resolution.reason}`);
    const timestamp = new Date().toISOString();
    if (!db.getRun(runId)) db.insertRun({ id: runId, repo: admission.repo, ticketId: 'unstarted', adapter: 'unstarted', status: 'stopped', attempt: 1, prNumber: null,
      startedAt: admission.createdAt, endedAt: timestamp, costUsd: null, worktreePath: null, launchJson: JSON.stringify(admission.request) });
    if (!taskSourceRuntime.claimForRun(runId)) todos.finishRun(runId, 'stopped');
    db.appendEvent(runId, 'admission-cancelled', JSON.stringify(resolution), new Date().toISOString());
    });
  },
  retrySourceSettlement: claimId => taskSourceRuntime.retrySettlement(claimId),
  retireCheckpoint: async (id, resolution) => { executions.retireCheckpoint(id, resolution); await taskSourceRuntime.drain(); },
  resolveOperation: (id, resolution) => { operations.resolve(id, resolution); },
} });


const communicationConnectionHandler = createCommunicationConnectionHandler({ capture: communicationRuntime.captureConnection,
  authorize(caller) { if (!communicationContributionEnabled(pluginSnapshot.catalog, caller)) throw new Error('Forbidden'); } });

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url: URL = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (await communicationConnectionHandler(req, res, url)) return;
    if (!allowMutationRequest(req, url.pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Mutations require a same-origin JSON request to the local server.' })); return;
    }
    if (url.pathname === '/api/plugins/manage') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, POST' });
        res.end(JSON.stringify({ error: 'Method not allowed.' })); return;
      }
      try {
        const result = req.method === 'GET' ? await pluginManager.snapshot() : await pluginManager.handle(await readBody(req, 21_000_000));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error instanceof PluginManagementError ? error.status : error instanceof RequestBodyError ? error.status : 503;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ error: error instanceof PluginManagementError || error instanceof RequestBodyError ? error.message : 'Plugin management is unavailable.' }));
      }
      return;
    }
    if (url.pathname === '/api/plugins/catalog' && (req.method === 'GET' || req.method === 'HEAD')) {
      try { await pluginCoordinator.reconcile(); await refreshPluginSnapshot(); }
      catch {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'Plugin catalog unavailable.' })); return;
      }
    }
    if (handlePluginRequest(req, res, url, pluginSnapshot)) return;
    if (url.pathname === '/recovery' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : recoveryPage()); return;
    }
    if (url.pathname === '/api/webhooks/github/credential' && req.method === 'PUT') {
      const input = await readBody(req, 8192);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
        || !('secret' in input) || typeof input.secret !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid credential input.' })); return;
      }
      try {
        configStore.setWebhookCredential(input.secret, () => new Date().toISOString());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ configured: Boolean(configStore.webhookCredential()) }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid credential input.' }));
      }
      return;
    }
    if (url.pathname === '/api/webhooks/github' && req.method === 'POST') {
      try {
        const headers = Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const result = webhooks.receive(await readRawBody(req, 1_000_000), { values: headers });
        res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        void webhooks.poll().catch(error => process.stderr.write(`Webhook dispatch failed: ${String(error)}\n`));
      } catch (error) {
        res.writeHead(error instanceof WebhookError || error instanceof RequestBodyError ? error.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof WebhookError || error instanceof RequestBodyError ? error.message : 'Webhook intake failed' }));
      }
      return;
    }
    if (url.pathname === '/api/workflows' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(backendPlugins.workflows.list().map(({ record }) => ({ id: record.binding.providerId, ref: `${record.binding.providerId}@1`, version: 1, name: record.metadata.label, modes: record.metadata.modes, execution: record.metadata.execution })))); return;
    }
    if (await handleRunInspectExport(req, res, url, runInspect)) return;
    if (await handleRunLog(req, res, url.pathname, db, bus)) return;
    const hasBody: boolean = req.method === 'POST' || req.method === 'PUT';
    const commandBodyLimit = url.pathname.startsWith('/api/campaign-service/') || url.pathname.startsWith('/api/local-git/') || url.pathname.startsWith('/api/terminal/') ? 3 * 1024 * 1024 + 4096 : undefined;
    const body: unknown = hasBody ? await readBody(req, commandBodyLimit) : null;
    if (url.pathname === '/api/recovery' || url.pathname === '/api/recovery/actions') {
      const result = await handleRecoveryRequest(req.method ?? 'GET', url.pathname, url.searchParams, body, recoveryService);
      res.writeHead(result?.status ?? 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(result?.json ?? { error: 'Recovery action unavailable.' })); return;
    }
    const inspectController = (url.pathname.startsWith('/api/pull-request-inspect/') || url.pathname.startsWith('/api/task-context/') || url.pathname === '/api/profile') ? new AbortController() : null;
    const cancelInspect = () => inspectController?.abort();
    if (inspectController) {
      req.once('aborted', cancelInspect); res.once('close', cancelInspect);
      if (req.aborted || res.destroyed) cancelInspect();
    }
    const taskActionResult = await handleTaskActionApi({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, service: taskActions,
      caller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined });
    if (taskActionResult) {
      res.writeHead(taskActionResult.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(taskActionResult.json)); return;
    }
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      sourceAdmin, sourceAdminCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      taskEdit, taskViews, sourceCommands, sourceCommandCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      runRead, taskContext, taskContextSignal: inspectController?.signal, runInspect, pullRequestRead, pullRequestInspect, pullRequestInspectSignal: inspectController?.signal, activityRead, runCommands, runCommandCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      integrationSettings, integrationSettingsCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      executionPolicy, executionPolicyCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      publicLocalGit, localGitCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      terminal, terminalCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      feedbackSettings, feedbackCommands, communication, communicationCommands, communicationCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      pullRequestCommands, pullRequestCommandCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      clarificationGate, feedbackClarifications, feedbackSnapshot, publicClarifications, runInstructions, clarificationCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      outcomes,
      taskSources: taskSourceRuntime.service,
      sourceSchedule: taskSourceRuntime.schedule,
      usage: usageQueries,
      pricing: async snapshot => (await backendPlugins.pricing(snapshot)).estimate,
      publicCampaigns, campaignCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
      clarifications,
      outboundUsage: () => outboundMeter.snapshot(),
      profile, profileCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined, profileSignal: inspectController?.signal,
      context: () => {
        const cfg = configStore.current();
        return {
          repos: applicationRepos(cfg),
          jiraEnabled: taskSourceRuntime.jiraEnabled(),
          jiraBaseUrl: unmaskedConfig().jira?.baseUrl ?? null,
        };
      },
      slack: { snapshot: slackSnapshot },
      todos: sourceTodos,
      jiraEnabled: () => taskSourceRuntime.jiraEnabled(),
      db,
      canStart: (repo: string) => pm.canStart(repo),
      launch,
      resumeRun: resumeVoyage,
      stop: (id: string) => pm.stop(id),
      setAutoClaim: (repo: string, enabled: boolean) => scheduler.setEnabled(repo, enabled),
      autoClaimRepos: () => scheduler.enabledRepos(),
      caps: () => {
        const c: AppConfig = configStore.current();
        return { maxAttempts: c.maxAttempts, maxCostUsd: c.maxCostUsd };
      },
      getConfig: () => ({
        config: Object.fromEntries(Object.entries(publicConfig(configStore.current())).filter(([key]) => !/^(?:JIRA_|GITHUB_|SLACK_|PRE_PR_|HELMSMAN_WEBHOOK_)/.test(key))),
        overridden: Object.keys(configStore.overrides()).filter(key => !/^(?:JIRA_|GITHUB_|SLACK_|PRE_PR_|HELMSMAN_WEBHOOK_)/.test(key)),
      }),
      setConfig: (key: string, value: string): { ok: true } | { ok: false; error: string } => {
        try {
          configStore.setOverride(key, value, () => new Date().toISOString());
          return { ok: true as const };
        } catch (err: unknown) {
          return { ok: false as const, error: err instanceof Error ? err.message : 'invalid config key' };
        }
      },
    }).finally(() => {
      if (inspectController) { req.off('aborted', cancelInspect); res.off('close', cancelInspect); }
    });
    if (inspectController?.signal.aborted) return;
    if (api) {
      res.writeHead(api.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(api.json));
      return;
    }
    const isPage = isAppPagePath(url.pathname);
    const rel: string = isPage ? '/index.html' : url.pathname;
    const file: string = normalize(join(DIST, rel));
    if (file.startsWith(DIST + sep) && existsSync(file)) {
      const buf: Buffer = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })().catch((err: unknown) => {
    if ((err instanceof RequestBodyError || err instanceof GoCaaSConfigurationError) && !res.headersSent) {
      res.writeHead(err instanceof RequestBodyError ? err.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message })); return;
    }
    process.stderr.write(`request error: ${String(err)}\n`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  });
});

server.on('close', () => { runRecovery.dispose(); runnerShutdown.abort(); gatewayServer.close(); clearInterval(effectTimer); pluginCoordinator.dispose(); void backendPlugins.dispose(); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  runRecovery.dispose();
  runnerShutdown.abort();
  server.close();
  void backendPlugins.dispose().finally(() => process.exit(0));
});
server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`Helmsman on :${address && typeof address === 'object' ? address.port : PORT}\n`);
});
