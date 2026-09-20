import type { ProviderBinding } from './execution-store';
import type { OperationAdapter, OperationContext } from './operation-dispatcher';
import type { DurableOperation, OperationResult } from './operations';
import { isGithubRepo } from '../pr-lists';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const unknown = (reason: string): OperationResult => ({ status: 'unknown', reason, evidence: { code: 'publication-unconfirmed' } });
const blocked = (reason: string): OperationResult => ({ status: 'definitely-not-applied', retryable: false, reason, evidence: { code: 'publication-conflict' } });

export interface PushTarget { repo: string; remote: string; branch: string; }
export interface PushPayload { headSha: string; expectedRemoteSha: string | null; baseSha: string; }
export interface PushObservation extends PushTarget { headSha: string | null; }

export function createPushOperationAdapter(options: {
  binding: ProviderBinding;
  readRemote(target: PushTarget, context: OperationContext): Promise<PushObservation>;
  push(target: PushTarget, payload: PushPayload, context: OperationContext): Promise<void>;
  authorize: NonNullable<OperationAdapter['authorize']>;
}): OperationAdapter {
  function input(operation: DurableOperation) {
    const target = object(operation.target);
    const payload = object(operation.payload);
    if (!target || !payload || !text(target.repo) || !isGithubRepo(target.repo) || !text(target.remote) || !text(target.branch)
      || !sha(payload.headSha) || !sha(payload.baseSha) || payload.expectedRemoteSha !== null && !sha(payload.expectedRemoteSha)) throw new Error('Invalid immutable push target');
    return { target: { repo: target.repo, remote: target.remote, branch: target.branch },
      payload: { headSha: payload.headSha, baseSha: payload.baseSha, expectedRemoteSha: payload.expectedRemoteSha } };
  }
  async function observe(target: PushTarget, context: OperationContext) {
    const value = await options.readRemote(target, context);
    if (!value || value.repo !== target.repo || value.remote !== target.remote || value.branch !== target.branch
      || value.headSha !== null && !sha(value.headSha)) throw new Error('Remote ref observation does not match the pinned target');
    return value;
  }
  const receipt = (value: PushObservation): OperationResult => ({ status: 'acknowledged', receipt: { ...value } });
  return {
    kind: 'git.push', binding: options.binding, delivery: 'reconcile', authorize: options.authorize,
    async reconcile(operation, context) {
      try {
        const { target, payload } = input(operation);
        const observed = await observe(target, context);
        return observed.headSha === payload.headSha ? receipt(observed) : unknown('Remote ref does not prove delivery of the prior push.');
      } catch { return unknown('The pinned remote ref could not be verified.'); }
    },
    async invoke(operation, context) {
      let attempted = false;
      try {
        const { target, payload } = input(operation);
        const prior = await observe(target, context);
        if (prior.headSha === payload.headSha) return receipt(prior);
        if (prior.headSha !== payload.expectedRemoteSha) return blocked('Remote branch changed since push admission.');
        const authorization = await options.authorize(operation, context);
        if (!authorization?.allowed) return blocked(authorization?.reason ?? 'Publication authorization was revoked.');
        const latest = await observe(target, context);
        if (latest.headSha === payload.headSha) return receipt(latest);
        if (latest.headSha !== payload.expectedRemoteSha) return blocked('Remote branch changed during publication authorization.');
        context.signal.throwIfAborted();
        attempted = true;
        await options.push(target, payload, context);
        const observed = await observe(target, context);
        return observed.headSha === payload.headSha ? receipt(observed) : unknown('Push returned without the approved remote revision.');
      } catch { return attempted ? unknown('Push may have reached the remote; reconcile before retrying.') : blocked('The approved local revision or pinned remote is unavailable.'); }
    },
  };
}

export interface PullRequestTarget { repo: string; branch: string; base: string; headSha: string; prNumber: number | null; }
export interface PullRequestPayload { body: string; title: string | null; expectedBody: string | null; }
export interface PullRequestObservation extends Omit<PullRequestTarget, 'prNumber'> { prNumber: number; body: string; title: string; }

export function createPullRequestOperationAdapter(options: {
  binding: ProviderBinding; kind: 'github.pr-create' | 'github.pr-edit';
  inspect(target: PullRequestTarget, context: OperationContext): Promise<PullRequestObservation | null>;
  publish(target: PullRequestTarget, payload: PullRequestPayload, context: OperationContext): Promise<void>;
  authorize: NonNullable<OperationAdapter['authorize']>;
}): OperationAdapter {
  function input(operation: DurableOperation) {
    const target = object(operation.target);
    const payload = object(operation.payload);
    if (!target || !payload || !text(target.repo) || !isGithubRepo(target.repo) || !text(target.branch) || !text(target.base) || !sha(target.headSha)
      || (options.kind === 'github.pr-create' ? target.prNumber !== null : !positive(target.prNumber))
      || typeof payload.body !== 'string' || payload.title !== null && !text(payload.title) || payload.expectedBody !== null && typeof payload.expectedBody !== 'string'
      || options.kind === 'github.pr-create' && !text(payload.title) || options.kind === 'github.pr-edit' && typeof payload.expectedBody !== 'string') throw new Error('Invalid immutable PR publication target');
    return { target: { repo: target.repo, branch: target.branch, base: target.base, headSha: target.headSha, prNumber: target.prNumber as number | null },
      payload: { body: payload.body, title: payload.title as string | null, expectedBody: payload.expectedBody as string | null } };
  }
  async function observe(target: PullRequestTarget, context: OperationContext) {
    const value = await options.inspect(target, context);
    if (value !== null && (!value || value.repo !== target.repo || value.branch !== target.branch || value.base !== target.base || value.headSha !== target.headSha
      || !positive(value.prNumber) || target.prNumber !== null && value.prNumber !== target.prNumber
      || typeof value.body !== 'string' || typeof value.title !== 'string')) throw new Error('Existing PR differs from the pinned publication identity');
    return value;
  }
  const matches = (value: PullRequestObservation | null, payload: PullRequestPayload) => value !== null && value.body === payload.body && (payload.title === null || value.title === payload.title);
  const receipt = (value: PullRequestObservation): OperationResult => ({ status: 'acknowledged', receipt: { ...value } });
  return {
    kind: options.kind, binding: options.binding, delivery: 'reconcile', authorize: options.authorize,
    async reconcile(operation, context) {
      try {
        const { target, payload } = input(operation);
        const value = await observe(target, context);
        return value && matches(value, payload) ? receipt(value) : unknown('No matching PR proves delivery; an earlier publication may still be in flight.');
      } catch { return unknown('Pinned PR publication cannot be reconciled.'); }
    },
    async invoke(operation, context) {
      let attempted = false;
      try {
        const { target, payload } = input(operation);
        const prior = await observe(target, context);
        if (prior && matches(prior, payload)) return receipt(prior);
        if (options.kind === 'github.pr-create' ? prior !== null : prior === null || prior.body !== payload.expectedBody) return blocked('Existing PR conflicts with the admitted publication.');
        const authorization = await options.authorize(operation, context);
        if (!authorization?.allowed) return blocked(authorization?.reason ?? 'Publication authorization was revoked.');
        const latest = await observe(target, context);
        if (latest && matches(latest, payload)) return receipt(latest);
        if (options.kind === 'github.pr-create' ? latest !== null : latest === null || latest.body !== payload.expectedBody) return blocked('Existing PR changed during publication authorization.');
        context.signal.throwIfAborted();
        attempted = true;
        await options.publish(target, payload, context);
        const value = await observe(target, context);
        return value && matches(value, payload) ? receipt(value) : unknown('Publication returned without a matching PR receipt.');
      } catch { return attempted ? unknown('PR publication may have reached GitHub; reconcile before retrying.') : blocked('Pinned PR state or approved revision is unavailable.'); }
    },
  };
}
