import type { WorkflowFeedbackStageV1 } from '../../../src/plugins/workflow';
import type { PullRequestSourceRecord } from '../pull-request-source';
import type { TriggerProvenanceV1 } from '../trigger-provenance';
import type { AgentInteractiveCommandV1, AgentProviderMetadataV1 } from '../../../src/plugins/agent-provider';
import type { AgentSelectionV1 } from '../agent-providers';
import type { ArtifactBinding, ProviderBinding } from '../execution-store';
import type { PluginJson } from '../../../src/plugins/backend';
import type { ExecutionHostRetainedProviderV1 } from '../execution-host-providers';
import type { WorkflowRetainedProviderV1 } from '../workflow-providers';

export interface AgentTask {
  instructions?: { directory: string; runId: string; attempt: number; channelId: string };
  feedbackStage?: WorkflowFeedbackStageV1;
  modelGateway?: { url: string; token: string };
  trigger?: TriggerProvenanceV1;
  pullRequestSource?: PullRequestSourceRecord;
  triggerReviewSource?: { binding: ProviderBinding; revision: string; artifacts: readonly ArtifactBinding[] };
  executionHost?: ExecutionHostRetainedProviderV1;
  hostRuntime?: { pluginsRoot: string; runtimeArtifactsRoot: string; artifacts: readonly ArtifactBinding[] };
  hostConfiguration?: PluginJson;
  hostIsolation?: { runId: string; gatewayUrl: string; capability: string; runtimeRoot?: string };
  agentSelection?: AgentSelectionV1;
  agentRuntime?: { pluginsRoot: string; runtimeArtifactsRoot: string; artifacts: readonly ArtifactBinding[] };
  workflow?: WorkflowRetainedProviderV1;
  workflowRuntime?: { pluginsRoot: string; runtimeArtifactsRoot: string; artifacts: readonly ArtifactBinding[] };
  source?: { version: 1; taskSnapshotHash: string; claimId: string; instanceId: string };
  contactHints?: { explicitContactId?: string; assigneeId?: string; reporterId?: string };
  ticketId: string;
  todoId?: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
  jiraContext?: string;
  task?: string;
  prBranch?: string;
  prNumber?: number;
  review?: boolean;
  model?: string;
  effort?: string;
  prHeadSha?: string;
  reviewComplexity?: 'low' | 'medium' | 'high';
  reviewReason?: string;
  reviewOutputPaths?: { markdown: string; comments: string };
  clarification?: { questionsPath: string; answersPath: string; gateUrl?: string; gateToken?: string;
    version?: 1; runId?: string; attempt?: number; channelId?: string };
  workflowSnapshotId?: string;
  skillsPath?: string;
  promptRevision?: string;
  dockerExecution?: { image: string; gatewayUrl: string; capability: string; runId: string; runtimeRoot?: string };
  prePrResume?: {
    baseSha: string;
    headSha: string;
    branch: string;
    round: number;
    reviewerReports: Record<string, string>;
    metadataPath: string;
  };
  prePr?: {
    stage: 'implement' | 'review' | 'fix';
    baseSha: string;
    headSha?: string;
    reportPath: string;
    feedback?: string;
    round?: number;
    incompleteReview?: { reportPath: string; summary: string };
    summaryCorrection?: { reportPath: string; actualLength: number };
  };
}

export type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'usage' | 'error' | 'review-verdict' | 'run-complete' | 'feedback-outcome';

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentEvent {
  kind: AgentEventKind;
  outcome?: 'success' | 'failure' | 'unknown';
  text: string;
  costUsd?: number;
  prNumber?: number;
  eventId?: string;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
  effort?: string;
  stage?: string;
  round?: number;
}

export interface AgentResult {
  ok: boolean;
  prNumber?: number;
  costUsd?: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly metadata?: AgentProviderMetadataV1;
  buildCommand(task: AgentTask): { cmd: string; args: string[] };
  buildInteractiveCommand?(task: AgentTask): AgentInteractiveCommandV1;
  parseLine(line: string): AgentEvent | null;
}
