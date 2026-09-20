// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginJson } from '../../src/plugins/backend';
import type { JiraConfig } from '../config';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openOperationStore } from './operations';
import { createJiraOperationAdapter, readJiraOperationTarget } from './operation-jira';
import { createCopilotOperationAdapter, createGithubReviewOperationAdapter } from './operation-github';
import { createPullRequestOperationAdapter, createPushOperationAdapter, type PullRequestObservation } from './operation-publication';
import { createQueueProjectionOperationAdapter, createSlackReviewOperationAdapter, type QueueProjectionReceipt, type SlackOperationReceipt } from './operation-queues';

const databases: Persistence[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const binding = { role: 'effect' as const, capability: 'helmsman/effect', contractVersion: 1, contributionId: 'helmsman.compat/effect', pluginId: 'helmsman.compat', artifactHash: 'a'.repeat(64), connectionId: 'connection', credentialHandle: 'credential-handle' };
const context = () => ({ signal: new AbortController().signal, idempotencyKey: 'test', generation: 1 });
const authorize = async () => ({ allowed: true as const });
function operation(kind: string, target: PluginJson, payload: PluginJson = {}) {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const store = openOperationStore(persistence, openExecutionStore(persistence));
  return store.enqueue({ version: 1, key: `run:1:${kind}`, kind, origin: { kind: 'completion', id: 'run', revision: '1', runId: 'run', attempt: 1 }, binding,
    artifacts: [{ pluginId: binding.pluginId, artifactHash: binding.artifactHash, packageVersion: '1.0.0', requires: [] }], target, payload });
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const jira: JiraConfig = { baseUrl: 'https://tenant.atlassian.net', email: 'user@example.test', apiToken: 'test-token', project: 'TASK', assignee: 'user', jql: null };
const issue = (accountId: string | null = 'prior', statusId = '1', statusName = 'Open') => ({ id: '1000', fields: { assignee: accountId === null ? null : { accountId }, status: { id: statusId, name: statusName } } });
const jiraTarget = { baseUrl: jira.baseUrl, issueId: '1000' };
const headSha = 'b'.repeat(40);
const github = { token: 'test-token', repo: 'org/repo', author: 'actor' };
const reviewTarget = { repo: 'org/repo', prNumber: 12, headSha, actor: 'actor' };

describe('publication authorization rechecks', () => {
  it.each(['jira.assign', 'github.review', 'github.copilot-review'] as const)('blocks %s when stop arrives during remote preparation', async kind => {
    let stopped = false;
    const fetcher = vi.fn(async (url: unknown) => {
      stopped = true;
      const path = String(url);
      return response(path.endsWith('/user') ? { login: 'actor' } : path.endsWith('/requested_reviewers') ? { users: [] }
        : kind === 'jira.assign' ? issue() : { head: { sha: headSha }, state: 'open', merged: false });
    }) as unknown as typeof fetch;
    const authorize = async () => stopped ? { allowed: false as const, reason: 'Stopped' } : { allowed: true as const };
    const adapter = kind === 'jira.assign' ? createJiraOperationAdapter({ binding, jira, kind, fetcher, authorize })
      : kind === 'github.review' ? createGithubReviewOperationAdapter({ binding, github, fetcher, authorize })
        : createCopilotOperationAdapter({ binding, github, fetcher, authorize });
    const op = kind === 'jira.assign' ? operation(kind, jiraTarget, { accountId: 'next', expectedAccountId: 'prior' })
      : kind === 'github.review' ? operation(kind, reviewTarget, { event: 'APPROVE', body: 'Approved' })
        : operation(kind, { ...reviewTarget, reviewer: 'copilot-pull-request-reviewer[bot]' });
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(vi.mocked(fetcher).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});

describe('Jira operation delivery', () => {
  it('resolves canonical issue identity and never treats a rejected assignment as acknowledged', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PUT' ? response({}, 403) : response(issue())) as unknown as typeof fetch;
    expect(await readJiraOperationTarget(jira, 'TASK-1', fetcher)).toMatchObject({ target: jiraTarget, accountId: 'prior', statusId: '1' });
    const op = operation('jira.assign', jiraTarget, { accountId: 'next', expectedAccountId: 'prior' });
    const adapter = createJiraOperationAdapter({ kind: 'jira.assign', binding, jira, fetcher });
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false, evidence: { httpStatus: 403 } });
  });

  it('reconciles assignment success before acknowledgment without repeating the PUT', async () => {
    let account = 'prior';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') { account = 'next'; throw new Error('connection lost after remote apply'); }
      return response(issue(account));
    }) as unknown as typeof fetch;
    const op = operation('jira.assign', jiraTarget, { accountId: 'next', expectedAccountId: 'prior' });
    const adapter = createJiraOperationAdapter({ kind: 'jira.assign', binding, jira, fetcher });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    expect(vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('refuses intervening state changes and does not infer non-delivery from an unsatisfied target', async () => {
    const fetcher = vi.fn(async () => response(issue('someone-else', '2', 'Cancelled'))) as unknown as typeof fetch;
    const op = operation('jira.transition', jiraTarget, { statusName: 'In Progress', expectedStatusId: '1' });
    const adapter = createJiraOperationAdapter({ kind: 'jira.transition', binding, jira, fetcher });
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect((await adapter.reconcile(op, context())).status).toBe('unknown');
    expect(vi.mocked(fetcher).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('guards malformed transitions and treats remote transition success as a state-setting receipt', async () => {
    let transitioned = false;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { transitioned = true; throw new Error('crash before ack'); }
      return String(url).endsWith('/transitions') ? response({ transitions: [null, { id: 't', to: { name: 'In Progress' } }] })
        : response(issue('prior', transitioned ? '2' : '1', transitioned ? 'In Progress' : 'Open'));
    }) as unknown as typeof fetch;
    const op = operation('jira.transition', jiraTarget, { statusName: 'In Progress', expectedStatusId: '1' });
    const adapter = createJiraOperationAdapter({ kind: 'jira.transition', binding, jira, fetcher });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
  });
});

describe('GitHub operation delivery', () => {
  it('reconciles a review marker bound to actor, approved SHA, and immutable payload after remote success', async () => {
    let posted: Record<string, unknown> | null = null;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/user')) return response({ login: 'actor' });
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); throw new Error('response lost'); }
      if (String(url).includes('/reviews?')) return response(posted ? [{ id: 55, commit_id: headSha, user: { login: 'actor' }, body: posted.body, submitted_at: '2026-09-20T00:00:00Z' }] : []);
      return response({ head: { sha: headSha }, state: 'open', merged: false });
    }) as unknown as typeof fetch;
    const op = operation('github.review', reviewTarget, { event: 'COMMENT', body: 'Reviewed changes', comments: [], attribution: { role: 'review agent', model: 'not reported', effort: 'not reported' } });
    const adapter = createGithubReviewOperationAdapter({ binding, github, fetcher });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect(await adapter.reconcile(op, context())).toMatchObject({ status: 'acknowledged', receipt: { reviewId: 55 } });
    expect(vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks changed actors or approved revisions before a review write', async () => {
    const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/user') ? response({ login: 'different-actor' }) : response({ head: { sha: headSha }, state: 'open' })) as unknown as typeof fetch;
    const adapter = createGithubReviewOperationAdapter({ binding, github, fetcher });
    expect(await adapter.invoke(operation('github.review', reviewTarget, { event: 'APPROVE', body: 'LGTM' }), context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(vi.mocked(fetcher).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('never interprets absent or foreign review history as safe replay', async () => {
    const fetcher = vi.fn(async () => response([{ id: 55, commit_id: headSha, user: { login: 'other' }, body: 'unrelated', submitted_at: '2026-09-20T00:00:00Z' }])) as unknown as typeof fetch;
    const adapter = createGithubReviewOperationAdapter({ binding, github, fetcher });
    expect((await adapter.reconcile(operation('github.review', reviewTarget, { event: 'COMMENT', body: 'Review' }), context())).status).toBe('unknown');
  });

  it('blocks Copilot token rotation to another authenticated actor before writing', async () => {
    const fetcher = vi.fn(async () => response({ login: 'replacement' })) as unknown as typeof fetch;
    const op = operation('github.copilot-review', { repo: 'org/repo', prNumber: 12, headSha, actor: 'actor', reviewer: 'copilot-pull-request-reviewer[bot]' });
    const adapter = createCopilotOperationAdapter({ binding, github, fetcher });
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(vi.mocked(fetcher).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('reconciles requested Copilot state and keeps a consumed or missing request uncertain', async () => {
    let requested = false;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { requested = true; throw new Error('response lost'); }
      if (String(url).endsWith('/user')) return response({ login: 'actor' });
      return String(url).endsWith('/requested_reviewers') ? response({ users: requested ? [{ login: 'copilot-pull-request-reviewer[bot]' }] : [] })
        : response({ head: { sha: headSha } });
    }) as unknown as typeof fetch;
    const op = operation('github.copilot-review', { repo: 'org/repo', prNumber: 12, headSha, actor: 'actor', reviewer: 'copilot-pull-request-reviewer[bot]' });
    const adapter = createCopilotOperationAdapter({ binding, github, fetcher });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    requested = false;
    expect((await adapter.reconcile(op, context())).status).toBe('unknown');
  });
});

describe('publication operation reconciliation', () => {
  const pushTarget = { repo: 'org/repo', remote: 'https://github.com/org/repo.git', branch: 'agent/run' };
  it('blocks PR edits when an external edit arrives during asynchronous authorization', async () => {
    const target = { repo: 'org/repo', branch: 'agent/run', base: 'main', headSha, prNumber: 12 };
    let body = 'previous';
    const publish = vi.fn(async () => {});
    const adapter = createPullRequestOperationAdapter({ binding, kind: 'github.pr-edit',
      inspect: async () => ({ ...target, body, title: 'Title' }), publish,
      authorize: async () => { body = 'human edit'; return { allowed: true }; } });
    const op = operation('github.pr-edit', target, { body: 'published', title: null, expectedBody: 'previous' });
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('reconciles a push applied before local acknowledgment and rejects changed remote refs', async () => {
    let remote: string | null = null;
    const push = vi.fn(async () => { remote = headSha; throw new Error('lost acknowledgment'); });
    const adapter = createPushOperationAdapter({ binding, authorize, readRemote: async target => ({ ...target, headSha: remote }), push });
    const op = operation('git.push', pushTarget, { headSha, baseSha: 'c'.repeat(40), expectedRemoteSha: null });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    remote = 'd'.repeat(40);
    expect(await adapter.invoke(op, context())).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect((await adapter.reconcile(op, context())).status).toBe('unknown');
    expect(push).toHaveBeenCalledOnce();
  });

  it('rechecks publication authorization immediately before pushing', async () => {
    const push = vi.fn();
    const adapter = createPushOperationAdapter({ binding, readRemote: async target => ({ ...target, headSha: null }), push,
      authorize: async () => ({ allowed: false, reason: 'Clarification gate closed' }) });
    expect(await adapter.invoke(operation('git.push', pushTarget, { headSha, baseSha: 'c'.repeat(40), expectedRemoteSha: null }), context())).toMatchObject({ status: 'definitely-not-applied' });
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['github.pr-create', 'github.pr-edit'] as const)('reconciles %s after remote success without duplicate publication', async kind => {
    const target = { repo: 'org/repo', branch: 'agent/run', base: 'master', headSha, prNumber: kind === 'github.pr-create' ? null : 12 };
    let current: PullRequestObservation | null = kind === 'github.pr-create' ? null : { ...target, prNumber: 12, body: 'old body', title: 'Title' };
    const publish = vi.fn(async () => { current = { ...target, prNumber: 12, body: 'new body', title: 'Title' }; throw new Error('lost acknowledgment'); });
    const adapter = createPullRequestOperationAdapter({ kind, binding, authorize, inspect: async () => current, publish });
    const op = operation(kind, target, { body: 'new body', title: kind === 'github.pr-create' ? 'Title' : null, expectedBody: kind === 'github.pr-edit' ? 'old body' : null });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe('existing Slack and queue bridges', () => {
  const slackTarget = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspace: 'T123', channel: 'reviews', mention: 'reviewers', repo: 'org/repo', prNumber: 12 };
  const slackReceipt = (status: SlackOperationReceipt['status']): SlackOperationReceipt => ({ ...slackTarget, channelTarget: slackTarget.channel, mentionTarget: slackTarget.mention,
    status, channel: 'reviews', mention: 'reviewers', permalink: null });
  it('adopts the existing Slack request receipt without resending uncertain delivery', async () => {
    let receipt = slackReceipt('uncertain');
    const request = vi.fn();
    const adapter = createSlackReviewOperationAdapter({ binding, currentTarget: () => slackTarget, receipt: () => receipt, request });
    const op = operation('slack.review-request', slackTarget);
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('unknown');
    receipt = slackReceipt('sent');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects changed Slack destinations rather than using current defaults', async () => {
    const request = vi.fn();
    const adapter = createSlackReviewOperationAdapter({ binding, currentTarget: () => ({ ...slackTarget, workspace: 'OTHER' }), receipt: () => null, request });
    expect((await adapter.invoke(operation('slack.review-request', slackTarget), context())).status).toBe('definitely-not-applied');
    expect(request).not.toHaveBeenCalled();
  });

  it('reuses the existing local queue projection after a crash without a second enqueue', async () => {
    let receipt: QueueProjectionReceipt | null = null;
    const project = vi.fn(async (op: ReturnType<typeof operation>) => {
      receipt = { key: op.key, content: { target: op.target, payload: op.payload }, receipt: { notificationId: 'existing-stable-id' } };
      throw new Error('crash after local queue commit');
    });
    const adapter = createQueueProjectionOperationAdapter({ kind: 'queue.created-pr-review', binding, lookup: () => receipt, project });
    const op = operation('queue.created-pr-review', { repo: 'org/repo', prNumber: 12, parentRunId: 'run' });
    expect((await adapter.invoke(op, context())).status).toBe('unknown');
    expect((await adapter.reconcile(op, context())).status).toBe('acknowledged');
    expect(project).toHaveBeenCalledOnce();
  });
});
