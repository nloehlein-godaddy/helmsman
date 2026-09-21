import { triggerExecutionSnapshot } from './trigger-execution';
import { parseWorkflowRetainedProviderV1 } from './workflow-providers';
import { parseAgentSelectionV1 } from './agent-providers';
import { workflowExecutionSnapshot } from './workflow-execution';
import { hostExecutionSnapshot } from './execution-host-execution';
import { agentExecutionSnapshot } from './agent-execution';
import type { AppConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { ArtifactBinding, ExecutionSnapshot, ExecutionSnapshotInput, ProviderBinding } from './execution-store';
import { persistedJson, persistenceHash } from './persistence';
import type { HostRef } from './run-host';
import { PRE_PR_SETTING_DEFINITIONS, parsePrePrSettingValue, type PrePrSettings } from '../../src/logic/prePrSettings';

export function restoreExecutionConfig(snapshot: ExecutionSnapshot, current: AppConfig): AppConfig {
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const saved = record(snapshot.settings.execution);
  if (!saved || !Number.isSafeInteger(saved.maxAttempts) || Number(saved.maxAttempts) < 1
    || !(saved.maxCostUsd === null || typeof saved.maxCostUsd === 'number' && Number.isFinite(saved.maxCostUsd) && saved.maxCostUsd >= 0)
    || !(saved.botAccountId === null || typeof saved.botAccountId === 'string')
    || typeof saved.statusInProgress !== 'string' || typeof saved.statusInReview !== 'string') throw new Error('Retained execution settings are invalid');
  const jira = record(saved.jira);
  const github = record(saved.github);
  if (jira && (!current.jira || jira.baseUrl !== current.jira.baseUrl || jira.email !== current.jira.email || typeof jira.project !== 'string')
    || github && (!current.github || github.host !== 'api.github.com' || github.author !== current.github.author)) throw new Error('Restore the recorded service connection before recovery');
  if (snapshot.settings.agents === undefined && saved.commandHash !== (current.agentCmd ? persistenceHash(current.agentCmd) : null)) throw new Error('Restore the recorded command agent before recovery');
  const prePr = {} as PrePrSettings;
  if (snapshot.settings.workflow !== undefined) {
    const workflow = parseWorkflowRetainedProviderV1(snapshot.settings.workflow);
    prePr.reviewerCount = Math.max(1, parseAgentSelectionV1(snapshot.settings.agents).reviewers.length);
    prePr.maxRounds = workflow.metadata.maxRounds;
    prePr.stageTimeoutMinutes = workflow.metadata.stageTimeoutMinutes;
  } else {
    const settings = record(saved.prePr);
    for (const definition of PRE_PR_SETTING_DEFINITIONS) {
      const value = parsePrePrSettingValue(settings?.[definition.key], definition);
      if (value === undefined) throw new Error('Retained review policy is invalid');
      prePr[definition.key] = value;
    }
  }
  return { ...current, maxAttempts: Number(saved.maxAttempts), maxCostUsd: saved.maxCostUsd, botAccountId: saved.botAccountId,
    statusInProgress: saved.statusInProgress, statusInReview: saved.statusInReview, prePr,
    jira: jira && current.jira ? { ...current.jira, project: String(jira.project) } : null, github: github ? current.github : null };
}

export function nonsecretExecutionTask(task: AgentTask) {
  const safeTask = { ...task,
    ...(task.hostIsolation ? { hostIsolation: { ...task.hostIsolation, capability: undefined } } : {}),
    ...(task.dockerExecution ? { dockerExecution: { ...task.dockerExecution, capability: undefined } } : {}),
    ...(task.clarification ? { clarification: { ...task.clarification, gateToken: undefined } } : {}) };
  return persistedJson(JSON.parse(JSON.stringify(safeTask)));
}

export function legacyExecutionSettings(config: AppConfig, boundAgents = false, boundWorkflow = false) {
  return persistedJson({ maxAttempts: config.maxAttempts, maxCostUsd: config.maxCostUsd,
    botAccountId: config.botAccountId, statusInProgress: config.statusInProgress, statusInReview: config.statusInReview,
    commandHash: !boundAgents && config.agentCmd ? persistenceHash(config.agentCmd) : null, prePr: boundWorkflow ? null : config.prePr,
    jira: config.jira ? { baseUrl: config.jira.baseUrl, email: config.jira.email, project: config.jira.project } : null,
    github: config.github ? { host: 'api.github.com', author: config.github.author } : null });
}

export function legacyExecutionSnapshot(input: {
  run: RunRow; task: AgentTask; artifact: ArtifactBinding; host: HostRef['kind']; config: AppConfig;
}): ExecutionSnapshotInput {
  const { run, task, artifact, config } = input;
  const source = task.todoId ? 'todos' : task.review ? 'github-review' : task.task ? 'freeform' : 'jira';
  const binding = (role: ProviderBinding['role'], capability: string, contributionId: string,
    connectionId: string | null = null, credentialHandle: string | null = null): ProviderBinding => ({ role, capability, contributionId,
    pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, contractVersion: 1, connectionId, credentialHandle });
  const jiraIdentity = config.jira ? persistenceHash({ baseUrl: config.jira.baseUrl, email: config.jira.email }) : null;
  const githubIdentity = config.github ? persistenceHash({ host: 'api.github.com', author: config.github.author }) : null;
  const bindings: ProviderBinding[] = [binding('host', 'host', input.host), binding('agent', 'agent', run.adapter),
    binding('source', 'source', source, source === 'jira' ? jiraIdentity : source === 'github-review' ? githubIdentity : null,
      source === 'jira' ? 'jira-primary' : source === 'github-review' ? 'github-primary' : null),
    binding('workflow', 'workflow', task.review ? 'review' : 'coding')];
  if (jiraIdentity) bindings.push(binding('effect', 'jira', 'jira-actions', jiraIdentity, 'jira-primary'));
  if (githubIdentity) bindings.push(binding('effect', 'github', 'github-publication', githubIdentity, 'github-primary'));
  return triggerExecutionSnapshot(workflowExecutionSnapshot(hostExecutionSnapshot(agentExecutionSnapshot({ version: 1, runId: run.id, attempt: run.attempt, repo: run.repo,
    logicalWork: { source, instance: source === 'jira' ? jiraIdentity ?? 'unconfigured' : source === 'github-review' ? githubIdentity ?? 'unconfigured' : 'local', taskId: task.todoId ?? task.ticketId },
    task: nonsecretExecutionTask(task), workflowSnapshotId: task.workflowSnapshotId ?? null,
    artifacts: [artifact], bindings, settings: { execution: legacyExecutionSettings(config, Boolean(task.agentSelection), Boolean(task.workflow)) },
    schemas: [{ owner: 'core.runs', minimum: 1, maximum: 1 }, { owner: 'core.execution', minimum: 1, maximum: 1 }],
    provenance: { kind: 'admission', evidence: { runtimeHash: artifact.artifactHash } } }, task), task), task), task);
}
