import type { AppConfig } from '../config';
import { isGithubRepo } from '../pr-lists';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { dispatchOperation, type OperationResolver } from './operation-dispatcher';
import { createGithubReviewOperationAdapter } from './operation-github';
import type { OperationStore } from './operations';
import { persistedJson, persistenceHash, stableJson, type Persistence } from './persistence';

export interface ManualReviewRequest { requestId: string; repo: string; prNumber: number; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string; expectedHeadSha?: string; }
export interface ManualReviewEffectsOptions {
  operations: OperationStore;
  persistence?: Persistence;
  assertAdmission?(): void;
  currentConfig(): AppConfig;
  artifact: ArtifactBinding;
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  fetcher?: typeof fetch;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const requestId = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function createManualReviewEffects(options: ManualReviewEffectsOptions) {
  const { operations } = options;
  if (options.assertAdmission && !options.persistence) throw new Error('Manual review admission checks require shared persistence');
  const fetcher = options.fetcher ?? fetch;
  let draining: Promise<void> | null = null;
  const bindingFor = (author: string): ProviderBinding => ({ role: 'effect', capability: 'github', contractVersion: 1, contributionId: 'github-publication',
    pluginId: options.artifact.pluginId, artifactHash: options.artifact.artifactHash, connectionId: persistenceHash({ host: 'api.github.com', author }), credentialHandle: 'github-primary' });
  const resolve: OperationResolver = async (operation, signal) => {
    if (operation.kind !== 'github.review' || operation.origin.kind !== 'manual-review' || operation.origin.runId !== null || operation.origin.attempt !== null) return null;
    const config = options.currentConfig().github;
    if (!config || stableJson(operation.binding) !== stableJson(bindingFor(config.author)) || stableJson(operation.artifacts) !== stableJson([options.artifact])) return null;
    const target = object(operation.target);
    const payload = object(operation.payload);
    const intent = { repo: target?.repo, prNumber: target?.prNumber, event: payload?.event, body: payload?.body, expectedHeadSha: payload?.expectedHeadSha ?? null };
    if (payload?.manual !== true || !requestId.test(operation.origin.id) || operation.key !== `manual-review:${operation.origin.id}` || operation.origin.revision !== persistenceHash(intent)) return null;
    await options.verifyArtifacts(operation.artifacts);
    signal.throwIfAborted();
    return createGithubReviewOperationAdapter({ binding: operation.binding, github: config, fetcher });
  };
  const dispatch = (id: string) => dispatchOperation(operations, id, resolve, { reconcile: true });
  return { resolve, dispatch,
    async submit(input: ManualReviewRequest): Promise<{ ok: true } | { ok: false; error: string }> {
      try {
        const body = input?.body ?? '';
        if (!input || !requestId.test(input.requestId) || !isGithubRepo(input.repo) || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1
          || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(input.event) || typeof body !== 'string' || body.length > 64_000 || body.includes('\0')
          || input.expectedHeadSha !== undefined && !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(input.expectedHeadSha)
          || input.event !== 'APPROVE' && !body.trim()) throw new Error('Invalid manual review request');
        const intent = { repo: input.repo, prNumber: input.prNumber, event: input.event, body, expectedHeadSha: input.expectedHeadSha ?? null };
        const revision = persistenceHash(intent);
        const key = `manual-review:${input.requestId}`;
        let operation = operations.byKey(key);
        if (operation) {
          if (operation.origin.kind !== 'manual-review' || operation.origin.revision !== revision) throw new Error('Review request identity already has different content');
        } else {
          options.assertAdmission?.();
          const github = options.currentConfig().github;
          if (!github) throw new Error('GitHub not configured');
          await options.verifyArtifacts([options.artifact]);
          const get = async (path: string) => {
            const response = await fetcher(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error('GitHub review identity lookup failed');
            return object(await response.json());
          };
          const [actor, pr] = await Promise.all([get('/user'), get(`/repos/${input.repo}/pulls/${input.prNumber}`)]);
          const headSha = object(pr?.head)?.sha;
          if (!text(actor?.login) || actor.login.toLowerCase() !== github.author.toLowerCase() || typeof headSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(headSha)
            || input.expectedHeadSha !== undefined && headSha !== input.expectedHeadSha || pr?.state !== 'open' || pr?.merged === true) throw new Error('Authenticated review actor or open PR revision is unavailable');
          const actorLogin = actor.login;
          const enqueue = () => {
            options.assertAdmission?.();
            return operations.enqueue({ version: 1, key, kind: 'github.review', origin: { kind: 'manual-review', id: input.requestId, revision, runId: null, attempt: null },
            binding: bindingFor(github.author), artifacts: [options.artifact], target: { repo: input.repo, prNumber: input.prNumber, headSha, actor: actorLogin }, payload: persistedJson({ event: input.event, body, manual: true, expectedHeadSha: input.expectedHeadSha ?? null }) });
          };
          operation = options.persistence ? options.persistence.transaction(enqueue) : enqueue();
        }
        const result = await dispatch(operation.id);
        return result.status === 'completed' ? { ok: true } : { ok: false, error: `Review is ${result.status}; its recorded operation must be reconciled before retrying.` };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Review publication failed' }; }
    },
    drainPending(): Promise<void> {
      if (draining) return draining;
      draining = (async () => {
        for (const operation of operations.list({ statuses: ['pending', 'retrying', 'leased', 'blocked', 'uncertain'] })) {
          if (operation.origin.kind === 'manual-review') await dispatch(operation.id);
        }
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}
