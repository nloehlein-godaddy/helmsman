import { parseProfileIdentityV1 } from '../../src/plugins/profile';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { parsePullRequestInspectDetailV1 } from '../../src/plugins/pull-request-inspect';
import { sourceFields, sourceObject, sourceText } from '../../src/plugins/source-contract-validation';
import { persistedJson, persistenceHash } from './persistence';
import type { ReviewNotificationProposal } from './slack/store';
import type { TriggerProvenanceV1 } from './trigger-provenance';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';

export interface AutomaticReviewPolicy {
  readonly version: 1;
  readonly kind: 'authenticated-pr-owner';
  readonly decision: 'own' | 'other' | 'unknown';
  readonly actorLogin: string | null;
  readonly authorLogin: string | null;
  readonly headSha: string;
  readonly providerBindingHash: string;
  readonly sourceRevision: string;
  readonly observedAt: string;
  readonly reason: string | null;
}

export interface AutomaticReviewObservation {
  readonly policy: AutomaticReviewPolicy;
  readonly blockedReason: string | null;
  assertCurrent(): void;
}

function login(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/\s/.test(value.trim())
    ? value.trim().toLowerCase() : null;
}

export function parseAutomaticReviewPolicy(input: unknown): AutomaticReviewPolicy {
  const value = sourceObject(persistedJson(input));
  sourceFields(value, ['version', 'kind', 'decision', 'actorLogin', 'authorLogin', 'headSha', 'providerBindingHash', 'sourceRevision', 'observedAt', 'reason']);
  if (value.version !== 1 || value.kind !== 'authenticated-pr-owner' || !['own', 'other', 'unknown'].includes(String(value.decision))
    || typeof value.headSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value.headSha)
    || typeof value.providerBindingHash !== 'string' || !/^[a-f\d]{64}$/.test(value.providerBindingHash)
    || value.actorLogin !== null && login(value.actorLogin) !== value.actorLogin
    || value.authorLogin !== null && login(value.authorLogin) !== value.authorLogin
    || !Number.isFinite(Date.parse(sourceText(value.observedAt, 64)))) throw new TypeError('Invalid automatic review policy');
  sourceText(value.sourceRevision, 512);
  if (value.reason !== null) sourceText(value.reason, 512);
  if (value.decision !== 'unknown' && (!value.actorLogin || !value.authorLogin
    || (value.decision === 'own') !== (value.actorLogin === value.authorLogin))) throw new TypeError('Invalid automatic review ownership');
  return Object.freeze(value) as unknown as AutomaticReviewPolicy;
}

export async function observeAutomaticReviewOwnership(input: {
  proposal: ReviewNotificationProposal;
  trigger: TriggerProvenanceV1;
  pullRequest: TriggerPullRequestReadCapture;
  source: { source: TriggerProvenanceV1['source']; assertCurrent(): void };
  assertCurrent(): void;
  now?: () => string;
}): Promise<AutomaticReviewObservation> {
  const { proposal, trigger, pullRequest, source } = input;
  const assertCurrent = () => { pullRequest.context.signal.throwIfAborted(); pullRequest.assertCurrent(); source.assertCurrent(); input.assertCurrent(); };
  assertCurrent();
  const policy = (decision: AutomaticReviewPolicy['decision'], actorLogin: string | null, authorLogin: string | null, reason: string | null, blockedReason: string | null = null): AutomaticReviewObservation => {
    assertCurrent();
    return Object.freeze({ policy: parseAutomaticReviewPolicy({ version: 1, kind: 'authenticated-pr-owner', decision, actorLogin, authorLogin,
      headSha: proposal.headSha, providerBindingHash: persistenceHash({ binding: pullRequest.binding, settings: pullRequest.settings ?? {} }),
      sourceRevision: trigger.source.revision, observedAt: input.now?.() ?? new Date().toISOString(), reason }), blockedReason, assertCurrent });
  };
  if (trigger.instanceId !== 'slack-review' || persistenceHash(proposal) !== trigger.proposalHash
    || persistenceHash(source.source) !== persistenceHash(trigger.source)) {
    const reason = 'Captured review source or proposal is no longer current';
    return policy('unknown', null, null, reason, reason);
  }
  const unknown = () => policy('unknown', null, null, 'Authenticated PR ownership is unavailable; waiting for a later check');
  if (pullRequest.repos && !pullRequest.repos.includes(proposal.repo)) {
    const reason = `Galleon ${proposal.repo} is not configured`;
    return policy('unknown', null, null, reason, reason);
  }
  try {
    const query = { version: 1 as const, repo: proposal.repo, number: proposal.number };
    const rawDetail = await clarificationAbortable(pullRequest.provider.detail(query, pullRequest.context), pullRequest.context.signal);
    assertCurrent();
    const detail = parsePullRequestInspectDetailV1(rawDetail, query);
    if (detail.target.headSha !== proposal.headSha || detail.status !== 'open' || detail.draft) {
      const reason = 'Recorded PR target changed, closed, or became a draft';
      return policy('unknown', null, login(detail.authorLogin), reason, reason);
    }
    if (typeof pullRequest.provider.profile !== 'function') return unknown();
    const rawProfile = await clarificationAbortable(pullRequest.provider.profile(pullRequest.context), pullRequest.context.signal);
    assertCurrent();
    const actorLogin = login(parseProfileIdentityV1(rawProfile).login);
    const authorLogin = login(detail.authorLogin);
    if (!actorLogin || !authorLogin) return unknown();
    if (actorLogin !== authorLogin) return policy('other', actorLogin, authorLogin, null);
    const reason = 'Automatic Slack review skipped: PR is authored by the authenticated GitHub account';
    return policy('own', actorLogin, authorLogin, reason, reason);
  } catch {
    assertCurrent();
    return unknown();
  }
}
