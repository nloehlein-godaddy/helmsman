// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { openDb, type RunRow } from './db';
import { openExecutionStore } from './execution-store';
import { legacyExecutionSnapshot } from './legacy-execution-snapshot';
import { authorizeRunEffect, createLegacyRunEffects, type CreatedReviewTarget } from './legacy-run-effects';
import { openOperationStore } from './operations';
import { openPersistence, type Persistence } from './persistence';
import type { AgentTask } from './agents/adapter';

const databases: Persistence[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const headSha = 'b'.repeat(40);
function fixture(taskOverrides: Partial<AgentTask> = {}) {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const db = openDb(persistence.sql);
  const executions = openExecutionStore(persistence);
  const operations = openOperationStore(persistence, executions);
  const config = loadConfig({ JIRA_BASE_URL: 'https://tenant.atlassian.net', JIRA_EMAIL: 'operator@test.invalid', JIRA_API_TOKEN: 'jira-token', BOT_ACCOUNT_ID: 'bot',
    GITHUB_TOKEN: 'github-token', GITHUB_REPO: 'org/repo', GITHUB_PR_AUTHOR: 'actor' });
  const task: AgentTask = { repo: 'org/repo', ticketId: 'TASK-1', title: 'Implement', jiraBaseUrl: config.jira!.baseUrl, ...taskOverrides };
  const row: RunRow = { id: 'run', repo: task.repo, ticketId: task.ticketId, adapter: 'codex', attempt: 1, status: 'running', startedAt: '2026-09-20T00:00:00.000Z', endedAt: null, prNumber: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(task) };
  db.insertRun(row);
  const artifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
  const attempt = executions.prepare({ snapshot: legacyExecutionSnapshot({ run: row, task, artifact, host: 'detached', config }), launchId: 'launch', maxConcurrency: 1,
    paths: { worktree: '/worktree', log: '/run.log', exit: '/run.exit', spec: '/run.json' } });
  const snapshot = executions.snapshot(attempt.snapshotId)!;
  let account = 'old';
  let status = { id: '1', name: 'Open' };
  let copilot = false;
  let failWrite = false;
  let outage = false;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (outage) throw new Error('offline');
    const path = String(url);
    if (path.includes('atlassian.net')) {
      if (init?.method === 'PUT') { account = 'bot'; if (failWrite) throw new Error('lost ack'); return new Response(null, { status: 204 }); }
      if (init?.method === 'POST') {
        const transition = JSON.parse(String(init.body)).transition.id;
        status = transition === 'progress' ? { id: '2', name: 'In Progress' } : { id: '3', name: 'In Review' };
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/transitions')) return json({ transitions: [{ id: 'progress', to: { name: 'In Progress' } }, { id: 'review', to: { name: 'In Review' } }] });
      return json({ id: '1000', fields: { assignee: { accountId: account }, status } });
    }
    if (path.endsWith('/user')) return json({ login: 'actor' });
    if (path.endsWith('/requested_reviewers')) {
      if (init?.method === 'POST') { copilot = true; return json({}); }
      return json({ users: copilot ? [{ login: 'copilot-pull-request-reviewer[bot]' }] : [] });
    }
    if (path.endsWith('/reviews') && init?.method === 'POST') return json({ id: 90 });
    return json({ head: { sha: headSha }, state: 'open', merged: false });
  }) as unknown as typeof fetch;
  const queued = new Map<string, CreatedReviewTarget & { id: string }>();
  const enqueue = vi.fn((input: CreatedReviewTarget) => { const id = `${input.parentRunId}:${input.prNumber}`; queued.set(id, { ...input, id }); return id; });
  const options = { persistence, runId: row.id, operations, executions, getRun: db.getRun, currentConfig: () => config,
    verifyArtifacts: vi.fn(async () => {}), createdReviews: { enqueue, find: (input: CreatedReviewTarget) => queued.get(`${input.parentRunId}:${input.prNumber}`) ?? null },
    authorize: async () => ({ allowed: true as const }), fetcher };
  return { persistence, db, executions, operations, config, row, snapshot, options, fetcher, enqueue,
    effects: createLegacyRunEffects(options), loseAssignmentAck: () => { failWrite = true; }, setOutage: (value: boolean) => { outage = value; } };
}

describe('legacy run effects cutover facade', () => {
  it('authorizes only current running claims/reviews and matching successful finalization', async () => {
    const data = fixture();
    await data.effects.jira.assign('TASK-1', 'bot');
    const claim = data.operations.byKey('run:1:jira.assign:claim')!;
    expect(authorizeRunEffect(claim, data.row).allowed).toBe(true);
    expect(authorizeRunEffect(claim, { ...data.row, status: 'failed' }).allowed).toBe(false);
    expect(authorizeRunEffect(claim, { ...data.row, attempt: 2 }).allowed).toBe(false);
    const finalRow = { ...data.row, status: 'succeeded' as const, prNumber: 12 };
    await data.effects.prepareFinalizationLookups(finalRow, data.snapshot);
    data.persistence.transaction(() => data.effects.prepareFinalization(finalRow, data.snapshot));
    const effects = data.operations.list().filter(operation => operation.origin.kind === 'run-finalization');
    expect(effects).toHaveLength(3);
    for (const operation of effects) {
      expect(authorizeRunEffect(operation, finalRow).allowed).toBe(true);
      expect(authorizeRunEffect(operation, { ...finalRow, prNumber: 13 }).allowed).toBe(false);
      expect(authorizeRunEffect(operation, data.row).allowed).toBe(false);
    }
    const review = fixture({ review: true, prNumber: 12, prHeadSha: headSha });
    await review.effects.postReview('org/repo', 12, 'Review', { headSha, comments: [] });
    expect(authorizeRunEffect(review.operations.list()[0]!, review.row).allowed).toBe(true);
    expect(authorizeRunEffect(review.operations.list()[0]!, { ...review.row, status: 'failed' }).allowed).toBe(false);
  });

  it('orders source claim effects and reuses a stored canonical Jira target after uncertain assignment', async () => {
    const data = fixture();
    data.loseAssignmentAck();
    await expect(data.effects.jira.assign('TASK-1', 'bot')).rejects.toThrow('uncertain');
    const assigned = data.operations.byKey('run:1:jira.assign:claim')!;
    expect(assigned.target).toEqual({ baseUrl: 'https://tenant.atlassian.net', issueId: '1000' });
    const restarted = createLegacyRunEffects(data.options);
    await restarted.jira.assign('TASK-1', 'bot');
    expect(await restarted.jira.transition('TASK-1', 'In Progress')).toBe(true);
    const transition = data.operations.byKey('run:1:jira.transition:claim')!;
    expect(transition.dependencies).toEqual([assigned.id]);
    expect(data.fetcher).toHaveBeenCalled();
    expect(vi.mocked(data.fetcher).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(data.operations.list().map(item => item.status)).toEqual(['completed', 'completed']);
  });

  it('enqueues all completion obligations with the terminal projection and rolls them back together', async () => {
    const data = fixture();
    const finalRow = { ...data.row, status: 'succeeded' as const, prNumber: 12 };
    await data.effects.prepareFinalizationLookups(finalRow, data.snapshot);
    expect(data.operations.list()).toEqual([]);
    expect(() => data.effects.prepareFinalization(finalRow, data.snapshot)).toThrow('transaction');
    expect(() => data.persistence.transaction(() => {
      data.effects.prepareFinalization(finalRow, data.snapshot);
      data.db.updateRun('run', { status: 'succeeded', prNumber: 12 });
      throw new Error('crash before final commit');
    })).toThrow('crash');
    expect(data.db.getRun('run')?.status).toBe('running');
    expect(data.operations.list()).toEqual([]);
    data.persistence.transaction(() => { data.effects.prepareFinalization(finalRow, data.snapshot); data.db.updateRun('run', { status: 'succeeded', prNumber: 12 }); });
    expect(data.operations.list().map(item => item.kind).sort()).toEqual(['github.copilot-review', 'jira.transition', 'queue.created-pr-review']);
    expect(data.enqueue).not.toHaveBeenCalled();
    await data.effects.drainPending('run');
    expect(data.operations.list().every(item => item.status === 'completed')).toBe(true);
    expect(data.enqueue).toHaveBeenCalledOnce();
  });

  it('reuses finalization targets after restart without reading current remote identities', async () => {
    const data = fixture();
    const finalRow = { ...data.row, status: 'succeeded' as const, prNumber: 12 };
    await data.effects.prepareFinalizationLookups(finalRow, data.snapshot);
    data.persistence.transaction(() => data.effects.prepareFinalization(finalRow, data.snapshot));
    const recorded = data.operations.list().map(item => ({ id: item.id, target: item.target, binding: item.binding }));
    data.setOutage(true);
    vi.mocked(data.fetcher).mockClear();
    const restarted = createLegacyRunEffects(data.options);
    await restarted.prepareFinalizationLookups(finalRow, data.snapshot);
    data.persistence.transaction(() => restarted.prepareFinalization(finalRow, data.snapshot));
    expect(data.fetcher).not.toHaveBeenCalled();
    expect(data.operations.list().map(item => ({ id: item.id, target: item.target, binding: item.binding }))).toEqual(recorded);
  });

  it('blocks a changed connection while preserving the admitted target and pins', async () => {
    const data = fixture();
    const finalRow = { ...data.row, status: 'succeeded' as const, prNumber: 12 };
    await data.effects.prepareFinalizationLookups(finalRow, data.snapshot);
    data.persistence.transaction(() => data.effects.prepareFinalization(finalRow, data.snapshot));
    const operation = data.operations.byKey('run:1:github.copilot-review:finalization')!;
    data.config.github = { ...data.config.github!, author: 'new-default' };
    vi.mocked(data.fetcher).mockClear();
    const result = await data.effects.dispatch(operation.id);
    expect(result.status).toBe('blocked');
    expect(result.binding).toEqual(operation.binding);
    expect(data.fetcher).not.toHaveBeenCalled();
    expect(data.executions.pins().some(pin => pin.kind === 'operation' && pin.ownerId === operation.id)).toBe(true);
  });

  it('posts a review through its durable marker and rejects changed payload under the same logical key', async () => {
    const data = fixture({ review: true, prNumber: 12, prHeadSha: headSha });
    const input = { headSha, comments: [] };
    expect(await data.effects.postReview('org/repo', 12, 'Review body', input)).toEqual({ ok: true });
    expect(await createLegacyRunEffects(data.options).postReview('org/repo', 12, 'Review body', input)).toEqual({ ok: true });
    expect(await data.effects.postReview('org/repo', 12, 'Changed review body', input)).toMatchObject({ ok: false });
    expect(vi.mocked(data.fetcher).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(data.operations.list()).toHaveLength(1);
  });
});
