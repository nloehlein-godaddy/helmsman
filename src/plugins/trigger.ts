import type { PluginJson } from './backend';
import { isContributionId, sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export type TriggerSelectionRoleV1 = 'campaign' | 'slack-review' | 'github-review' | 'github-webhook';
export interface CampaignTriggerMetadataV1 { readonly version: 1; readonly label: string; readonly kind: 'campaign'; readonly intervalMs: number; }
export interface ReviewTriggerMetadataV1 { readonly version: 1; readonly label: string; readonly kind: 'review-watch'; readonly intervalMs: number; readonly source: 'communication' | 'pull-request'; }
export interface WebhookTriggerMetadataV1 {
  readonly version: 1; readonly label: string; readonly kind: 'webhook';
  readonly ingress: { readonly signatureHeader: string; readonly deliveryHeader: string; readonly eventHeader: string; readonly algorithm: 'hmac-sha256'; readonly signaturePrefix: string };
}
export type TriggerMetadataV1 = CampaignTriggerMetadataV1 | ReviewTriggerMetadataV1 | WebhookTriggerMetadataV1;
export interface CampaignTriggerCandidateV1 {
  readonly candidateId: string; readonly repo: string; readonly campaignId: string; readonly phaseId: string; readonly taskId: string;
  readonly attempt: number; readonly workflowRef: string; readonly title: string; readonly mode: 'ticket' | 'freeform'; readonly createdAt: string;
}
export interface CampaignTriggerInputV1 { readonly version: 1; readonly candidates: readonly CampaignTriggerCandidateV1[]; readonly truncated: boolean; }
export interface CampaignTriggerChoiceV1 { readonly candidateId: string; }
export interface CampaignTriggerProviderV1 { readonly metadata: CampaignTriggerMetadataV1; select(input: CampaignTriggerInputV1): CampaignTriggerChoiceV1 | null; }
export interface TriggerReviewTargetV1 {
  readonly targetId: string; readonly repo: string; readonly number: number; readonly headSha: string; readonly title: string; readonly url: string;
  readonly status: 'open' | 'closed' | 'merged'; readonly draft: boolean;
}
export interface TriggerMessageV1 { readonly eventId: string; readonly channelId: string; readonly ts: string; readonly permalink: string; readonly author: string; readonly prUrls: readonly string[]; }
export interface TriggerMessageBatchV1 { readonly items: readonly TriggerMessageV1[]; readonly complete: boolean; }
export interface TriggerRequestedBatchV1 { readonly items: readonly { readonly repo: string; readonly number: number }[]; readonly quality: 'complete' | 'partial' | 'degraded'; readonly truncated: boolean; }
export interface TriggerReviewDetailInputV1 { readonly repo: string; readonly number: number; }
export interface CommunicationReviewTriggerContextV1 {
  readonly source: 'communication'; readonly signal: AbortSignal;
  messages(input: { readonly since: string | null }, signal?: AbortSignal): Promise<TriggerMessageBatchV1>;
  detail(input: TriggerReviewDetailInputV1, signal?: AbortSignal): Promise<TriggerReviewTargetV1 | null>;
}
export interface PullRequestReviewTriggerContextV1 {
  readonly source: 'pull-request'; readonly signal: AbortSignal;
  requested(signal?: AbortSignal): Promise<TriggerRequestedBatchV1>;
  detail(input: TriggerReviewDetailInputV1, signal?: AbortSignal): Promise<TriggerReviewTargetV1 | null>;
}
export type ReviewTriggerContextV1 = CommunicationReviewTriggerContextV1 | PullRequestReviewTriggerContextV1;
export interface ReviewTriggerInputV1 { readonly version: 1; readonly activatedAt: string; readonly cursor: string | null; readonly defaultWorkflowRef: string; }
export interface ReviewTriggerProposalV1 { readonly eventId: string | null; readonly targetId: string; readonly workflowRef: string; readonly sourceUrl: string; readonly author: string; readonly channelName: string; }
export interface ReviewTriggerResultV1 { readonly proposals: readonly ReviewTriggerProposalV1[]; readonly nextCursor: string | null; readonly complete: boolean; }
export interface CommunicationReviewTriggerProviderV1 {
  readonly metadata: ReviewTriggerMetadataV1 & { readonly source: 'communication' };
  scan(input: ReviewTriggerInputV1, context: CommunicationReviewTriggerContextV1): Promise<ReviewTriggerResultV1>;
}
export interface PullRequestReviewTriggerProviderV1 {
  readonly metadata: ReviewTriggerMetadataV1 & { readonly source: 'pull-request' };
  scan(input: ReviewTriggerInputV1, context: PullRequestReviewTriggerContextV1): Promise<ReviewTriggerResultV1>;
}
export type ReviewTriggerProviderV1 = CommunicationReviewTriggerProviderV1 | PullRequestReviewTriggerProviderV1;
export interface WebhookTriggerInputV1 { readonly version: 1; readonly deliveryId: string; readonly event: string; readonly body: PluginJson; }
export interface WebhookTriggerResultV1 {
  readonly workflowRef: string;
  readonly intent: { readonly mode: 'freeform'; readonly repo: string; readonly title: string; readonly task: string }
    | { readonly mode: 'review'; readonly repo: string; readonly title: string; readonly prNumber: number };
}
export interface WebhookTriggerProviderV1 { readonly metadata: WebhookTriggerMetadataV1; parse(input: WebhookTriggerInputV1): WebhookTriggerResultV1 | null; }
export type TriggerProviderV1 = CampaignTriggerProviderV1 | ReviewTriggerProviderV1 | WebhookTriggerProviderV1;
export interface TriggerDeclarationV1 { readonly access: readonly ['campaign-candidates'] | readonly ['review-discovery'] | readonly ['authenticated-event']; }
export interface TriggerBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerTrigger(localId: string, provider: TriggerProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface TriggerBackendModuleV1 { activate(context: TriggerBackendContextV1): void | Promise<void>; }
export const TRIGGER_LIMITS_V1: Readonly<Record<'items' | 'urls' | 'inputBytes' | 'proposalBytes' | 'calls', number>> = Object.freeze({ items: 100, urls: 100, inputBytes: 2 * 1024 * 1024, proposalBytes: 1024 * 1024, calls: 102 });
function invalid(): never { throw new TypeError('Invalid trigger contract'); }
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value; }
function text(value: unknown, maximum: number, empty = false): string { if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || !empty && !value.trim()) invalid(); return value; }
function date(value: unknown): string { const result = sourceText(value, 64); if (!Number.isFinite(Date.parse(result))) invalid(); return result; }
function url(value: unknown, empty = false): string {
  if (value === '' && empty) return ''; const result = sourceText(value, 4096); let parsed: URL; try { parsed = new URL(result); } catch { invalid(); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(); return result;
}
function json(input: unknown, maximum = TRIGGER_LIMITS_V1.inputBytes): Record<string, unknown> { return sourceObject(sourceJson(input, maximum)); }
function items(value: unknown): readonly unknown[] { if (!Array.isArray(value) || value.length > TRIGGER_LIMITS_V1.items) invalid(); return value; }
export function parseTriggerRoleV1(value: unknown): TriggerSelectionRoleV1 { if (value !== 'campaign' && value !== 'slack-review' && value !== 'github-review' && value !== 'github-webhook') invalid(); return value; }
export function parseTriggerWorkflowRefV1(value: unknown): string {
  const result = sourceText(value, 256); if (result !== 'coding@1' && result !== 'review@1' && !isContributionId(result.endsWith('@1') ? result.slice(0, -2) : result)) invalid(); return result;
}
function parseCampaignTriggerWorkflowRefV1(value: unknown): string {
  const result = sourceText(value, 256);
  if (!/^[a-z][a-z\d_.-]*@v?[1-9]\d*$/i.test(result) && !(result.endsWith('@1') && isContributionId(result.slice(0, -2)))) invalid();
  return result;
}
export function parseTriggerCursorV1(value: unknown): string | null {
  if (value === null) return null; const result = sourceText(value, 64); if (!/^\d{10,}\.\d{1,6}$/.test(result) || !Number.isFinite(Number(result))) invalid(); return result;
}
export function parseTriggerMetadataV1(input: unknown): TriggerMetadataV1 {
  const value = json(input, 16 * 1024); if (value.version !== 1) invalid(); sourceText(value.label, 128);
  if (value.kind === 'campaign' || value.kind === 'review-watch') {
    sourceFields(value, ['version', 'label', 'kind', 'intervalMs', ...(value.kind === 'review-watch' ? ['source'] : [])]); integer(value.intervalMs, 1000, 3_600_000);
    if (value.kind === 'review-watch' && value.source !== 'communication' && value.source !== 'pull-request') invalid();
  } else if (value.kind === 'webhook') {
    sourceFields(value, ['version', 'label', 'kind', 'ingress']); const ingress = sourceObject(value.ingress); sourceFields(ingress, ['signatureHeader', 'deliveryHeader', 'eventHeader', 'algorithm', 'signaturePrefix']);
    const headers = [ingress.signatureHeader, ingress.deliveryHeader, ingress.eventHeader];
    if (headers.some(header => typeof header !== 'string' || !/^[a-z][a-z\d-]{0,63}$/.test(header)) || new Set(headers).size !== 3 || ingress.algorithm !== 'hmac-sha256') invalid();
    if (typeof ingress.signaturePrefix !== 'string' || ingress.signaturePrefix.length > 32 || /[^\x21-\x7e]/.test(ingress.signaturePrefix)) invalid();
  } else invalid();
  return value as unknown as TriggerMetadataV1;
}
export function parseCampaignTriggerInputV1(input: unknown): CampaignTriggerInputV1 {
  const value = json(input); sourceFields(value, ['version', 'candidates', 'truncated']); if (value.version !== 1 || typeof value.truncated !== 'boolean') invalid();
  const seen = new Set<string>();
  for (const input of items(value.candidates)) {
    const candidate = sourceObject(input); sourceFields(candidate, ['candidateId', 'repo', 'campaignId', 'phaseId', 'taskId', 'attempt', 'workflowRef', 'title', 'mode', 'createdAt']);
    for (const key of ['candidateId', 'campaignId', 'phaseId', 'taskId']) sourceText(candidate[key], 256);
    const id = String(candidate.candidateId); if (seen.has(id)) invalid(); seen.add(id);
    parseTaskRepo(candidate.repo); integer(candidate.attempt); parseCampaignTriggerWorkflowRefV1(candidate.workflowRef); text(candidate.title, 4096, true); date(candidate.createdAt);
    if (candidate.mode !== 'ticket' && candidate.mode !== 'freeform') invalid();
  }
  return value as unknown as CampaignTriggerInputV1;
}
export function parseCampaignTriggerChoiceV1(input: unknown): CampaignTriggerChoiceV1 | null {
  if (input === null) return null; const value = json(input, 4096); sourceFields(value, ['candidateId']); sourceText(value.candidateId, 256); return value as unknown as CampaignTriggerChoiceV1;
}
export function parseTriggerReviewDetailInputV1(input: unknown): TriggerReviewDetailInputV1 {
  const value = json(input, 4096); sourceFields(value, ['repo', 'number']); parseTaskRepo(value.repo); integer(value.number); return value as unknown as TriggerReviewDetailInputV1;
}
export function parseTriggerReviewTargetV1(input: unknown): TriggerReviewTargetV1 | null {
  if (input === null) return null; const value = json(input, 32 * 1024); sourceFields(value, ['targetId', 'repo', 'number', 'headSha', 'title', 'url', 'status', 'draft']);
  sourceText(value.targetId, 256); parseTaskRepo(value.repo); integer(value.number); text(value.title, 4096); url(value.url);
  if (typeof value.headSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value.headSha) || !['open', 'closed', 'merged'].includes(String(value.status)) || typeof value.draft !== 'boolean') invalid();
  return value as unknown as TriggerReviewTargetV1;
}
export function parseTriggerMessageBatchV1(input: unknown): TriggerMessageBatchV1 {
  const value = json(input); sourceFields(value, ['items', 'complete']); if (typeof value.complete !== 'boolean') invalid(); const seen = new Set<string>();
  for (const input of items(value.items)) {
    const message = sourceObject(input); sourceFields(message, ['eventId', 'channelId', 'ts', 'permalink', 'author', 'prUrls']); const id = sourceText(message.eventId, 256);
    if (seen.has(id)) invalid(); seen.add(id); sourceText(message.channelId, 256); if (parseTriggerCursorV1(message.ts) === null) invalid(); url(message.permalink, true); text(message.author, 512, true);
    if (!Array.isArray(message.prUrls) || message.prUrls.length > TRIGGER_LIMITS_V1.urls) invalid(); message.prUrls.forEach(value => sourceText(value, 4096));
  }
  return value as unknown as TriggerMessageBatchV1;
}
export function parseTriggerRequestedBatchV1(input: unknown): TriggerRequestedBatchV1 {
  const value = json(input); sourceFields(value, ['items', 'quality', 'truncated']); const seen = new Set<string>();
  if (!['complete', 'partial', 'degraded'].includes(String(value.quality)) || typeof value.truncated !== 'boolean' || value.quality === 'complete' && value.truncated) invalid();
  for (const input of items(value.items)) { const item = parseTriggerReviewDetailInputV1(input); const key = `${item.repo.toLowerCase()}#${item.number}`; if (seen.has(key)) invalid(); seen.add(key); }
  return value as unknown as TriggerRequestedBatchV1;
}
export function parseReviewTriggerInputV1(input: unknown): ReviewTriggerInputV1 {
  const value = json(input, 4096); sourceFields(value, ['version', 'activatedAt', 'cursor', 'defaultWorkflowRef']); if (value.version !== 1) invalid(); date(value.activatedAt); parseTriggerCursorV1(value.cursor); parseTriggerWorkflowRefV1(value.defaultWorkflowRef); return value as unknown as ReviewTriggerInputV1;
}
export function parseReviewTriggerResultV1(input: unknown): ReviewTriggerResultV1 {
  const value = json(input, TRIGGER_LIMITS_V1.proposalBytes); sourceFields(value, ['proposals', 'nextCursor', 'complete']); if (typeof value.complete !== 'boolean') invalid(); parseTriggerCursorV1(value.nextCursor); const seen = new Set<string>();
  for (const input of items(value.proposals)) {
    const proposal = sourceObject(input); sourceFields(proposal, ['eventId', 'targetId', 'workflowRef', 'sourceUrl', 'author', 'channelName']); if (proposal.eventId !== null) sourceText(proposal.eventId, 256);
    sourceText(proposal.targetId, 256); parseTriggerWorkflowRefV1(proposal.workflowRef); url(proposal.sourceUrl, true); text(proposal.author, 512, true); text(proposal.channelName, 512, true);
    const key = JSON.stringify([proposal.eventId, proposal.targetId]); if (seen.has(key)) invalid(); seen.add(key);
  }
  return value as unknown as ReviewTriggerResultV1;
}
export function parseWebhookTriggerInputV1(input: unknown): WebhookTriggerInputV1 {
  const value = json(input); sourceFields(value, ['version', 'deliveryId', 'event', 'body']); if (value.version !== 1 || typeof value.deliveryId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value.deliveryId)) invalid(); sourceText(value.event, 128); sourceJson(value.body, 1024 * 1024); return value as unknown as WebhookTriggerInputV1;
}
export function parseWebhookTriggerResultV1(input: unknown): WebhookTriggerResultV1 | null {
  if (input === null) return null; const value = json(input, TRIGGER_LIMITS_V1.proposalBytes); sourceFields(value, ['workflowRef', 'intent']); parseTriggerWorkflowRefV1(value.workflowRef);
  const intent = sourceObject(value.intent); sourceFields(intent, ['mode', 'repo', 'title', ...(intent.mode === 'review' ? ['prNumber'] : ['task'])]); parseTaskRepo(intent.repo); text(intent.title, 1000);
  if (intent.mode === 'review') integer(intent.prNumber); else if (intent.mode === 'freeform') text(intent.task, 100_000); else invalid(); return value as unknown as WebhookTriggerResultV1;
}
