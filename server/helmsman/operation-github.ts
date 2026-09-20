import type { GithubConfig } from '../config';
import { isGithubRepo } from '../pr-lists';
import { appendAgentByline, stripAgentByline, type AgentAttribution } from './agent-attribution';
import type { ProviderBinding } from './execution-store';
import { parseInlineReviewComments, publishInlineReview } from './inline-review';
import type { OperationAdapter, OperationContext } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';

const api = 'https://api.github.com';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);

export interface GithubOperationOptions { binding: ProviderBinding; github: GithubConfig; fetcher?: typeof fetch; authorize?: OperationAdapter['authorize']; }
export interface GithubReviewTarget { repo: string; prNumber: number; headSha: string; actor: string; }

function reviewTarget(operation: DurableOperation): GithubReviewTarget {
  const value = object(operation.target);
  if (!value || !text(value.repo) || !isGithubRepo(value.repo) || !positive(value.prNumber) || !sha(value.headSha) || !text(value.actor)) throw new Error('Invalid pinned GitHub review target');
  return { repo: value.repo, prNumber: value.prNumber, headSha: value.headSha, actor: value.actor };
}
function headers(github: GithubConfig): Record<string, string> {
  if (!text(github?.token)) throw new Error('GitHub credentials are unavailable');
  return { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function marker(operation: DurableOperation): string { return `<!-- helmsman-operation:${operation.id}:${operation.contentHash} -->`; }
function unconfirmed(reason: string): OperationResult { return { status: 'unknown', reason, evidence: { code: 'github-unconfirmed' } }; }
function rejected(status: number): OperationResult {
  return status >= 400 && status < 500
    ? { status: 'definitely-not-applied', retryable: status === 429, reason: `GitHub rejected the operation (${status}).`, evidence: { httpStatus: status } }
    : unconfirmed(`GitHub did not reliably acknowledge the operation (${status}).`);
}
function client(options: GithubOperationOptions, signal: AbortSignal) {
  const fetcher = options.fetcher ?? fetch;
  return async (path: string): Promise<unknown> => {
    signal.throwIfAborted();
    const response = await fetcher(`${api}${path}`, { headers: headers(options.github), signal });
    if (!response.ok) throw new Error(`GitHub lookup failed (${response.status})`);
    return response.json();
  };
}

export function createGithubReviewOperationAdapter(options: GithubOperationOptions): OperationAdapter {
  const fetcher = options.fetcher ?? fetch;
  const prefix = (target: GithubReviewTarget) => `/repos/${target.repo}/pulls/${target.prNumber}`;
  async function authorized(target: GithubReviewTarget, context: OperationContext, operation: DurableOperation): Promise<void> {
    const get = client(options, context.signal);
    const user = object(await get('/user'));
    if (!text(user?.login) || user.login.toLowerCase() !== target.actor.toLowerCase()) throw new Error('Authenticated GitHub actor differs from the recorded operation');
    const detail = object(await get(prefix(target)));
    if (object(detail?.head)?.sha !== target.headSha || detail?.state !== 'open' || detail?.merged === true) throw new Error('Pull request is no longer at its approved revision');
    const authorization = await options.authorize?.(operation, context);
    if (authorization && !authorization.allowed) throw new Error('Review publication authorization was revoked');
  }
  return {
    kind: 'github.review', binding: options.binding, delivery: 'reconcile', ...(options.authorize ? { authorize: options.authorize } : {}),
    async reconcile(operation, context) {
      try {
        const target = reviewTarget(operation);
        const get = client(options, context.signal);
        for (let page = 1; page <= 20; page++) {
          const reviews = await get(`${prefix(target)}/reviews?per_page=100&page=${page}`);
          if (!Array.isArray(reviews) || reviews.length > 100) return unconfirmed('GitHub review history is malformed.');
          const matches = reviews.flatMap(value => {
            const item = object(value);
            return positive(item?.id) && item?.commit_id === target.headSha && text(item?.body) && item.body.includes(marker(operation))
              && typeof item.submitted_at === 'string' && Number.isFinite(Date.parse(item.submitted_at))
              && typeof object(item.user)?.login === 'string' && String(object(item.user)?.login).toLowerCase() === target.actor.toLowerCase() ? [item] : [];
          });
          if (matches.length > 1) return unconfirmed('Multiple review receipts match this operation; operator reconciliation is required.');
          const match = matches[0];
          if (match) return { status: 'acknowledged', receipt: { reviewId: Number(match.id), repo: target.repo, prNumber: target.prNumber, headSha: target.headSha, actor: target.actor, marker: marker(operation) } };
          if (reviews.length < 100) return unconfirmed('No authenticated review receipt proves delivery; an earlier request may still be in flight.');
        }
        return unconfirmed('Review history exceeds the reconciliation limit.');
      } catch { return unconfirmed('Pinned GitHub review history is unavailable.'); }
    },
    async invoke(operation, context) {
      let attempted = false;
      try {
        const target = reviewTarget(operation);
        const payload = object(operation.payload);
        const manual = operation.origin.kind === 'manual-review' && payload?.manual === true;
        if (!payload || typeof payload.body !== 'string' || !text(payload.body) && !(manual && payload.event === 'APPROVE')
          || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(String(payload.event))) throw new Error('Invalid review payload');
        const comments = parseInlineReviewComments(JSON.stringify(payload.comments ?? []));
        if (payload.event !== 'COMMENT' && comments.length) throw new Error('Inline comments require a comment review');
        const attribution = (object(payload.attribution) ?? { role: 'review agent', model: 'not reported', effort: 'not reported' }) as unknown as AgentAttribution;
        const body = manual ? `${payload.body}${payload.body ? '\n\n' : ''}${marker(operation)}` : `${stripAgentByline(payload.body)}\n\n${marker(operation)}`;
        await authorized(target, context, operation);
        let reviewId: number | null = null;
        if (payload.event === 'COMMENT' && !manual) {
          const observedFetch: typeof fetch = async (input, init) => {
            context.signal.throwIfAborted();
            if (init?.method === 'POST') { await authorized(target, context, operation); attempted = true; }
            const response = await fetcher(input, { ...init, signal: AbortSignal.any([context.signal, ...(init?.signal ? [init.signal] : [])]) });
            if (init?.method === 'POST' && response.ok) {
              const posted = object(await response.clone().json().catch(() => null));
              if (positive(posted?.id)) reviewId = posted.id;
            }
            return response;
          };
          const result = await publishInlineReview(options.github, target.repo, target.prNumber, body, { headSha: target.headSha, comments, attribution }, observedFetch);
          if (!result.ok || reviewId === null) return attempted ? unconfirmed('Review submission was attempted without a reliable receipt.')
            : { status: 'definitely-not-applied', retryable: false, reason: 'Review validation prevented publication.', evidence: { code: 'review-preflight-failed' } };
        } else {
          context.signal.throwIfAborted();
          attempted = true;
          const response = await fetcher(`${api}${prefix(target)}/reviews`, { method: 'POST', headers: headers(options.github), signal: context.signal,
            body: JSON.stringify({ event: payload.event, body: manual ? body : appendAgentByline(body, attribution), commit_id: target.headSha }) });
          if (!response.ok) return rejected(response.status);
          const posted = object(await response.json());
          if (!positive(posted?.id)) return unconfirmed('GitHub returned an invalid review receipt.');
          reviewId = posted.id;
        }
        return { status: 'acknowledged', receipt: { reviewId, repo: target.repo, prNumber: target.prNumber, headSha: target.headSha, actor: target.actor, marker: marker(operation) } };
      } catch {
        return attempted ? unconfirmed('GitHub review delivery could not be confirmed.')
          : { status: 'definitely-not-applied', retryable: false, reason: 'Pinned review identity or approved revision is unavailable.', evidence: { code: 'review-preflight-failed' } };
      }
    },
  };
}

export function createCopilotOperationAdapter(options: GithubOperationOptions): OperationAdapter {
  function target(operation: DurableOperation) {
    const value = object(operation.target);
    if (!value || !text(value.repo) || !isGithubRepo(value.repo) || !positive(value.prNumber) || !sha(value.headSha)
      || !text(value.actor) || value.reviewer !== 'copilot-pull-request-reviewer[bot]') throw new Error('Invalid Copilot request target');
    return { repo: value.repo, prNumber: value.prNumber, headSha: value.headSha, actor: value.actor, reviewer: value.reviewer };
  }
  async function inspect(operation: DurableOperation, context: OperationContext) {
    const value = target(operation);
    const get = client(options, context.signal);
    const prefix = `/repos/${value.repo}/pulls/${value.prNumber}`;
    const actor = object(await get('/user'));
    if (actor?.login !== value.actor) throw new Error('Authenticated GitHub actor changed');
    const detail = object(await get(prefix));
    if (object(detail?.head)?.sha !== value.headSha) throw new Error('Pull request head changed');
    const reviewers = object(await get(`${prefix}/requested_reviewers`));
    if (!Array.isArray(reviewers?.users)) throw new Error('Invalid requested reviewers');
    return { target: value, prefix, requested: reviewers.users.some(item => object(item)?.login === value.reviewer) };
  }
  return {
    kind: 'github.copilot-review', binding: options.binding, delivery: 'reconcile', ...(options.authorize ? { authorize: options.authorize } : {}),
    async reconcile(operation, context) {
      try {
        const state = await inspect(operation, context);
        return state.requested ? { status: 'acknowledged', receipt: { ...state.target, requested: true } }
          : unconfirmed('Requested-reviewer state does not prove whether Copilot already consumed the request.');
      } catch { return unconfirmed('Copilot review request cannot be reconciled.'); }
    },
    async invoke(operation, context) {
      let attempted = false;
      try {
        const state = await inspect(operation, context);
        if (state.requested) return { status: 'acknowledged', receipt: { ...state.target, requested: true } };
        const authorization = await options.authorize?.(operation, context);
        if (authorization && !authorization.allowed) return { status: 'definitely-not-applied', retryable: false, reason: authorization.reason, evidence: { code: 'authorization-blocked' } };
        context.signal.throwIfAborted();
        attempted = true;
        const response = await (options.fetcher ?? fetch)(`${api}${state.prefix}/requested_reviewers`, { method: 'POST', headers: headers(options.github), signal: context.signal,
          body: JSON.stringify({ reviewers: [state.target.reviewer] }) });
        return response.ok ? { status: 'acknowledged', receipt: { ...state.target, httpStatus: response.status } } : rejected(response.status);
      } catch {
        return attempted ? unconfirmed('Copilot review request could not be confirmed.')
          : { status: 'definitely-not-applied', retryable: false, reason: 'Pinned pull request is unavailable.', evidence: { code: 'copilot-preflight-failed' } };
      }
    },
  };
}
