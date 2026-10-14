import { parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectTargetV1, type PullRequestInspectTargetV1 } from '../../src/plugins/pull-request-inspect';
import type { PluginJson } from '../../src/plugins/backend';
import type { ArtifactBinding, ProviderBinding, ExecutionSnapshotInput } from './execution-store';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';
import { persistedJson, persistenceHash } from './persistence';
import { RetryError } from './retry';

export interface PullRequestSourceRecord {
  readonly binding: ProviderBinding;
  readonly revision: string;
  readonly settings: Readonly<Record<string, PluginJson>>;
  readonly artifacts: readonly ArtifactBinding[];
  readonly target: PullRequestInspectTargetV1;
}

export async function readPullRequestDetail(input: { repo: string; number: number; headSha?: string }, capture: TriggerPullRequestReadCapture) {
  capture.context.signal.throwIfAborted(); capture.assertCurrent();
  const query = parsePullRequestInspectDetailQueryV1({ version: 1, repo: input.repo, number: input.number });
  if (capture.repos && !capture.repos.includes(query.repo)) throw new Error('Pull request source scope is unavailable');
  const detail = parsePullRequestInspectDetailV1(await capture.provider.detail(query, capture.context), query);
  capture.context.signal.throwIfAborted(); capture.assertCurrent();
  if (input.headSha && detail.target.headSha !== input.headSha) throw new Error('PR changed before preparation');
  return detail;
}

export function retainPullRequestSource(capture: TriggerPullRequestReadCapture, target: PullRequestInspectTargetV1): PullRequestSourceRecord {
  capture.assertCurrent();
  return persistedJson({ binding: capture.binding, revision: capture.revision, settings: capture.settings ?? {},
    artifacts: capture.artifacts, target: parsePullRequestInspectTargetV1(target) }) as unknown as PullRequestSourceRecord;
}

export async function prepareCommunicationReview(input: { repo: string; number: number }, capture: TriggerPullRequestReadCapture) {
  const detail = await readPullRequestDetail(input, capture);
  if (detail.isOwnPr !== true || detail.status !== 'open') throw new Error('Pull request is not eligible for a review request');
  return retainPullRequestSource(capture, detail.target);
}

export async function prepareBranchUpdate(input: { repo: string; number: number; headSha?: string }, capture: TriggerPullRequestReadCapture) {
  const detail = await readPullRequestDetail({ repo: input.repo, number: input.number }, capture);
  if (input.headSha && detail.target.headSha !== input.headSha) throw new RetryError('PR changed before preparation');
  if (detail.status !== 'open') throw new RetryError('Pull request is no longer open for rerun');
  return { detail, source: retainPullRequestSource(capture, detail.target) };
}

export async function readOutcomePullRequest(input: { repo: string; number: number }, capture: TriggerPullRequestReadCapture) {
  const detail = await readPullRequestDetail(input, capture);
  const reviews = detail.reviews;
  return { draft: detail.draft, merged: detail.status === 'merged', reviewsAvailable: reviews.quality === 'complete'
    && reviews.approved !== null && reviews.changesRequested !== null && reviews.commented !== null,
    reviews: { approved: reviews.approved ?? 0, changesRequested: reviews.changesRequested ?? 0, commented: reviews.commented ?? 0 } };
}

export function pullRequestExecutionSnapshot(snapshot: ExecutionSnapshotInput, task: { pullRequestSource?: PullRequestSourceRecord }): ExecutionSnapshotInput {
  const source = task.pullRequestSource;
  if (!source) return snapshot;
  const artifacts = new Map(snapshot.artifacts.map(artifact => [artifact.pluginId, artifact]));
  for (const artifact of source.artifacts) {
    const previous = artifacts.get(artifact.pluginId);
    if (previous && persistenceHash(previous) !== persistenceHash(artifact)) throw new Error('Conflicting PR source artifact');
    artifacts.set(artifact.pluginId, artifact);
  }
  if (!artifacts.has(source.binding.pluginId) || artifacts.get(source.binding.pluginId)?.artifactHash !== source.binding.artifactHash) throw new Error('PR source artifact closure is incomplete');
  return { ...snapshot, artifacts: [...artifacts.values()], settings: { ...snapshot.settings, pullRequestSource: persistedJson(source) } };
}

export function verifyPullRequestExecution(task: { pullRequestSource?: PullRequestSourceRecord }, snapshot: ExecutionSnapshotInput): void {
  if (!task.pullRequestSource && snapshot.settings.pullRequestSource === undefined) return;
  if (!task.pullRequestSource || snapshot.settings.pullRequestSource === undefined
    || persistenceHash(task.pullRequestSource) !== persistenceHash(snapshot.settings.pullRequestSource)) throw new Error('Saved PR source differs from execution provenance');
  if (persistenceHash(pullRequestExecutionSnapshot(snapshot, task).artifacts) !== persistenceHash(snapshot.artifacts)) throw new Error('PR source artifact closure is incomplete');
}

export function parsePullRequestSource(input: unknown): PullRequestSourceRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid retained PR source');
  const value = persistedJson(input) as unknown as PullRequestSourceRecord;
  const binding = value.binding;
  if (!binding || binding.role !== 'effect' || binding.capability !== 'helmsman/pull-request' || binding.contractVersion !== 1
    || typeof binding.pluginId !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(binding.pluginId)
    || typeof binding.contributionId !== 'string' || !binding.contributionId.startsWith(`${binding.pluginId}/`)
    || !/^[a-f\d]{64}$/.test(binding.artifactHash) || typeof binding.connectionId !== 'string' || !binding.connectionId
    || typeof binding.credentialHandle !== 'string' || !binding.credentialHandle || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)
    || value.revision !== persistenceHash({ binding, settings: value.settings }) || !Array.isArray(value.artifacts)
    || !value.artifacts.some(artifact => artifact?.pluginId === binding.pluginId && artifact.artifactHash === binding.artifactHash)) throw new Error('Invalid retained PR source');
  return { ...value, target: parsePullRequestInspectTargetV1(value.target) };
}
