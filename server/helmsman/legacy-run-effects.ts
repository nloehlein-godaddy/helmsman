import type { AppConfig, GithubConfig, JiraConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { ArtifactBinding, ExecutionSnapshot, ExecutionStore, ProviderBinding } from './execution-store';
import type { InlineReviewInput } from './inline-review';
import type { JiraActions } from './jira-actions';
import { dispatchOperation, type OperationAdapter, type OperationResolver } from './operation-dispatcher';
import { createCopilotOperationAdapter, createGithubReviewOperationAdapter } from './operation-github';
import { createJiraOperationAdapter, readJiraOperationTarget } from './operation-jira';
import { createQueueProjectionOperationAdapter } from './operation-queues';
import type { DurableOperation, OperationDraft, OperationStore } from './operations';
import { persistedJson, persistenceHash, PersistenceConflictError, stableJson, type Persistence } from './persistence';

export interface CreatedReviewTarget { parentRunId: string; repo: string; prNumber: number; }
export interface LegacyRunEffectsOptions {
  persistence: Persistence;
  runId: string;
  operations: OperationStore;
  executions: ExecutionStore;
  getRun(runId: string): RunRow | null;
  currentConfig(): AppConfig;
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  createdReviews: {
    enqueue(input: CreatedReviewTarget): string;
    find(input: CreatedReviewTarget): (CreatedReviewTarget & { id: string }) | null;
  };
  authorize: NonNullable<OperationAdapter['authorize']>;
  fetcher?: typeof fetch;
}
export interface LegacyRunEffects {
  jira: JiraActions;
  postReview(repo: string, prNumber: number, body: string, input: InlineReviewInput): Promise<{ ok: true } | { ok: false; error: string }>;
  requestCopilotReview(repo: string, prNumber: number): Promise<{ ok: true } | { ok: false; error: string }>;
  enqueueCreatedPrReview(input: CreatedReviewTarget): void;
  prepareFinalizationLookups(row: RunRow, snapshot: ExecutionSnapshot): Promise<void>;
  prepareFinalization(row: RunRow, snapshot: ExecutionSnapshot): void;
  resolve: OperationResolver;
  dispatch(id: string): Promise<DurableOperation>;
  drainPending(runId?: string): Promise<void>;
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const copyDraft = (operation: DurableOperation): OperationDraft => ({ version: 1, key: operation.key, kind: operation.kind, origin: operation.origin,
  binding: operation.binding, artifacts: operation.artifacts, target: operation.target, payload: operation.payload, dependencies: operation.dependencies, retry: operation.retry });

export function authorizeRunEffect(operation: DurableOperation, row: RunRow | null): { allowed: true } | { allowed: false; reason: string } {
  const denied = { allowed: false as const, reason: 'The originating attempt or publication outcome no longer authorizes this effect.' };
  if (!row || row.id !== operation.origin.runId || row.attempt !== operation.origin.attempt) return denied;
  const target = object(operation.target);
  if (operation.origin.kind === 'run-finalization') {
    const publication = operation.kind === 'jira.transition' ? object(object(operation.payload)?.publication) : target;
    return row.status === 'succeeded' && positive(row.prNumber) && publication?.repo === row.repo && publication.prNumber === row.prNumber
      && ['jira.transition', 'github.copilot-review', 'queue.created-pr-review'].includes(operation.kind) ? { allowed: true } : denied;
  }
  if (row.status !== 'running') return denied;
  if (operation.origin.kind === 'run-claim' && ['jira.assign', 'jira.transition'].includes(operation.kind)) return { allowed: true };
  return operation.origin.kind === 'run-review' && operation.kind === 'github.review' && target?.repo === row.repo && positive(target.prNumber)
    && (row.prNumber === null || row.prNumber === target.prNumber) ? { allowed: true } : denied;
}

export function createLegacyRunEffects(options: LegacyRunEffectsOptions): LegacyRunEffects {
  const { operations, executions } = options;
  const fetcher = options.fetcher ?? fetch;
  const prepared = new Map<string, readonly OperationDraft[]>();
  let draining: Promise<void> | null = null;
  function saved(runId: string, attempt: number): ExecutionSnapshot {
    const execution = executions.attempt({ runId, attempt });
    const snapshot = execution && executions.snapshot(execution.snapshotId);
    if (!snapshot) throw new PersistenceConflictError('Recorded execution bindings are unavailable for effects');
    return snapshot;
  }
  function current(): { row: RunRow; snapshot: ExecutionSnapshot } {
    const row = options.getRun(options.runId);
    if (!row) throw new PersistenceConflictError('Run is unavailable for effects');
    return { row, snapshot: saved(row.id, row.attempt) };
  }
  function effectBinding(snapshot: ExecutionSnapshot, capability: 'jira' | 'github' | 'local'): ProviderBinding {
    const binding = capability === 'local' ? snapshot.bindings.find(item => item.role === 'workflow')
      : snapshot.bindings.find(item => item.role === 'effect' && item.capability === capability);
    if (!binding) throw new PersistenceConflictError(`Recorded ${capability} effect binding is unavailable`);
    return binding;
  }
  function credentials(binding: ProviderBinding): { jira: JiraConfig | null; github: GithubConfig | null } {
    const config = options.currentConfig();
    const jira = config.jira && binding.capability === 'jira'
      && persistenceHash({ baseUrl: config.jira.baseUrl, email: config.jira.email }) === binding.connectionId ? config.jira : null;
    const github = config.github && binding.capability === 'github'
      && persistenceHash({ host: 'api.github.com', author: config.github.author }) === binding.connectionId ? config.github : null;
    return { jira, github };
  }
  async function connection(snapshot: ExecutionSnapshot, capability: 'jira'): Promise<{ binding: ProviderBinding; jira: JiraConfig }>;
  async function connection(snapshot: ExecutionSnapshot, capability: 'github'): Promise<{ binding: ProviderBinding; github: GithubConfig }>;
  async function connection(snapshot: ExecutionSnapshot, capability: 'jira' | 'github'): Promise<{ binding: ProviderBinding; jira: JiraConfig } | { binding: ProviderBinding; github: GithubConfig }> {
    await options.verifyArtifacts(snapshot.artifacts);
    const binding = effectBinding(snapshot, capability);
    const config = credentials(binding);
    if (capability === 'jira' && config.jira) return { binding, jira: config.jira };
    if (capability === 'github' && config.github) return { binding, github: config.github };
    throw new PersistenceConflictError(`Restore the recorded ${capability} connection before preparing its operation`);
  }
  const key = (snapshot: ExecutionSnapshot, kind: string, purpose = 'finalization') => `${snapshot.runId}:${snapshot.attempt}:${kind}:${purpose}`;
  function draft(snapshot: ExecutionSnapshot, kind: string, binding: ProviderBinding, target: unknown, payload: unknown, purpose = 'finalization', dependencies: readonly string[] = []): OperationDraft {
    return { version: 1, key: key(snapshot, kind, purpose), kind,
      origin: { kind: `run-${purpose}`, id: snapshot.id, revision: snapshot.contentHash, runId: snapshot.runId, attempt: snapshot.attempt },
      binding, artifacts: snapshot.artifacts, target: persistedJson(target), payload: persistedJson(payload), dependencies };
  }
  function sameTarget(operation: DurableOperation, repo: string, prNumber: number): void {
    const target = object(operation.target);
    if (target?.repo !== repo || target?.prNumber !== prNumber) throw new PersistenceConflictError('Existing effect targets a different pull request');
  }
  async function githubState(snapshot: ExecutionSnapshot, repo: string, prNumber: number) {
    if (repo !== snapshot.repo || !positive(prNumber)) throw new PersistenceConflictError('Effect galleon or pull request is invalid');
    const { binding, github } = await connection(snapshot, 'github');
    const headers = { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json' };
    const request = async (url: string) => {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new PersistenceConflictError(`GitHub identity lookup failed (${response.status})`);
      return object(await response.json());
    };
    const [user, pr] = await Promise.all([request('https://api.github.com/user'), request(`https://api.github.com/repos/${repo}/pulls/${prNumber}`)]);
    const headSha = object(pr?.head)?.sha;
    if (!text(user?.login) || !sha(headSha) || pr?.state !== 'open' || pr?.merged === true) throw new PersistenceConflictError('Authenticated GitHub actor or open PR revision is unavailable');
    return { binding, actor: user.login, headSha };
  }
  async function jiraDraft(snapshot: ExecutionSnapshot, kind: 'jira.assign' | 'jira.transition', ticketId: string, value: string, purpose: string, publication?: { repo: string; prNumber: number }): Promise<OperationDraft> {
    const task = object(snapshot.task);
    if (task?.ticketId !== ticketId) throw new PersistenceConflictError('Jira task identity differs from the recorded task');
    const existing = operations.byKey(key(snapshot, kind, purpose));
    if (existing) {
      const payload = object(existing.payload);
      if (payload?.[kind === 'jira.assign' ? 'accountId' : 'statusName'] !== value) throw new PersistenceConflictError('Existing Jira operation has a different intended result');
      if (publication && stableJson(payload?.publication) !== stableJson(publication)) throw new PersistenceConflictError('Existing Jira finalization refers to a different publication');
      return copyDraft(existing);
    }
    const { binding, jira } = await connection(snapshot, 'jira');
    const assignment = operations.byKey(key(snapshot, 'jira.assign', 'claim'));
    const target = object(assignment?.target);
    const state = await readJiraOperationTarget(jira, text(target?.issueId) ? target.issueId : ticketId, fetcher);
    const dependency = kind === 'jira.transition' ? purpose === 'claim' ? assignment : operations.byKey(key(snapshot, 'jira.transition', 'claim')) : null;
    return draft(snapshot, kind, binding, state.target,
      kind === 'jira.assign' ? { accountId: value, expectedAccountId: state.accountId } : { statusName: value, expectedStatusId: state.statusId, ...(publication ? { publication } : {}) }, purpose, dependency ? [dependency.id] : []);
  }
  async function copilotDraft(snapshot: ExecutionSnapshot, repo: string, prNumber: number): Promise<OperationDraft> {
    const existing = operations.byKey(key(snapshot, 'github.copilot-review'));
    if (existing) { sameTarget(existing, repo, prNumber); return copyDraft(existing); }
    throw new PersistenceConflictError('New external AI reviewer requests are disabled; Helmsman reviews use GoCaaS.');
  }
  function queueDraft(snapshot: ExecutionSnapshot, input: CreatedReviewTarget): OperationDraft {
    if (input.parentRunId !== snapshot.runId || input.repo !== snapshot.repo || !positive(input.prNumber)) throw new PersistenceConflictError('Created-PR review target differs from its originating run');
    const existing = operations.byKey(key(snapshot, 'queue.created-pr-review'));
    if (existing) { sameTarget(existing, input.repo, input.prNumber); return copyDraft(existing); }
    return draft(snapshot, 'queue.created-pr-review', effectBinding(snapshot, 'local'), input, {});
  }
  const resolve: OperationResolver = async (operation, signal) => {
    const runId = operation.origin.runId;
    const attempt = operation.origin.attempt;
    if (!runId || !attempt) return null;
    const snapshot = saved(runId, attempt);
    if (operation.origin.id !== snapshot.id || operation.origin.revision !== snapshot.contentHash
      || stableJson(operation.artifacts) !== stableJson([...snapshot.artifacts].sort((a, b) => a.pluginId.localeCompare(b.pluginId)))
      || !snapshot.bindings.some(binding => stableJson(binding) === stableJson(operation.binding))) return null;
    await options.verifyArtifacts(operation.artifacts);
    signal.throwIfAborted();
    const config = credentials(operation.binding);
    if ((operation.kind === 'jira.assign' || operation.kind === 'jira.transition') && config.jira) {
      return createJiraOperationAdapter({ kind: operation.kind, binding: operation.binding, jira: config.jira, fetcher, authorize: options.authorize });
    }
    if (operation.kind === 'github.review' && config.github) return createGithubReviewOperationAdapter({ binding: operation.binding, github: config.github, fetcher, authorize: options.authorize });
    if (operation.kind === 'github.copilot-review' && config.github) return createCopilotOperationAdapter({ binding: operation.binding, github: config.github, fetcher, authorize: options.authorize });
    if (operation.kind === 'queue.created-pr-review') {
      const value = object(operation.target);
      if (!value || value.parentRunId !== runId || value.repo !== snapshot.repo || !positive(value.prNumber)) return null;
      const target: CreatedReviewTarget = { parentRunId: runId, repo: snapshot.repo, prNumber: value.prNumber };
      const receipt = () => {
        const projected = options.createdReviews.find(target);
        if (!projected) return null;
        if (projected.parentRunId !== target.parentRunId || projected.repo !== target.repo || projected.prNumber !== target.prNumber) throw new PersistenceConflictError('Created-review projection has a different target');
        return { key: operation.key, content: { target: operation.target, payload: operation.payload }, receipt: { notificationId: projected.id } };
      };
      return { ...createQueueProjectionOperationAdapter({ kind: operation.kind, binding: operation.binding, lookup: receipt,
        project() {
          options.createdReviews.enqueue(target);
          const projected = receipt();
          if (!projected) throw new PersistenceConflictError('Created-review queue did not persist its projection');
          return projected;
        } }), authorize: options.authorize };
    }
    return null;
  };
  async function dispatch(id: string): Promise<DurableOperation> {
    return dispatchOperation(operations, id, resolve, { reconcile: true });
  }
  async function completed(operation: DurableOperation): Promise<void> {
    const result = await dispatch(operation.id);
    if (result.status !== 'completed') throw new PersistenceConflictError(`Operation ${result.kind} is ${result.status}; its recorded target is preserved for recovery`);
  }
  const preparationKey = (row: RunRow, snapshot: ExecutionSnapshot) => stableJson({ snapshot: snapshot.id, runId: row.id, attempt: row.attempt, status: row.status, prNumber: row.prNumber });
  function finalizationKinds(row: RunRow, snapshot: ExecutionSnapshot) {
    if (row.id !== snapshot.runId || row.attempt !== snapshot.attempt || row.repo !== snapshot.repo || row.id !== options.runId) throw new PersistenceConflictError('Finalization differs from its recorded execution');
    const task = object(snapshot.task) as unknown as AgentTask | null;
    if (!task || task.repo !== snapshot.repo || !text(task.ticketId)) throw new PersistenceConflictError('Retained finalization task identity is invalid');
    const created = row.status === 'succeeded' && row.prNumber !== null && !task?.prBranch && !task?.review;
    return { created, task, jira: created && !task?.todoId && !task?.task && snapshot.bindings.some(binding => binding.role === 'effect' && binding.capability === 'jira'),
      github: created && operations.byKey(key(snapshot, 'github.copilot-review')) !== null };
  }
  return {
    resolve, dispatch,
    jira: {
      async assign(ticketId, accountId) {
        const { snapshot } = current();
        await completed(operations.enqueue(await jiraDraft(snapshot, 'jira.assign', ticketId, accountId, 'claim')));
      },
      async transition(ticketId, statusName) {
        const { row, snapshot } = current();
        await completed(operations.enqueue(await jiraDraft(snapshot, 'jira.transition', ticketId, statusName, row.status === 'running' ? 'claim' : 'finalization')));
        return true;
      },
    },
    async postReview(repo, prNumber, body, input) {
      try {
        const { snapshot } = current();
        const payload = persistedJson({ event: 'COMMENT', body, comments: input.comments, ...(input.attribution ? { attribution: input.attribution } : {}) });
        let operation = operations.byKey(key(snapshot, 'github.review', 'review'));
        if (operation) {
          sameTarget(operation, repo, prNumber);
          if (stableJson(operation.payload) !== stableJson(payload) || input.headSha && object(operation.target)?.headSha !== input.headSha) throw new PersistenceConflictError('Review content differs from the admitted review');
        } else {
          const state = await githubState(snapshot, repo, prNumber);
          const approvedSha = input.headSha ?? object(snapshot.task)?.prHeadSha;
          if (!sha(approvedSha) || state.headSha !== approvedSha) throw new PersistenceConflictError('PR changed since the retained review revision');
          operation = operations.enqueue(draft(snapshot, 'github.review', state.binding, { repo, prNumber, headSha: approvedSha, actor: state.actor }, payload, 'review'));
        }
        await completed(operation); return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Review publication is unavailable' }; }
    },
    async requestCopilotReview(repo, prNumber) {
      try {
        const { snapshot } = current();
        await completed(operations.enqueue(await copilotDraft(snapshot, repo, prNumber)));
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Copilot review request is unavailable' }; }
    },
    enqueueCreatedPrReview(input) { const { snapshot } = current(); operations.enqueue(queueDraft(snapshot, input)); },
    async prepareFinalizationLookups(row, snapshot) {
      const kinds = finalizationKinds(row, snapshot);
      const drafts: OperationDraft[] = [];
      if (kinds.created) drafts.push(queueDraft(snapshot, { parentRunId: row.id, repo: row.repo, prNumber: row.prNumber! }));
      if (kinds.github) drafts.push(await copilotDraft(snapshot, row.repo, row.prNumber!));
      if (kinds.jira) {
        const settings = object(snapshot.settings.execution);
        if (!text(settings?.statusInReview) || !text(kinds.task?.ticketId)) throw new PersistenceConflictError('Retained Jira finalization settings are unavailable');
        drafts.push(await jiraDraft(snapshot, 'jira.transition', kinds.task.ticketId, settings.statusInReview, 'finalization', { repo: row.repo, prNumber: row.prNumber! }));
      }
      prepared.set(preparationKey(row, snapshot), Object.freeze(drafts));
    },
    prepareFinalization(row, snapshot) {
      if (!options.persistence.sql.inTransaction) throw new PersistenceConflictError('Final operation intents must join the run finalization transaction');
      const kinds = finalizationKinds(row, snapshot);
      if (!kinds.created) return;
      const preparation = preparationKey(row, snapshot);
      const drafts = prepared.get(preparation);
      if (!drafts) {
        const expected = ['queue.created-pr-review', ...(kinds.github ? ['github.copilot-review'] : []), ...(kinds.jira ? ['jira.transition'] : [])];
        for (const kind of expected) {
          const operation = operations.byKey(key(snapshot, kind));
          if (!operation || operation.origin.id !== snapshot.id) throw new PersistenceConflictError('Prepare finalization identities before committing the run outcome');
          if (kind !== 'jira.transition') sameTarget(operation, row.repo, row.prNumber!);
        }
        return;
      }
      for (const input of drafts) operations.enqueue(input);
    },
    drainPending(runId) {
      if (draining) return draining;
      draining = (async () => {
        operations.assertDispatchAllowed();
        for (const operation of operations.list({ ...(runId ? { runId } : {}), statuses: ['pending', 'leased', 'retrying', 'blocked', 'uncertain'] })) {
          if (operation.origin.runId !== options.runId || !['jira.assign', 'jira.transition', 'github.review', 'github.copilot-review', 'queue.created-pr-review'].includes(operation.kind)) continue;
          await dispatch(operation.id);
        }
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}
