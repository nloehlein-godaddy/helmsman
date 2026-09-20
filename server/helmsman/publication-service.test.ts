// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { openDb, type RunRow } from './db';
import { openExecutionStore } from './execution-store';
import { legacyExecutionSnapshot } from './legacy-execution-snapshot';
import { openOperationStore } from './operations';
import { openPersistence, type Persistence } from './persistence';
import { createPublicationService, type PublicationCommand } from './publication-service';
import { createRunArtifactStore } from './artifacts';
import type { AgentTask } from './agents/adapter';
import type { PublicationRequest } from './publication-client';

const databases: Persistence[] = [];
const roots: string[] = [];
afterEach(async () => { databases.splice(0).forEach(db => db.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const request: PublicationRequest = { version: 1, kind: 'pre-pr', approved: { baseSha, headSha, branch: 'agent/run', baseBranch: 'main', round: 1, reviewers: ['codex', 'claude-code'], metadata: { stage: 'implement', round: 0 } } };
const scope = { repo: 'org/repo', branch: 'agent/run', readOnly: false };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-test-')); roots.push(root);
  await mkdir(join(root, 'objects'));
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const db = openDb(persistence.sql);
  const executions = openExecutionStore(persistence);
  const operations = openOperationStore(persistence, executions);
  const config = loadConfig({ GITHUB_TOKEN: 'github-secret', GITHUB_REPO: 'org/repo', GITHUB_PR_AUTHOR: 'actor' });
  const task: AgentTask = { repo: 'org/repo', ticketId: 'TASK-1', title: 'Implement', jiraBaseUrl: '', task: 'Implement the feature' };
  const row: RunRow = { id: 'run', repo: task.repo, ticketId: task.ticketId, adapter: 'pre-pr:codex', attempt: 1, status: 'running', startedAt: '2026-09-20T00:00:00Z', endedAt: null, prNumber: null, costUsd: null, worktreePath: root, taskJson: JSON.stringify(task) };
  db.insertRun(row);
  const artifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
  executions.prepare({ snapshot: legacyExecutionSnapshot({ run: row, task, artifact, host: 'detached', config }), launchId: 'launch', maxConcurrency: 1,
    paths: { worktree: root, log: '/run.log', exit: '/run.exit', spec: '/run.json' } });
  const artifacts = createRunArtifactStore(join(root, '.artifacts'));
  await artifacts.write({ runId: 'run', stage: 'implement', round: 0 }, JSON.stringify({ title: '[TASK-1] Improve behavior', body: 'The change.' }));
  for (const reviewer of request.approved.reviewers) await artifacts.write({ runId: 'run', stage: 'review', round: 1, reviewer }, JSON.stringify({ baseSha, headSha, verdict: 'APPROVE', summary: 'Approved.', findings: [] }));
  const remote = { sha: null as string | null, dirty: false, localHead: headSha, actor: 'actor', url: 'git@github.com:org/repo.git', base: baseSha,
    losePush: false, losePr: false, stopped: false, stopDuringTransportSetup: false, stopAtObservation: 0, observations: 0, clarified: true, pr: null as null | { number: number; body: string; title: string } };
  const command = vi.fn<PublicationCommand>(async (cmd, args, context) => {
    context.signal.throwIfAborted();
    if (cmd === 'git') {
      if (args[0] === 'init') { await mkdir(join(args.at(-1)!, 'objects/info'), { recursive: true }); return ''; }
      if (args.includes('--git-path')) { if (remote.stopDuringTransportSetup) remote.stopped = true; return join(root, 'objects'); }
      if (args.includes('push')) { remote.sha = headSha; if (remote.losePush) throw new Error('lost push receipt'); return ''; }
      if (args[0] === 'rev-parse') return remote.localHead;
      if (args[0] === 'symbolic-ref') return scope.branch;
      if (args[0] === 'status') return remote.dirty ? ' M changed.ts' : '';
      if (args[0] === 'merge-base') return args[1] === '--is-ancestor' ? '' : remote.base;
      if (args[0] === 'remote') return args.length === 1 ? 'origin' : remote.url;
      if (args.includes('ls-remote')) {
        remote.observations++;
        if (remote.stopAtObservation === remote.observations) remote.stopped = true;
        return remote.sha ? `${remote.sha}\trefs/heads/${scope.branch}` : '';
      }
    }
    if (cmd === 'gh') {
      if (args[0] === 'api') return JSON.stringify({ login: remote.actor });
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: scope.repo, defaultBranchRef: { name: 'main' } });
      if (args[1] === 'list' || args[1] === 'view') {
        const pr = remote.pr ? { ...remote.pr, headRefName: scope.branch, headRefOid: headSha, baseRefName: 'main', state: 'OPEN', headRepositoryOwner: { login: 'org' } } : null;
        return JSON.stringify(args[1] === 'list' ? pr ? [pr] : [] : pr);
      }
      if (args[1] === 'create' || args[1] === 'edit') {
        const body = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
        remote.pr = { number: 12, body, title: args[1] === 'create' ? args[args.indexOf('--title') + 1]! : remote.pr!.title };
        if (remote.losePr) throw new Error('lost PR receipt');
        return 'https://github.com/org/repo/pull/12';
      }
    }
    throw new Error(`Unexpected command ${cmd} ${args.join(' ')}`);
  });
  const options = { persistence, operations, executions, runsDir: root, getRun: db.getRun, currentConfig: () => config, verifyArtifacts: vi.fn(async () => {}),
    clarificationReady: () => remote.clarified, isStopped: () => remote.stopped, command };
  return { root, db, operations, executions, config, artifacts, remote, command, options, service: createPublicationService(options),
    publish: () => createPublicationService(options).publish('run', scope, request, AbortSignal.timeout(3000)),
    writes: () => command.mock.calls.filter(([cmd, args]) => cmd === 'git' && args.includes('push') || cmd === 'gh' && ['create', 'edit'].includes(args[1] ?? '')) };
}

describe('core publication outbox', () => {
  it('publishes reviewed exact revisions through pinned operations without persisting credentials', async () => {
    const f = await fixture();
    expect(await f.publish()).toEqual({ ok: true, prNumber: 12 });
    expect(f.operations.list().map(item => [item.kind, item.status])).toEqual([['git.push', 'completed'], ['github.pr-create', 'completed']]);
    expect(f.writes()).toHaveLength(2);
    expect(JSON.stringify(f.operations.list())).not.toContain('github-secret');
    const pushed = f.operations.byKey('run:1:publication:push')!;
    expect(f.operations.byKey('run:1:publication:pr')?.dependencies).toEqual([pushed.id]);
    await f.publish();
    expect(f.writes()).toHaveLength(2);
  });

  it.each(['push', 'create', 'edit'] as const)('reconciles %s applied before acknowledgment after service restart without resending', async kind => {
    const f = await fixture();
    if (kind === 'edit') f.remote.pr = { number: 12, title: 'Existing title', body: 'Existing user body' };
    f.remote.losePush = kind === 'push'; f.remote.losePr = kind !== 'push';
    await expect(f.publish()).rejects.toThrow('uncertain');
    expect(f.operations.list().some(item => item.status === 'uncertain')).toBe(true);
    expect(await f.publish()).toEqual({ ok: true, prNumber: 12 });
    expect(f.writes()).toHaveLength(2);
    if (kind === 'edit') expect(f.remote.pr?.body).toContain('Existing user body');
  });

  it.each(['dirty', 'head', 'base', 'actor', 'remote', 'stopped', 'clarification', 'review-set'] as const)('blocks %s gate changes before any external write', async change => {
    const f = await fixture();
    if (change === 'dirty') f.remote.dirty = true;
    if (change === 'head') f.remote.localHead = 'c'.repeat(40);
    if (change === 'base') f.remote.base = 'c'.repeat(40);
    if (change === 'actor') f.remote.actor = 'other';
    if (change === 'remote') f.remote.url = 'git@github.com:other/repo.git';
    if (change === 'stopped') f.remote.stopped = true;
    if (change === 'clarification') f.remote.clarified = false;
    const input = change === 'review-set' ? { ...request, approved: { ...request.approved, reviewers: ['codex'] as const } } : request;
    await expect(f.service.publish('run', scope, input, AbortSignal.timeout(3000))).rejects.toThrow();
    expect(f.writes()).toEqual([]);
  });

  it('blocks stop arriving during isolated transport preparation before the push command', async () => {
    const f = await fixture();
    f.remote.stopDuringTransportSetup = true;
    await expect(f.publish()).rejects.toThrow();
    expect(f.remote.stopped).toBe(true);
    expect(f.writes()).toEqual([]);
  });

  it('blocks stop arriving during the final remote observation immediately before push', async () => {
    const f = await fixture();
    f.remote.stopAtObservation = 3;
    await expect(f.publish()).rejects.toThrow();
    expect(f.remote.observations).toBe(3);
    expect(f.remote.stopped).toBe(true);
    expect(f.writes()).toEqual([]);
  });

  it('rejects tampered immutable review evidence and unadmitted scoped pushes', async () => {
    const f = await fixture();
    await expect(f.service.push('run', scope, headSha)).rejects.toThrow('No approved');
    await writeFile(join(f.root, '.artifacts/run/review.1.codex.artifact'), '{}');
    await expect(f.publish()).rejects.toThrow('checksum');
    expect(f.operations.list()).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it('retains the original connection and requires restoration after defaults change', async () => {
    const f = await fixture();
    f.remote.losePush = true;
    await expect(f.publish()).rejects.toThrow('uncertain');
    const before = f.operations.list();
    f.config.github = { ...f.config.github!, author: 'replacement' };
    await expect(f.publish()).rejects.toThrow('recorded GitHub connection');
    expect(f.operations.list()).toEqual(before);
    expect(f.writes()).toHaveLength(1);
  });

  it('reconciles an old attempt from retained paths after the current run advances', async () => {
    const f = await fixture();
    f.remote.losePush = true;
    await expect(f.publish()).rejects.toThrow('uncertain');
    f.db.updateRun('run', { attempt: 2, worktreePath: '/new-worktree' });
    await f.service.drainPending('run');
    expect(f.operations.byKey('run:1:publication:push')?.status).toBe('completed');
    expect(f.writes()).toHaveLength(1);
    expect(f.command.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'remote').every(([, , options]) => options.cwd === f.root)).toBe(true);
  });

  it('allows read-only reconciliation after stop while blocking new publication', async () => {
    const f = await fixture();
    f.remote.losePush = true;
    await expect(f.publish()).rejects.toThrow('uncertain');
    f.remote.stopped = true;
    await f.service.drainPending('run');
    expect(f.operations.byKey('run:1:publication:push')?.status).toBe('completed');
    expect(f.operations.byKey('run:1:publication:pr')).toBeNull();
    expect(f.writes()).toHaveLength(1);
  });
});
