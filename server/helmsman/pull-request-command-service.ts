import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { parsePullRequestCommandV1, parsePullRequestCommandReceiptQueryV1, parsePullRequestCommandReceiptV1,
  type PullRequestCommandInputV1, type PullRequestCommandV1, type PullRequestCommandReceiptV1, type PullRequestCommandReceiptQueryV1 } from '../../src/plugins/pull-request-command';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { dispatchOperation, type OperationResolver } from './operation-dispatcher';
import type { DurableOperation, OperationStore } from './operations';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface PullRequestCommandPreparation {
  readonly binding: ProviderBinding; readonly artifacts: readonly ArtifactBinding[];
  readonly target: { readonly repo: string; readonly prNumber: number; readonly headSha: string; readonly actor: string; };
}
export interface PullRequestCommandServerOptions {
  readonly persistence: Persistence; readonly operations: OperationStore;
  repos(): readonly string[];
  authorize(caller: string): void;
  assertAdmission(): void;
  prepareReview(command: PullRequestCommandInputV1, signal?: AbortSignal): Promise<PullRequestCommandPreparation>;
  readonly resolve: OperationResolver;
}
export interface PullRequestCommandServerService {
  submit(caller: string, command: PullRequestCommandV1, scopeRepo: string | null): Promise<PullRequestCommandReceiptV1>;
  receipt(caller: string, query: PullRequestCommandReceiptQueryV1, scopeRepo: string | null): PullRequestCommandReceiptV1 | null;
  retry(caller: string, query: PullRequestCommandReceiptQueryV1, scopeRepo: string | null): Promise<PullRequestCommandReceiptV1>;
  readonly resolve: OperationResolver;
  dispatch(id: string): Promise<DurableOperation>;
  drainPending(): Promise<void>;
}
const originKind = 'public-pull-request-review';
const operationKind = 'pull-request.review';
export function pullRequestCommandContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/pull-request-command' && requirement.version === 1) === true;
}
function key(caller: string, requestId: string): string { return `public-review:${persistenceHash({ caller, requestId })}`; }
function record(operation: DurableOperation): { caller: string; command: PullRequestCommandV1 } {
  const payload = operation.payload as Record<string, unknown> | null;
  const command = parsePullRequestCommandV1(payload?.command);
  const caller = payload?.caller;
  const target = operation.target as Record<string, unknown> | null;
  if (typeof caller !== 'string' || !isContributionId(caller) || operation.kind !== operationKind || operation.origin.kind !== originKind
    || operation.key !== key(caller, command.requestId) || operation.origin.id !== command.requestId
    || operation.origin.revision !== persistenceHash({ caller, command }) || operation.origin.runId !== null || operation.origin.attempt !== null
    || target?.repo !== command.repo || target?.prNumber !== command.number || target?.headSha !== command.expectedHeadSha
    || typeof target?.actor !== 'string' || !target.actor.trim() || target.actor.length > 128 || /[\x00-\x1f\x7f]/.test(target.actor)
    || payload?.event !== command.event || payload?.body !== command.body || payload?.manual !== true || payload?.expectedHeadSha !== command.expectedHeadSha) {
    throw new PersistenceValidationError('Public review operation integrity failed');
  }
  return { caller, command };
}
function project(operation: DurableOperation): PullRequestCommandReceiptV1 {
  const { command } = record(operation); const { requestId, ...input } = command;
  const base = { version: 1 as const, requestId, input, result: null };
  if (operation.status === 'completed') {
    try {
      const r = operation.receipt as Record<string, unknown> | null;
      const result = { repo: r?.repo, number: r?.number ?? r?.prNumber, headSha: r?.headSha, actor: r?.actor, reviewId: r?.reviewId };
      if (result.actor !== (operation.target as Record<string, unknown>).actor) throw new Error('Actor mismatch');
      return parsePullRequestCommandReceiptV1({ ...base, status: 'succeeded', result, reason: null }, command);
    } catch {
      return { ...base, status: 'recovery-required', reason: 'The recorded completion does not prove this review was submitted.' };
    }
  }
  const reason = operation.diagnostic?.message?.slice(0, 2000) ?? 'The recorded review requires recovery.';
  if (operation.requiresReconciliation || operation.status === 'blocked' || operation.status === 'uncertain') {
    return parsePullRequestCommandReceiptV1({ ...base, status: 'recovery-required', reason }, command);
  }
  return { ...base, status: 'pending', reason: null };
}
export function createPullRequestCommandService(options: PullRequestCommandServerOptions): PullRequestCommandServerService {
  const { operations } = options;
  function access(caller: string, repo: string, scopeRepo: string | null): void {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller); clarificationScope(options.repos(), scopeRepo, repo);
  }
  function find(caller: string, query: PullRequestCommandReceiptQueryV1): DurableOperation | null {
    const operation = operations.byKey(key(caller, query.requestId));
    if (operation) {
      const saved = record(operation);
      if (saved.caller !== caller || saved.command.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found');
    }
    return operation;
  }
  const resolve: OperationResolver = (operation, signal) => {
    if (operation.origin.kind !== originKind) return null;
    record(operation);
    return options.resolve(operation, signal);
  };
  const dispatch = (id: string) => dispatchOperation(operations, id, resolve, { reconcile: true });
  return {
    resolve, dispatch,
    async submit(caller, raw, scopeRepo) {
      const command = parsePullRequestCommandV1(raw); access(caller, command.repo, scopeRepo);
      const existing = find(caller, command);
      if (existing) {
        if (stableJson(record(existing).command) !== stableJson(command)) throw new PersistenceConflictError('Review request content changed');
        return project(await dispatch(existing.id));
      }
      options.assertAdmission();
      const { requestId, ...input } = command;
      const prepared = await options.prepareReview(input);
      const target = prepared?.target;
      if (target?.repo !== command.repo || target?.prNumber !== command.number || target?.headSha !== command.expectedHeadSha
        || typeof target?.actor !== 'string' || !target.actor.trim() || target.actor.length > 128 || /[\x00-\x1f\x7f]/.test(target.actor)) throw new PersistenceValidationError('Review preparation target changed');
      const operation = options.persistence.transaction(() => {
        access(caller, command.repo, scopeRepo); options.assertAdmission();
        const previous = find(caller, command);
        if (previous) {
          if (stableJson(record(previous).command) !== stableJson(command)) throw new PersistenceConflictError('Review request content changed');
          return previous;
        }
        return operations.enqueue({ version: 1, key: key(caller, requestId), kind: operationKind,
          origin: { kind: originKind, id: requestId, revision: persistenceHash({ caller, command }), runId: null, attempt: null },
          binding: prepared.binding, artifacts: prepared.artifacts, target: { ...target },
          payload: { caller, command: { ...command }, event: command.event, body: command.body, manual: true, expectedHeadSha: command.expectedHeadSha } });
      });
      return project(await dispatch(operation.id));
    },
    receipt(caller, raw, scopeRepo) {
      const query = parsePullRequestCommandReceiptQueryV1(raw); access(caller, query.repo, scopeRepo);
      const operation = find(caller, query); return operation ? project(operation) : null;
    },
    async retry(caller, raw, scopeRepo) {
      const query = parsePullRequestCommandReceiptQueryV1(raw); access(caller, query.repo, scopeRepo);
      const operation = find(caller, query);
      if (!operation) throw new ClarificationServiceError(404, 'not-found');
      return project(await dispatch(operation.id));
    },
    async drainPending() {
      for (const operation of operations.list({ statuses: ['pending', 'retrying', 'leased', 'blocked', 'uncertain'] })) {
        if (operation.origin.kind === originKind) await dispatch(operation.id);
      }
    },
  };
}
