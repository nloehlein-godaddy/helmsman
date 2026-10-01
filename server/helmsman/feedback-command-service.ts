import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { parseFeedbackCommandV1, parseFeedbackDestinationV1, parseFeedbackReceiptQueryV1, parseFeedbackReceiptV1, type FeedbackCommandV1, type FeedbackDestinationV1, type FeedbackReceiptQueryV1, type FeedbackReceiptV1 } from '../../src/plugins/feedback-command';
import { FEEDBACK_MARKER_TOKEN, type FeedbackTrackerPlanV1, type FeedbackSubmissionV1, type FeedbackTrackerProviderV1, type FeedbackHttpV1 } from '../../src/plugins/feedback-tracker';
import type { PluginJson } from '../../src/plugins/backend';
import { isContributionId } from '../../src/plugins/manifest';
import { clarificationObject, clarificationFields } from '../../src/plugins/clarification-validation';
import { dispatchOperation, type OperationResolver, type OperationContext } from './operation-dispatcher';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import type { DurableOperation, OperationStore, OperationResult } from './operations';
import { persistedJson, persistenceHash, stableJson, PersistenceConflictError, PersistenceValidationError, type Persistence } from './persistence';
import { ClarificationServiceError, clarificationScope } from './clarification-service-common';

export interface FeedbackProviderCapture {
  readonly binding: ProviderBinding; readonly artifacts: readonly ArtifactBinding[]; readonly settings: Readonly<Record<string, PluginJson>>;
  readonly provider: FeedbackTrackerProviderV1; assertCurrent(): void;
}
export interface FeedbackCommandOptions {
  persistence: Persistence; operations: OperationStore; repos(): readonly string[]; authorize(caller: string): void;
  capture(): FeedbackProviderCapture | null;
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  http(binding: ProviderBinding, signal: AbortSignal, mutation: boolean): FeedbackHttpV1;
  retained(operation: DurableOperation, settings: Readonly<Record<string, PluginJson>>, signal: AbortSignal): Promise<{ provider: FeedbackTrackerProviderV1; dispose(): Promise<void> }>;
  authorizeDelivery(operation: DurableOperation, context: OperationContext): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}
const kind = 'feedback.submit'; const origin = 'public-feedback';
const key = (caller: string, requestId: string) => `public-feedback:${persistenceHash({ caller, requestId })}`;
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
function plan(value: unknown): FeedbackTrackerPlanV1 {
  const data = clarificationObject(value); clarificationFields(data, ['destination', 'target', 'request']);
  const destination = clarificationObject(data.destination); clarificationFields(destination, ['id', 'label', 'url']);
  const parsed = parseFeedbackDestinationV1({ ...destination, revision: 'a'.repeat(64) });
  const request = clarificationObject(data.request); clarificationFields(request, ['method', 'path', 'query', 'body']);
  if (request.method !== 'POST' || typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//') || request.path.length > 2048
    || /[\\%?#\x00-\x20]/.test(request.path) || request.path.split('/').some(part => part === '.' || part === '..')) throw new PersistenceValidationError('Invalid feedback request plan');
  const query = clarificationObject(request.query);
  if (Object.keys(query).length !== 0) throw new PersistenceValidationError('Feedback create query must be empty');
  const body = persistedJson(request.body); const raw = JSON.stringify(body);
  if (raw.split(FEEDBACK_MARKER_TOKEN).length !== 2) throw new PersistenceValidationError('Feedback request requires exactly one marker');
  return { destination: { id: parsed.id, label: parsed.label, url: parsed.url }, target: persistedJson(data.target), request: { method: 'POST', path: request.path, query: {}, body } };
}
function retained(operation: DurableOperation) {
  const payload = clarificationObject(operation.payload); const command = parseFeedbackCommandV1(payload.command); const caller = payload.caller;
  if (typeof caller !== 'string' || !isContributionId(caller) || operation.kind !== kind || operation.origin.kind !== origin
    || operation.key !== key(caller, command.requestId) || operation.origin.id !== command.requestId || operation.origin.revision !== persistenceHash({ caller, command })
    || operation.origin.runId !== null || operation.origin.attempt !== null || operation.binding.capability !== 'helmsman/feedback-tracker') throw new PersistenceValidationError('Feedback operation integrity failed');
  const target = clarificationObject(operation.target); clarificationFields(target, ['repo', 'providerTarget']);
  if (target.repo !== command.context.repo) throw new PersistenceValidationError('Feedback recovery scope changed');
  const prepared = plan(target.providerTarget); const settings = clarificationObject(payload.settings) as Readonly<Record<string, PluginJson>>;
  const destination = { ...prepared.destination, revision: persistenceHash({ binding: operation.binding, settings, destination: prepared.destination }) };
  if (!same(destination, command.expectedDestination)) throw new PersistenceValidationError('Feedback destination changed');
  return { caller, command, plan: prepared, settings };
}
function project(operation: DurableOperation): FeedbackReceiptV1 {
  const { command } = retained(operation); const { requestId, ...input } = command;
  const base = { version: 1, requestId, input, result: null, reason: null };
  if (operation.status === 'completed') return parseFeedbackReceiptV1({ ...base, status: 'succeeded', result: operation.receipt }, command);
  if (operation.status === 'blocked' && !operation.requiresReconciliation && operation.diagnostic?.code === 'delivery-blocked') return parseFeedbackReceiptV1({ ...base, status: 'rejected', reason: operation.diagnostic.message.slice(0, 2000) }, command);
  return parseFeedbackReceiptV1({ ...base, status: operation.requiresReconciliation || ['blocked', 'uncertain'].includes(operation.status) ? 'recovery-required' : 'pending',
    reason: operation.diagnostic?.message?.slice(0, 2000) ?? null }, command);
}
export function createFeedbackCommandService(options: FeedbackCommandOptions) {
  const access = (caller: string, repo: string | null, scope: string | null) => {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden'); options.authorize(caller);
    if (repo !== null) clarificationScope(options.repos(), scope, repo);
    else if (scope !== null) throw new ClarificationServiceError(403, 'forbidden');
  };
  const find = (caller: string, query: FeedbackReceiptQueryV1) => {
    const operation = options.operations.byKey(key(caller, query.requestId));
    if (operation) { const saved = retained(operation); if (saved.caller !== caller || saved.command.context.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found'); }
    return operation;
  };
  const resolve: OperationResolver = async (operation, signal) => {
    if (operation.kind !== kind || operation.origin.kind !== origin) return null;
    const saved = retained(operation); await options.verifyArtifacts(operation.artifacts); signal.throwIfAborted();
    const execute = async (mode: 'invokeSubmission' | 'reconcileSubmission', live: DurableOperation, context: OperationContext): Promise<OperationResult> => {
      const loaded = await options.retained(live, saved.settings, context.signal);
      try {
        const marker = `helmsman-feedback:${live.id}:${live.contentHash}`;
        const expected = { ...saved.plan.request, body: JSON.parse(JSON.stringify(saved.plan.request.body).replace(FEEDBACK_MARKER_TOKEN, marker)) as PluginJson };
        const upstream = options.http(live.binding, context.signal, mode === 'invokeSubmission'); let sent = false;
        const http: FeedbackHttpV1 = { async request(raw) {
          context.signal.throwIfAborted(); const request = persistedJson(raw) as unknown as Parameters<FeedbackHttpV1['request']>[0];
          if (request.method !== 'GET') {
            if (mode !== 'invokeSubmission' || sent || !same(request, expected)) throw new Error('Feedback provider attempted an unbound or duplicate mutation');
            const authorization = await options.authorizeDelivery(live, context); context.signal.throwIfAborted();
            if (!authorization.allowed) throw new Error(authorization.reason); sent = true;
          }
          return upstream.request(request);
        } };
        const input: FeedbackSubmissionV1 = { id: live.id, contentHash: live.contentHash, input: saved.command, plan: saved.plan, request: expected };
        const result = await loaded.provider[mode](input, { signal: context.signal, http }); context.signal.throwIfAborted();
        if (result?.status === 'acknowledged') {
          const receipt = parseFeedbackReceiptV1({ version: 1, requestId: saved.command.requestId, input: (() => { const { requestId: _id, ...rest } = saved.command; return rest; })(), status: 'succeeded', result: result.receipt, reason: null }, saved.command);
          return { status: 'acknowledged', receipt: persistedJson(receipt.result) };
        }
        if (result?.status !== 'definitely-not-applied' && result?.status !== 'unknown') throw new Error('Invalid feedback tracker result');
        if (typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 4000 || result.evidence === null) throw new Error('Invalid feedback tracker evidence');
        return { ...result, ...(result.status === 'definitely-not-applied' ? { retryable: false } : {}), evidence: persistedJson(result.evidence) };
      } finally { await loaded.dispose(); }
    };
    return { binding: operation.binding, kind, delivery: 'reconcile', authorize: options.authorizeDelivery,
      invoke: (live, context) => execute('invokeSubmission', live, context), reconcile: (live, context) => execute('reconcileSubmission', live, context) };
  };
  const dispatch = (id: string) => dispatchOperation(options.operations, id, resolve, { reconcile: true });
  return {
    resolve, dispatch,
    async destination(caller: string): Promise<FeedbackDestinationV1 | null> {
      options.authorize(caller); const capture = options.capture(); if (!capture) return null;
      await options.verifyArtifacts(capture.artifacts); capture.assertCurrent();
      const signal = AbortSignal.timeout(15000);
      const value = await clarificationAbortable(capture.provider.destination({ signal, http: options.http(capture.binding, signal, false) }), signal);
      capture.assertCurrent(); if (!value) return null;
      return parseFeedbackDestinationV1({ ...value, revision: persistenceHash({ binding: capture.binding, settings: capture.settings, destination: value }) });
    },
    async submit(caller: string, raw: FeedbackCommandV1, scope: string | null): Promise<FeedbackReceiptV1> {
      const command = parseFeedbackCommandV1(raw); access(caller, command.context.repo, scope);
      const query = { requestId: command.requestId, repo: command.context.repo }; const exists = find(caller, query);
      if (exists) { if (!same(retained(exists).command, command)) throw new PersistenceConflictError('Feedback request content changed'); return project(await dispatch(exists.id)); }
      const capture = options.capture(); if (!capture) throw new ClarificationServiceError(503, 'service-unavailable');
      await options.verifyArtifacts(capture.artifacts); capture.assertCurrent();
      const signal = AbortSignal.timeout(15000);
      const prepared = plan(await clarificationAbortable(capture.provider.prepareSubmission(command, { signal, http: options.http(capture.binding, signal, false) }), signal));
      const destination = { ...prepared.destination, revision: persistenceHash({ binding: capture.binding, settings: capture.settings, destination: prepared.destination }) };
      if (!same(destination, command.expectedDestination)) throw new PersistenceConflictError('Feedback destination changed');
      const operation = options.persistence.transaction(() => {
        access(caller, command.context.repo, scope); capture.assertCurrent(); const prior = find(caller, query);
        if (prior) { if (!same(retained(prior).command, command)) throw new PersistenceConflictError('Feedback request content changed'); return prior; }
        return options.operations.enqueue({ version: 1, key: key(caller, command.requestId), kind,
          origin: { kind: origin, id: command.requestId, revision: persistenceHash({ caller, command }), runId: null, attempt: null },
          binding: capture.binding, artifacts: capture.artifacts, target: persistedJson({ repo: command.context.repo, providerTarget: prepared }), payload: persistedJson({ caller, command, settings: capture.settings }) });
      });
      return project(await dispatch(operation.id));
    },
    receipt(caller: string, raw: FeedbackReceiptQueryV1, scope: string | null) { const query = parseFeedbackReceiptQueryV1(raw); access(caller, query.repo, scope); const operation = find(caller, query); return operation ? project(operation) : null; },
    async retry(caller: string, raw: FeedbackCommandV1, scope: string | null) {
      const command = parseFeedbackCommandV1(raw); access(caller, command.context.repo, scope); const operation = find(caller, { requestId: command.requestId, repo: command.context.repo });
      if (!operation) throw new ClarificationServiceError(404, 'not-found');
      if (!same(retained(operation).command, command)) throw new PersistenceConflictError('Feedback request content changed');
      return project(await dispatch(operation.id));
    },
    async drainPending() { for (const operation of options.operations.list({ statuses: ['pending', 'retrying', 'leased', 'blocked', 'uncertain'] })) if (operation.origin.kind === origin) await dispatch(operation.id); },
  };
}
export type FeedbackCommandServerService = ReturnType<typeof createFeedbackCommandService>;
