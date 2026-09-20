import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import { agentAttribution, appendAgentByline } from './agent-attribution';
import { createRunArtifactStore } from './artifacts';
import type { RunRow } from './db';
import type { ArtifactBinding, ExecutionSnapshot, ExecutionStore } from './execution-store';
import { dispatchOperation, type OperationAdapter, type OperationResolver } from './operation-dispatcher';
import { createPullRequestOperationAdapter, createPushOperationAdapter, type PullRequestObservation, type PullRequestTarget, type PushTarget } from './operation-publication';
import type { DurableOperation, OperationStore } from './operations';
import { persistedJson, persistenceHash, stableJson, type Persistence } from './persistence';
import { githubRepository, parsePrMetadata } from './pre-pr-runtime';
import { parsePrePrReview } from './pre-pr-workflow';
import { parsePublicationRequest, type PublicationRequest, type PublicationResponse } from './publication-client';
import type { GatewayScope } from './scoped-gateway';

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const kinds = new Set(['git.push', 'github.pr-create', 'github.pr-edit']);
export interface PublicationCommand { (cmd: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<string>; }
export interface PublicationServiceOptions {
  persistence: Persistence; operations: OperationStore; executions: ExecutionStore; runsDir: string;
  getRun(runId: string): RunRow | null;
  currentConfig(): AppConfig;
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  clarificationReady(runId: string): boolean;
  isStopped(runId: string): boolean;
  command?: PublicationCommand;
}

export function createPublicationService(options: PublicationServiceOptions) {
  const { operations, executions } = options;
  const artifacts = createRunArtifactStore(join(options.runsDir, '.artifacts'));
  const command: PublicationCommand = options.command ?? (async (cmd, args, context) => (await exec(cmd, [...args], { ...context, timeout: 25_000, maxBuffer: 1024 * 1024 })).stdout.trim());
  let draining: Promise<void> | null = null;
  function saved(runId: string, attempt?: number) {
    const row = options.getRun(runId);
    if (!row) throw new Error('Recorded publication run is unavailable');
    const execution = executions.attempt({ runId, attempt: attempt ?? row.attempt });
    const snapshot = execution && executions.snapshot(execution.snapshotId);
    const worktree = execution?.paths.worktree;
    if (!snapshot || snapshot.repo !== row.repo || !worktree || snapshot.attempt === row.attempt && worktree !== row.worktreePath) throw new Error('Publication execution identity is unavailable');
    const binding = snapshot.bindings.find(item => item.role === 'effect' && item.capability === 'github');
    const github = options.currentConfig().github;
    if (!binding || !github || binding.connectionId !== persistenceHash({ host: 'api.github.com', author: github.author })) throw new Error('Restore the recorded GitHub connection before publication');
    const run = (cmd: string, args: readonly string[], signal: AbortSignal) => command(cmd, args, { cwd: worktree, env: { ...process.env, GH_TOKEN: github.token, GITHUB_TOKEN: github.token, GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' }, signal });
    return { row, snapshot, binding, github, run, worktree };
  }
  async function proof(snapshot: ExecutionSnapshot, request: PublicationRequest) {
    const approval = request.approved;
    const policy = object(object(snapshot.settings.execution)?.prePr);
    const task = object(snapshot.task);
    const writer = snapshot.bindings.find(item => item.role === 'agent')?.contributionId.replace(/^pre-pr:/, '');
    if (!policy || approval.reviewers.length !== policy.reviewerCount || !Number.isSafeInteger(policy.maxRounds) || approval.round > Number(policy.maxRounds)
      || !writer || !approval.reviewers.includes(writer as 'codex' | 'claude-code') || task?.review || task?.prBranch) throw new Error('Publication review set differs from the retained policy');
    const metadataIdentity = { runId: snapshot.runId, ...approval.metadata };
    const metadata = parsePrMetadata(JSON.parse(Buffer.from(await artifacts.read(metadataIdentity)).toString()), task as unknown as AgentTask);
    const manifests = [await artifacts.verify(metadataIdentity)];
    for (const reviewer of approval.reviewers) {
      const identity = { runId: snapshot.runId, stage: 'review', round: approval.round, reviewer };
      const report = parsePrePrReview(JSON.parse(Buffer.from(await artifacts.read(identity)).toString()), approval);
      if (report.verdict !== 'APPROVE' || report.findings.length !== 0) throw new Error('Publication requires unanimous exact-revision approval');
      manifests.push(await artifacts.verify(identity));
    }
    return { metadata, manifests };
  }
  function assertCurrent(state: ReturnType<typeof saved>, scope: GatewayScope, request: PublicationRequest): void {
    const current = options.getRun(state.row.id);
    const approval = request.approved;
    if (!current || current.attempt !== state.snapshot.attempt || current.worktreePath !== state.worktree || current.status !== 'running'
      || options.isStopped(current.id) || !options.clarificationReady(current.id) || scope.readOnly || scope.repo !== state.snapshot.repo
      || scope.branch !== approval.branch || approval.branch === approval.baseBranch) throw new Error('Publication authorization is unavailable');
  }
  async function liveGate(runId: string, scope: GatewayScope, request: PublicationRequest, signal: AbortSignal, remote?: string, actor?: string) {
    const state = saved(runId);
    const approval = request.approved;
    assertCurrent(state, scope, request);
    await options.verifyArtifacts(state.snapshot.artifacts);
    const evidence = await proof(state.snapshot, request);
    const git = (args: readonly string[]) => state.run('git', args, signal);
    if (await git(['rev-parse', 'HEAD']) !== approval.headSha || await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== approval.branch
      || await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Approved publication worktree changed');
    await git(['merge-base', '--is-ancestor', approval.baseSha, approval.headSha]);
    const repository = object(JSON.parse(await state.run('gh', ['repo', 'view', state.snapshot.repo, '--json', 'nameWithOwner,defaultBranchRef'], signal)));
    if (repository?.nameWithOwner?.toString().toLowerCase() !== state.snapshot.repo.toLowerCase() || object(repository?.defaultBranchRef)?.name !== approval.baseBranch
      || await git(['merge-base', approval.headSha, 'FETCH_HEAD']) !== approval.baseSha) throw new Error('Approved base revision changed');
    if (remote) {
      const urls = (await git(['remote', 'get-url', '--push', '--all', remote])).split('\n');
      if (urls.length !== 1 || githubRepository(urls[0] ?? '') !== state.snapshot.repo.toLowerCase()) throw new Error('Pinned GitHub push remote changed');
    }
    const user = object(JSON.parse(await state.run('gh', ['api', 'user'], signal)));
    if (!text(user?.login) || actor && user.login !== actor || user.login.toLowerCase() !== state.github.author.toLowerCase()) throw new Error('Authenticated GitHub actor differs from the recorded connection');
    signal.throwIfAborted();
    assertCurrent(state, scope, request);
    return { ...state, ...evidence, actor: user.login };
  }
  async function inspect(state: ReturnType<typeof saved>, target: PullRequestTarget, signal: AbortSignal): Promise<PullRequestObservation | null> {
    const fields = 'number,headRefName,headRefOid,baseRefName,body,title,state,headRepositoryOwner';
    const args = target.prNumber === null ? ['pr', 'list', '--repo', target.repo, '--head', target.branch, '--state', 'open', '--json', fields]
      : ['pr', 'view', String(target.prNumber), '--repo', target.repo, '--json', fields];
    const raw: unknown = JSON.parse(await state.run('gh', args, signal));
    const rows = target.prNumber === null ? raw : [raw];
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Ambiguous pull request identity');
    if (rows.length === 0) return null;
    const value = object(rows[0]);
    if (!value || !Number.isSafeInteger(value.number) || Number(value.number) < 1 || value.state !== 'OPEN' || value.headRefName !== target.branch
      || value.baseRefName !== target.base || value.headRefOid !== target.headSha || typeof value.body !== 'string' || typeof value.title !== 'string'
      || object(value.headRepositoryOwner)?.login?.toString().toLowerCase() !== target.repo.split('/')[0]?.toLowerCase()) throw new Error('Pull request differs from the approved repository and revision');
    return { ...target, prNumber: Number(value.number), body: value.body, title: value.title };
  }
  async function remoteHead(state: ReturnType<typeof saved>, target: PushTarget, signal: AbortSignal) {
    const urls = (await state.run('git', ['remote', 'get-url', '--push', '--all', target.remote], signal)).split('\n');
    if (urls.length !== 1 || githubRepository(urls[0] ?? '') !== target.repo.toLowerCase()) throw new Error('Push remote identity changed');
    const output = await state.run('git', ['ls-remote', '--heads', urls[0]!, `refs/heads/${target.branch}`], signal);
    if (!output) return null;
    const match = /^([a-f\d]{40}(?:[a-f\d]{24})?)\s+refs\/heads\/(.+)$/.exec(output);
    if (!match || match[2] !== target.branch) throw new Error('Remote branch identity unavailable');
    return match[1]!;
  }
  const resolve: OperationResolver = async (operation, signal) => {
    if (!kinds.has(operation.kind) || !operation.origin.runId || !operation.origin.attempt) return null;
    const state = saved(operation.origin.runId, operation.origin.attempt);
    if (operation.origin.id !== state.snapshot.id || operation.origin.revision !== state.snapshot.contentHash || stableJson(operation.binding) !== stableJson(state.binding)
      || stableJson(operation.artifacts) !== stableJson([...state.snapshot.artifacts].sort((a, b) => a.pluginId.localeCompare(b.pluginId)))) return null;
    await options.verifyArtifacts(operation.artifacts);
    const payload = object(operation.payload);
    const target = object(operation.target);
    const request = parsePublicationRequest(payload?.approval);
    if (!text(target?.actor) || target.repo !== state.snapshot.repo || target.branch !== request.approved.branch) return null;
    const scope = { repo: state.snapshot.repo, branch: request.approved.branch, readOnly: false };
    const authorize: NonNullable<OperationAdapter['authorize']> = async (_operation, context) => {
      try {
        if (state.snapshot.attempt !== options.getRun(state.row.id)?.attempt) throw new Error('Publication attempt is no longer current');
        const evidence = await liveGate(state.row.id, scope, request, context.signal, typeof target.remote === 'string' ? target.remote : undefined, target.actor as string);
        if (stableJson(evidence.manifests) !== stableJson(payload?.proof)) throw new Error('Approval artifacts changed');
        return { allowed: true };
      } catch { return { allowed: false, reason: 'Approved revision, identity, artifacts, or publication gate changed.' }; }
    };
    signal.throwIfAborted();
    if (operation.kind === 'git.push') return createPushOperationAdapter({ binding: operation.binding, authorize,
      async readRemote(pinned, context) { return { ...pinned, headSha: await remoteHead(state, pinned, context.signal) }; },
      async push(pinned, approved, context) { assertCurrent(state, scope, request); await state.run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f', '-c', 'core.hooksPath=/dev/null', 'push', '--', `https://github.com/${pinned.repo}.git`, `${approved.headSha}:refs/heads/${pinned.branch}`], context.signal); } });
    return createPullRequestOperationAdapter({ binding: operation.binding, kind: operation.kind as 'github.pr-create' | 'github.pr-edit', authorize,
      inspect: (pinned, context) => inspect(state, pinned, context.signal),
      async publish(pinned, content, context) {
        const root = await mkdtemp(join(tmpdir(), 'helmsman-publication-'));
        try {
          const file = join(root, 'body.md');
          await writeFile(file, content.body, { mode: 0o600, flag: 'wx' });
          const args = pinned.prNumber === null
            ? ['pr', 'create', '--repo', pinned.repo, '--head', pinned.branch, '--base', pinned.base, '--title', content.title!, '--body-file', file]
            : ['pr', 'edit', String(pinned.prNumber), '--repo', pinned.repo, '--body-file', file];
          assertCurrent(state, scope, request);
          await state.run('gh', args, context.signal);
        } finally { await rm(root, { recursive: true, force: true }); }
      } });
  };
  async function complete(operation: DurableOperation) {
    const result = await dispatchOperation(operations, operation.id, resolve, { reconcile: true, timeoutMs: 60_000 });
    if (result.status !== 'completed') throw new Error(`Publication ${result.kind} is ${result.status}; reconcile its retained operation before retrying`);
    return result;
  }
  async function publish(runId: string, scope: GatewayScope, supplied: PublicationRequest, signal: AbortSignal): Promise<PublicationResponse> {
    const request = parsePublicationRequest(supplied);
    const initial = saved(runId);
    const prefix = `${runId}:${initial.row.attempt}:publication`;
    let pushed = operations.byKey(`${prefix}:push`);
    if (pushed && stableJson(object(pushed.payload)?.approval) !== stableJson(request)) throw new Error('A different revision already owns this publication attempt');
    const evidence = await liveGate(runId, scope, request, signal, undefined, text(object(pushed?.target)?.actor) ? String(object(pushed?.target)?.actor) : undefined);
    const origin = { kind: 'run-publication', id: evidence.snapshot.id, revision: evidence.snapshot.contentHash, runId, attempt: evidence.row.attempt };
    const enqueue = (key: string, kind: string, target: unknown, payload: unknown, dependencies: readonly string[] = []) => operations.enqueue({ version: 1, key, kind, origin,
      binding: evidence.binding, artifacts: evidence.snapshot.artifacts, target: persistedJson(target), payload: persistedJson({ ...object(payload), approval: request, proof: evidence.manifests }), dependencies });
    if (!pushed) {
      const remotes = (await evidence.run('git', ['remote'], signal)).split('\n').filter(Boolean);
      const matches: string[] = [];
      for (const name of remotes) {
        const urls = (await evidence.run('git', ['remote', 'get-url', '--push', '--all', name], signal)).split('\n');
        if (urls.length === 1 && githubRepository(urls[0] ?? '') === scope.repo.toLowerCase()) matches.push(name);
      }
      const remote = matches.includes('origin') ? 'origin' : matches.length === 1 ? matches[0] : null;
      if (!remote) throw new Error('Cannot choose an unambiguous publication remote');
      const target = { repo: scope.repo, remote, branch: scope.branch, actor: evidence.actor };
      const expectedRemoteSha = await remoteHead(evidence, target, signal);
      pushed = enqueue(`${prefix}:push`, 'git.push', target, { headSha: request.approved.headSha, baseSha: request.approved.baseSha, expectedRemoteSha });
    }
    await complete(pushed);
    let published = operations.byKey(`${prefix}:pr`);
    if (!published) {
      const target: PullRequestTarget = { repo: scope.repo, branch: scope.branch, base: request.approved.baseBranch, headSha: request.approved.headSha, prNumber: null };
      const existing = await inspect(evidence, target, signal);
      const body = appendAgentByline(existing?.body ?? evidence.metadata.body, agentAttribution(evidence.row.adapter, object(evidence.snapshot.task) as unknown as AgentTask, 'PR author'));
      published = enqueue(`${prefix}:pr`, existing ? 'github.pr-edit' : 'github.pr-create', { ...target, prNumber: existing?.prNumber ?? null, actor: evidence.actor },
        { body, title: existing ? null : evidence.metadata.title, expectedBody: existing?.body ?? null }, [pushed.id]);
    }
    const receipt = object((await complete(published)).receipt);
    if (!Number.isSafeInteger(receipt?.prNumber) || Number(receipt?.prNumber) < 1) throw new Error('Publication receipt is unavailable');
    return { ok: true, prNumber: Number(receipt?.prNumber) };
  }
  return { publish, resolve,
    async push(runId: string, scope: GatewayScope, headSha: string, signal = AbortSignal.timeout(60_000)): Promise<void> {
      const state = saved(runId);
      const operation = operations.byKey(`${runId}:${state.row.attempt}:publication:push`);
      if (!operation || object(operation.payload)?.headSha !== headSha || object(operation.target)?.branch !== scope.branch || object(operation.target)?.repo !== scope.repo || scope.readOnly) throw new Error('No approved durable push intent exists');
      signal.throwIfAborted();
      await complete(operation);
    },
    drainPending(runId?: string): Promise<void> {
      if (draining) return draining;
      draining = (async () => {
        for (const operation of operations.list({ ...(runId ? { runId } : {}), statuses: ['pending', 'retrying', 'uncertain', 'blocked', 'leased'] })) {
          if (!kinds.has(operation.kind)) continue;
          await dispatchOperation(operations, operation.id, resolve, { reconcile: true, timeoutMs: 60_000 });
        }
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}
