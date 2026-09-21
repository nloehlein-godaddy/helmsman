import { isContributionId } from './source-contract-validation';
import type { ClarificationReadResultV1 } from './clarification-read';

export type CampaignPhaseState = 'draft' | 'running' | 'paused' | 'completed' | 'finished' | 'stopped';
export type CampaignTaskState = 'queued' | 'claiming' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Campaign {
  id: string;
  name: string;
  repo: string;
  workflowRef: string;
  concurrency: number;
  createdAt: string;
}

export interface CampaignPhase {
  id: string;
  campaignId: string;
  name: string;
  position: number;
  state: CampaignPhaseState;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecord {
  key: string | null;
  repo: string;
  mode: 'freeform' | 'ticket';
  task: string | null;
  ticketId: string | null;
  title: string | null;
}

export interface CampaignTask {
  id: string;
  campaignId: string;
  phaseId: string;
  record: CampaignRecord;
  state: CampaignTaskState;
  attempt: number;
  runId: string;
  claimToken: string | null;
  claimedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPreview {
  id: string;
  campaignId: string;
  phaseId: string;
  digest: string;
  records: CampaignRecord[];
  duplicateCount: number;
  createdAt: string;
  importedAt: string | null;
}

export interface CampaignWorkflow { ref: string; name: string }
export interface CampaignList { campaigns: Campaign[]; workflows: CampaignWorkflow[] }
export interface CampaignDetail { campaign: Campaign; phases: Array<{ phase: CampaignPhase; tasks: CampaignTask[] }> }

export interface CampaignListSnapshotV1 extends CampaignList {
  readonly version: 1;
  readonly repo: string | null;
}
export interface CampaignDetailSnapshotV1 extends CampaignDetail {
  readonly version: 1;
  readonly revision: string;
}
export interface CampaignTargetV1 { readonly campaignId: string; readonly revision: string; }
export type CampaignPhaseActionV1 = 'start' | 'pause' | 'resume' | 'finish' | 'stop';
export type CampaignCommandInputV1 = { readonly version: 1; readonly repo: string } & (
  | { readonly action: 'create'; readonly name: string; readonly workflowRef: string; readonly concurrency: number }
  | { readonly action: 'add-phase'; readonly target: CampaignTargetV1; readonly name: string }
  | { readonly action: 'preview'; readonly target: CampaignTargetV1; readonly phaseId: string; readonly format: 'csv' | 'jsonl'; readonly content: string }
  | { readonly action: 'confirm'; readonly target: CampaignTargetV1; readonly previewId: string; readonly digest: string }
  | { readonly action: 'phase'; readonly target: CampaignTargetV1; readonly phaseId: string; readonly operation: CampaignPhaseActionV1 }
  | { readonly action: 'retry-task'; readonly target: CampaignTargetV1; readonly taskId: string; readonly expectedAttempt: number }
);
export type CampaignCommandV1 = CampaignCommandInputV1 & { readonly requestId: string };
export type CampaignCommandValueV1 =
  | { readonly kind: 'created'; readonly campaign: Campaign }
  | { readonly kind: 'phase'; readonly phase: CampaignPhase }
  | { readonly kind: 'preview'; readonly preview: CampaignPreview }
  | { readonly kind: 'imported'; readonly tasks: readonly CampaignTask[] }
  | { readonly kind: 'retried'; readonly task: CampaignTask };
export interface CampaignReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface CampaignCommandReceiptV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly input: CampaignCommandInputV1;
  readonly status: 'succeeded' | 'rejected';
  readonly result: CampaignCommandValueV1 | null;
  readonly reason: string | null;
}
export interface CampaignPendingV1 { readonly command: CampaignCommandV1; readonly receipt: CampaignCommandReceiptV1 | null; }
export interface CampaignServiceV1 {
  readonly version: 1;
  list(input: { readonly version: 1; readonly repo: string | null }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignListSnapshotV1>>;
  detail(input: { readonly version: 1; readonly repo: string; readonly campaignId: string }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignDetailSnapshotV1>>;
  submit(input: CampaignCommandInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1>>;
  retry(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1>>;
  receipt(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CampaignCommandReceiptV1 | null>>;
  pending(signal?: AbortSignal): Promise<readonly CampaignPendingV1[]>;
  acknowledge(query: CampaignReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}

import { clarificationArray, clarificationFields, clarificationId, clarificationInteger, clarificationJson, clarificationObject, clarificationTime, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export const CAMPAIGN_LIMITS: Readonly<{ campaigns: number; phases: number; tasks: number; records: number; importBytes: number; responseBytes: number }> = Object.freeze({ campaigns: 500, phases: 100, tasks: 500, records: 200, importBytes: 1_000_000, responseBytes: 3 * 1024 * 1024 });
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) invalidClarification(); return value;
}
function optional(value: unknown, maximum: number): string | null { return value === null ? null : text(value, maximum); }
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalidClarification(); return value;
}
function digest(value: unknown): string { const parsed = sourceText(value, 64); if (!/^[a-f\d]{64}$/.test(parsed)) invalidClarification(); return parsed; }
function workflow(value: unknown): string { const parsed = sourceText(value, 200); if (!/^[a-z][a-z\d_.-]*@v?[1-9]\d*$/i.test(parsed) && !(parsed.endsWith('@1') && isContributionId(parsed.slice(0, -2)))) invalidClarification(); return parsed; }
export function parseCampaignV1(input: unknown): Campaign {
  const value = clarificationObject(input); clarificationFields(value, ['id', 'name', 'repo', 'workflowRef', 'concurrency', 'createdAt']);
  return { id: clarificationId(value.id), name: text(value.name, 120), repo: parseTaskRepo(value.repo), workflowRef: workflow(value.workflowRef), concurrency: clarificationInteger(value.concurrency, 20), createdAt: clarificationTime(value.createdAt) };
}
export function parseCampaignPhaseV1(input: unknown): CampaignPhase {
  const value = clarificationObject(input); clarificationFields(value, ['id', 'campaignId', 'name', 'position', 'state', 'createdAt', 'updatedAt']);
  if (!['draft', 'running', 'paused', 'completed', 'finished', 'stopped'].includes(String(value.state))) invalidClarification();
  return { id: clarificationId(value.id), campaignId: clarificationId(value.campaignId), name: text(value.name, 120), position: count(value.position, CAMPAIGN_LIMITS.phases), state: value.state as CampaignPhaseState, createdAt: clarificationTime(value.createdAt), updatedAt: clarificationTime(value.updatedAt) };
}
export function parseCampaignRecordV1(input: unknown): CampaignRecord {
  const value = clarificationObject(input); clarificationFields(value, ['key', 'repo', 'mode', 'task', 'ticketId', 'title']);
  const task = optional(value.task, 20_000); const ticketId = optional(value.ticketId, 80);
  if (value.mode !== 'freeform' && value.mode !== 'ticket' || value.mode === 'freeform' && (!task || ticketId !== null) || value.mode === 'ticket' && (task !== null || !ticketId || !/^[A-Z][A-Z\d_]*-[1-9]\d*$/.test(ticketId))) invalidClarification();
  return { key: optional(value.key, 200), repo: parseTaskRepo(value.repo), mode: value.mode, task, ticketId, title: optional(value.title, 240) };
}
export function parseCampaignTaskV1(input: unknown): CampaignTask {
  const value = clarificationObject(input); clarificationFields(value, ['id', 'campaignId', 'phaseId', 'record', 'state', 'attempt', 'runId', 'claimToken', 'claimedAt', 'error', 'createdAt', 'updatedAt']);
  if (!['queued', 'claiming', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.state))) invalidClarification();
  return { id: clarificationId(value.id), campaignId: clarificationId(value.campaignId), phaseId: clarificationId(value.phaseId), record: parseCampaignRecordV1(value.record), state: value.state as CampaignTaskState,
    attempt: clarificationInteger(value.attempt, 100), runId: clarificationId(value.runId), claimToken: value.claimToken === null ? null : clarificationUuid(value.claimToken), claimedAt: value.claimedAt === null ? null : clarificationTime(value.claimedAt),
    error: optional(value.error, 2000), createdAt: clarificationTime(value.createdAt), updatedAt: clarificationTime(value.updatedAt) };
}
export function parseCampaignPreviewV1(input: unknown): CampaignPreview {
  const value = clarificationObject(input); clarificationFields(value, ['id', 'campaignId', 'phaseId', 'digest', 'records', 'duplicateCount', 'createdAt', 'importedAt']);
  return { id: clarificationId(value.id), campaignId: clarificationId(value.campaignId), phaseId: clarificationId(value.phaseId), digest: digest(value.digest), records: [...clarificationArray(value.records, parseCampaignRecordV1, CAMPAIGN_LIMITS.records)], duplicateCount: count(value.duplicateCount, CAMPAIGN_LIMITS.records * 2), createdAt: clarificationTime(value.createdAt), importedAt: value.importedAt === null ? null : clarificationTime(value.importedAt) };
}
export function parseCampaignTargetV1(input: unknown): CampaignTargetV1 {
  const value = clarificationObject(input); clarificationFields(value, ['campaignId', 'revision']); return Object.freeze({ campaignId: clarificationId(value.campaignId), revision: digest(value.revision) });
}
export function parseCampaignListSnapshotV1(input: unknown): CampaignListSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, CAMPAIGN_LIMITS.responseBytes)); clarificationFields(value, ['version', 'repo', 'campaigns', 'workflows']);
  const repo = value.repo === null ? null : parseTaskRepo(value.repo);
  const campaigns = [...clarificationArray(value.campaigns, parseCampaignV1, CAMPAIGN_LIMITS.campaigns)];
  if (new Set(campaigns.map(item => item.id)).size !== campaigns.length || repo !== null && campaigns.some(item => item.repo !== repo)) invalidClarification();
  const workflows = [...clarificationArray(value.workflows, item => { const data = clarificationObject(item); clarificationFields(data, ['ref', 'name']); return { ref: workflow(data.ref), name: text(data.name, 240) }; }, 500)];
  if (new Set(workflows.map(item => item.ref)).size !== workflows.length) invalidClarification();
  return { version: 1, repo, campaigns, workflows };
}
export function parseCampaignDetailSnapshotV1(input: unknown): CampaignDetailSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, CAMPAIGN_LIMITS.responseBytes)); clarificationFields(value, ['version', 'revision', 'campaign', 'phases']);
  const campaign = parseCampaignV1(value.campaign); let total = 0;
  const phases = [...clarificationArray(value.phases, item => {
    const data = clarificationObject(item); clarificationFields(data, ['phase', 'tasks']); const phase = parseCampaignPhaseV1(data.phase);
    const tasks = [...clarificationArray(data.tasks, parseCampaignTaskV1, CAMPAIGN_LIMITS.tasks)]; total += tasks.length;
    if (phase.campaignId !== campaign.id || tasks.some(task => task.campaignId !== campaign.id || task.phaseId !== phase.id)) invalidClarification();
    return { phase, tasks };
  }, CAMPAIGN_LIMITS.phases)];
  const tasks = phases.flatMap(phase => phase.tasks);
  if (total > CAMPAIGN_LIMITS.tasks || new Set(phases.map(item => item.phase.id)).size !== phases.length || new Set(tasks.map(item => item.id)).size !== tasks.length) invalidClarification();
  return { version: 1, revision: digest(value.revision), campaign, phases };
}
export function parseCampaignCommandInputV1(input: unknown): CampaignCommandInputV1 {
  const value = clarificationVersion(clarificationJson(input, CAMPAIGN_LIMITS.responseBytes));
  const common = { version: 1 as const, repo: parseTaskRepo(value.repo) };
  if (value.action === 'create') {
    clarificationFields(value, ['version', 'repo', 'action', 'name', 'workflowRef', 'concurrency']);
    return Object.freeze({ ...common, action: 'create', name: text(value.name, 120), workflowRef: workflow(value.workflowRef), concurrency: clarificationInteger(value.concurrency, 20) });
  }
  const target = parseCampaignTargetV1(value.target);
  switch (value.action) {
    case 'add-phase': clarificationFields(value, ['version', 'repo', 'action', 'target', 'name']); return Object.freeze({ ...common, action: 'add-phase', target, name: text(value.name, 120) });
    case 'preview': {
      clarificationFields(value, ['version', 'repo', 'action', 'target', 'phaseId', 'format', 'content']);
      if (value.format !== 'csv' && value.format !== 'jsonl' || typeof value.content !== 'string' || value.content.includes('\0') || new TextEncoder().encode(value.content).byteLength > CAMPAIGN_LIMITS.importBytes) invalidClarification();
      return Object.freeze({ ...common, action: 'preview', target, phaseId: clarificationId(value.phaseId), format: value.format, content: value.content });
    }
    case 'confirm': clarificationFields(value, ['version', 'repo', 'action', 'target', 'previewId', 'digest']); return Object.freeze({ ...common, action: 'confirm', target, previewId: clarificationId(value.previewId), digest: digest(value.digest) });
    case 'phase': clarificationFields(value, ['version', 'repo', 'action', 'target', 'phaseId', 'operation']); if (!['start', 'pause', 'resume', 'finish', 'stop'].includes(String(value.operation))) invalidClarification(); return Object.freeze({ ...common, action: 'phase', target, phaseId: clarificationId(value.phaseId), operation: value.operation as CampaignPhaseActionV1 });
    case 'retry-task': clarificationFields(value, ['version', 'repo', 'action', 'target', 'taskId', 'expectedAttempt']); return Object.freeze({ ...common, action: 'retry-task', target, taskId: clarificationId(value.taskId), expectedAttempt: clarificationInteger(value.expectedAttempt, 100) });
    default: return invalidClarification();
  }
}
export function parseCampaignCommandV1(input: unknown): CampaignCommandV1 {
  const { requestId, ...value } = clarificationObject(input); return Object.freeze({ ...parseCampaignCommandInputV1(value), requestId: clarificationUuid(requestId) });
}
export function parseCampaignReceiptQueryV1(input: unknown): CampaignReceiptQueryV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'requestId']); return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: clarificationUuid(value.requestId) });
}
export function parseCampaignCommandReceiptV1(input: unknown, expected?: CampaignCommandV1 | CampaignReceiptQueryV1): CampaignCommandReceiptV1 {
  const value = clarificationVersion(clarificationJson(input, CAMPAIGN_LIMITS.responseBytes)); clarificationFields(value, ['version', 'requestId', 'input', 'status', 'result', 'reason']);
  const command = parseCampaignCommandInputV1(value.input); const requestId = clarificationUuid(value.requestId);
  if (expected && (requestId !== expected.requestId || command.repo !== expected.repo)) invalidClarification();
  if (expected && 'action' in expected) { const { requestId: _id, ...original } = parseCampaignCommandV1(expected); if (JSON.stringify(original) !== JSON.stringify(command)) invalidClarification(); }
  if (value.status === 'rejected') {
    if (value.result !== null) invalidClarification();
    return { version: 1, requestId, input: command, status: 'rejected', result: null, reason: text(value.reason, 2000) };
  }
  if (value.status !== 'succeeded' || value.reason !== null) invalidClarification();
  const result = clarificationObject(value.result); let parsed: CampaignCommandValueV1;
  switch (command.action) {
    case 'create': {
      clarificationFields(result, ['kind', 'campaign']); const campaign = parseCampaignV1(result.campaign);
      if (result.kind !== 'created' || campaign.repo !== command.repo || campaign.name !== command.name.trim() || campaign.workflowRef !== command.workflowRef || campaign.concurrency !== command.concurrency) invalidClarification();
      parsed = { kind: 'created', campaign }; break;
    }
    case 'add-phase': case 'phase': {
      clarificationFields(result, ['kind', 'phase']); const phase = parseCampaignPhaseV1(result.phase);
      if (result.kind !== 'phase' || phase.campaignId !== command.target.campaignId || command.action === 'add-phase' && (phase.name !== command.name.trim() || phase.state !== 'draft') || command.action === 'phase' && (phase.id !== command.phaseId || phase.state !== ({ start: 'running', pause: 'paused', resume: 'running', finish: 'finished', stop: 'stopped' } as const)[command.operation])) invalidClarification();
      parsed = { kind: 'phase', phase }; break;
    }
    case 'preview': {
      clarificationFields(result, ['kind', 'preview']); const preview = parseCampaignPreviewV1(result.preview);
      if (result.kind !== 'preview' || preview.campaignId !== command.target.campaignId || preview.phaseId !== command.phaseId) invalidClarification(); parsed = { kind: 'preview', preview }; break;
    }
    case 'confirm': {
      clarificationFields(result, ['kind', 'tasks']); const tasks = clarificationArray(result.tasks, parseCampaignTaskV1, CAMPAIGN_LIMITS.records);
      if (result.kind !== 'imported' || tasks.some(task => task.campaignId !== command.target.campaignId) || new Set(tasks.map(task => task.id)).size !== tasks.length) invalidClarification(); parsed = { kind: 'imported', tasks }; break;
    }
    case 'retry-task': {
      clarificationFields(result, ['kind', 'task']); const task = parseCampaignTaskV1(result.task);
      if (result.kind !== 'retried' || task.id !== command.taskId || task.campaignId !== command.target.campaignId || task.attempt !== command.expectedAttempt + 1 || task.state !== 'queued') invalidClarification(); parsed = { kind: 'retried', task }; break;
    }
  }
  return { version: 1, requestId, input: command, status: 'succeeded', result: parsed, reason: null };
}
