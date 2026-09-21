import { createHash } from 'node:crypto';
import type {
  CampaignTriggerCandidateV1, CampaignTriggerProviderV1, CommunicationReviewTriggerContextV1, CommunicationReviewTriggerProviderV1,
  PullRequestReviewTriggerContextV1, PullRequestReviewTriggerProviderV1, ReviewTriggerInputV1, ReviewTriggerProviderV1,
  TriggerMessageV1, TriggerReviewTargetV1, WebhookTriggerInputV1, WebhookTriggerProviderV1,
} from '../../src/plugins/trigger';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { persistenceHash } from './persistence';
import { boundedTriggerProvider, type TriggerRetainedProviderV1 } from './trigger-providers';
import { captureTriggerProvenanceV1, type TriggerProvenanceV1 } from './trigger-provenance';
import type { ReviewNotificationProposal } from './slack/store';

export interface SelectedTriggerCapture<T> {
  instanceId: string;
  selectionRevision: string;
  record: TriggerRetainedProviderV1;
  provider: T;
  artifacts: readonly ArtifactBinding[];
  assertCurrent(): void;
}

export interface TriggerSourceCapture {
  source: TriggerProvenanceV1['source'];
  artifacts: readonly ArtifactBinding[];
  assertCurrent(): void;
}

export interface CommunicationReviewSourceCapture extends TriggerSourceCapture {
  kind: 'communication';
  channelId: string;
  channelName: string;
  messages(input: { since: string | null }): Promise<{ items: readonly Omit<TriggerMessageV1, 'eventId'>[]; complete: boolean }>;
  detail(input: { repo: string; number: number }): Promise<Omit<TriggerReviewTargetV1, 'targetId'> | null>;
}

export interface PullRequestReviewSourceCapture extends TriggerSourceCapture {
  kind: 'pull-request';
  requested(): Promise<{ items: readonly { repo: string; number: number }[]; quality: 'complete' | 'partial' | 'degraded'; truncated: boolean }>;
  detail(input: { repo: string; number: number }): Promise<Omit<TriggerReviewTargetV1, 'targetId'> | null>;
}

export type ReviewSourceCapture = CommunicationReviewSourceCapture | PullRequestReviewSourceCapture;

export function campaignTriggerProposal(candidate: CampaignTriggerCandidateV1): Omit<CampaignTriggerCandidateV1, 'candidateId'> {
  const { candidateId: _candidateId, ...proposal } = candidate;
  return proposal;
}

function mergeArtifacts(...groups: readonly (readonly ArtifactBinding[])[]): readonly ArtifactBinding[] {
  const artifacts = new Map<string, ArtifactBinding>();
  for (const group of groups) for (const artifact of group) {
    const prior = artifacts.get(artifact.pluginId);
    if (prior && persistenceHash(prior) !== persistenceHash(artifact)) throw new Error('Trigger capture has conflicting artifacts');
    artifacts.set(artifact.pluginId, artifact);
  }
  return Object.freeze([...artifacts.values()]);
}

function handle(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertCapture<T>(capture: SelectedTriggerCapture<T>, kind: 'campaign' | 'review-watch' | 'webhook'): void {
  capture.assertCurrent();
  if (capture.record.metadata.kind !== kind) throw new Error('Selected trigger has the wrong provider kind');
}

export function runCampaignTrigger(input: {
  capture: SelectedTriggerCapture<CampaignTriggerProviderV1>;
  candidates: readonly CampaignTriggerCandidateV1[];
  truncated: boolean;
  source(candidate: CampaignTriggerCandidateV1): { source: TriggerProvenanceV1['source']; artifacts?: readonly ArtifactBinding[] };
  capturedAt: string;
  signal?: AbortSignal;
}): { candidate: CampaignTriggerCandidateV1; trigger: TriggerProvenanceV1 } | null {
  assertCapture(input.capture, 'campaign');
  input.signal?.throwIfAborted();
  const request = Object.freeze({ version: 1 as const, candidates: input.candidates, truncated: input.truncated });
  const provider = boundedTriggerProvider(input.capture.provider, input.signal) as CampaignTriggerProviderV1;
  const choice = provider.select(request);
  input.signal?.throwIfAborted();
  input.capture.assertCurrent();
  if (!choice) return null;
  const candidate = input.candidates.find(item => item.candidateId === choice.candidateId);
  if (!candidate) throw new Error('Campaign trigger selected an unobserved candidate');
  const source = input.source(candidate);
  return { candidate, trigger: captureTriggerProvenanceV1({ instanceId: input.capture.instanceId,
    selectionRevision: input.capture.selectionRevision, provider: input.capture.record,
    artifacts: mergeArtifacts(input.capture.artifacts, source.artifacts ?? []), source: source.source,
    input: request, proposal: campaignTriggerProposal(candidate), capturedAt: input.capturedAt }) };
}

export async function runReviewTrigger(input: {
  capture: SelectedTriggerCapture<ReviewTriggerProviderV1>;
  source: ReviewSourceCapture;
  activatedAt: string;
  cursor: string | null;
  defaultWorkflowRef: string;
  capturedAt: string;
  signal?: AbortSignal;
}): Promise<{ captures: readonly { proposal: ReviewNotificationProposal; trigger: TriggerProvenanceV1; event: TriggerMessageV1 | null }[]; nextCursor: string | null; complete: boolean }> {
  assertCapture(input.capture, 'review-watch');
  input.source.assertCurrent();
  if (input.capture.record.metadata.kind !== 'review-watch' || input.capture.record.metadata.source !== input.source.kind) throw new Error('Review trigger source does not match the selected provider');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Trigger scan timed out')), 30_000);
  const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
  const events = new Map<string, TriggerMessageV1>();
  const targets = new Map<string, TriggerReviewTargetV1>();
  const activatedTimestamp = Date.parse(input.activatedAt) / 1000;
  let maximumObservedTimestamp = Math.max(activatedTimestamp, Number(input.cursor ?? activatedTimestamp));
  const reviewInput: ReviewTriggerInputV1 = Object.freeze({ version: 1, activatedAt: input.activatedAt,
    cursor: input.source.kind === 'communication' ? input.cursor : null, defaultWorkflowRef: input.defaultWorkflowRef });
  const detail = async (query: { repo: string; number: number }): Promise<TriggerReviewTargetV1 | null> => {
    signal.throwIfAborted();
    const value = await input.source.detail(query);
    input.source.assertCurrent(); input.capture.assertCurrent(); signal.throwIfAborted();
    if (!value) return null;
    const target = Object.freeze({ ...value, targetId: handle([input.source.source.sourceKey, input.source.source.revision,
      value.repo.toLowerCase(), value.number, value.headSha.toLowerCase()]) });
    targets.set(target.targetId, target);
    return target;
  };
  let context: CommunicationReviewTriggerContextV1 | PullRequestReviewTriggerContextV1;
  if (input.source.kind === 'communication') {
    const source = input.source;
    context = Object.freeze({ source: 'communication' as const, signal, detail,
      messages: async (query: { since: string | null }) => {
        const batch = await source.messages(query);
        source.assertCurrent(); input.capture.assertCurrent(); signal.throwIfAborted();
        let discarded = false;
        const eligible = batch.items.filter(item => {
          const timestamp = Number(item?.ts);
          if (!item || !Number.isFinite(timestamp)) { discarded = true; return false; }
          return item.channelId === source.channelId && timestamp >= activatedTimestamp;
        }).sort((a, b) => Number(a.ts) - Number(b.ts) || a.permalink.localeCompare(b.permalink));
        if (eligible.length > 100) discarded = true;
        const items = eligible.slice(0, 100).map(item => Object.freeze({ ...item, eventId: handle([source.source.sourceKey,
          source.source.revision, item.channelId, item.ts, item.permalink]) }));
        for (const event of items) { events.set(event.eventId, event); maximumObservedTimestamp = Math.max(maximumObservedTimestamp, Number(event.ts)); }
        return { items, complete: batch.complete && !discarded };
      } });
  } else {
    const source = input.source;
    context = Object.freeze({ source: 'pull-request' as const, signal, detail,
      requested: async () => {
        const batch = await source.requested();
        source.assertCurrent(); input.capture.assertCurrent(); signal.throwIfAborted();
        return batch;
      } });
  }
  try {
    const provider = boundedTriggerProvider(input.capture.provider, signal) as ReviewTriggerProviderV1;
    const result = context.source === 'communication'
      ? await (provider as CommunicationReviewTriggerProviderV1).scan(reviewInput, context)
      : await (provider as PullRequestReviewTriggerProviderV1).scan(reviewInput, context);
    input.capture.assertCurrent(); input.source.assertCurrent(); signal.throwIfAborted();
    if (input.source.kind === 'communication') {
      if (!result.complete && result.nextCursor !== input.cursor) throw new Error('Incomplete review scan advanced its cursor');
      const prior = Number(input.cursor ?? Date.parse(input.activatedAt) / 1000);
      if (result.nextCursor !== null && Number(result.nextCursor) < prior) throw new Error('Review trigger cursor moved backwards');
      if (result.nextCursor !== null && Number(result.nextCursor) > maximumObservedTimestamp) throw new Error('Review trigger cursor advanced beyond observed messages');
    } else if (result.nextCursor !== null) throw new Error('Requested-review trigger returned a cursor');
    const artifacts = mergeArtifacts(input.capture.artifacts, input.source.artifacts);
    const captures = result.proposals.map(value => {
      const target = targets.get(value.targetId);
      const event = value.eventId === null ? null : events.get(value.eventId) ?? null;
      if (!target || input.source.kind === 'communication' && !event) throw new Error('Review trigger proposal lost its observed target');
      const proposal: ReviewNotificationProposal = Object.freeze({ ...target, eventId: value.eventId,
        workflowRef: value.workflowRef, sourceUrl: value.sourceUrl, author: value.author,
        channelName: input.source.kind === 'communication' ? input.source.channelName : value.channelName });
      const trigger = captureTriggerProvenanceV1({ instanceId: input.capture.instanceId,
        selectionRevision: input.capture.selectionRevision, provider: input.capture.record, artifacts,
        source: input.source.source, input: { reviewInput, event, target }, proposal, capturedAt: input.capturedAt });
      return Object.freeze({ proposal, trigger, event });
    });
    return Object.freeze({ captures, nextCursor: result.nextCursor, complete: result.complete });
  } finally {
    clearTimeout(timer); controller.abort();
  }
}

export function runWebhookTrigger(input: {
  capture: SelectedTriggerCapture<WebhookTriggerProviderV1>;
  source: TriggerProvenanceV1['source'];
  sourceArtifacts?: readonly ArtifactBinding[];
  request: WebhookTriggerInputV1;
  capturedAt: string;
  signal?: AbortSignal;
}): { result: ReturnType<WebhookTriggerProviderV1['parse']>; trigger: TriggerProvenanceV1 } {
  assertCapture(input.capture, 'webhook');
  input.signal?.throwIfAborted();
  const provider = boundedTriggerProvider(input.capture.provider, input.signal) as WebhookTriggerProviderV1;
  const result = provider.parse(input.request);
  input.capture.assertCurrent(); input.signal?.throwIfAborted();
  return { result, trigger: captureTriggerProvenanceV1({ instanceId: input.capture.instanceId,
    selectionRevision: input.capture.selectionRevision, provider: input.capture.record,
    artifacts: mergeArtifacts(input.capture.artifacts, input.sourceArtifacts ?? []), source: input.source,
    input: input.request, proposal: result, capturedAt: input.capturedAt }) };
}

export function triggerSource(sourceKey: string, revision: string, bindings: readonly ProviderBinding[] = []): TriggerProvenanceV1['source'] {
  return Object.freeze({ sourceKey, revision, bindings: Object.freeze([...bindings]) });
}
