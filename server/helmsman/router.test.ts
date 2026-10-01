import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApi, type RouterDeps } from './router';
import { openTodoStore, type TodoStore } from './todos';
import { ResumeError } from './resume';
import { openDb, type RunRow } from './db';
import { createUsageQueryService } from './usage-service';
import { CapabilityResolutionError } from './plugins/backend';
import { aggregateOutcomes } from './outcomes';

const deps: RouterDeps = {
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
    latestReviewVerdict: () => null,
    latestFeedbackOutcome: () => null,
  } as unknown as RouterDeps['db'],
  canStart: (_repo: string) => ({ ok: true }),
  launch: (_body: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-0',
  stop: (_id: string) => false,
  setAutoClaim: (_repo: string, _enabled: boolean) => {},
  autoClaimRepos: () => ['o/r'],
  caps: () => ({ maxAttempts: 3, maxCostUsd: 5 }),
  getConfig: () => ({ config: { AGENT_MAX_ATTEMPTS: 1 }, overridden: ['AGENT_MAX_ATTEMPTS'], jiraTokenSet: true }),
  setConfig: (_key: string, _value: string) => ({ ok: true }),

};

describe('handleApi', () => {
  it('retires legacy clarification writes without touching compatibility state when the plugin service is absent', async () => {
    const timeoutDue = vi.fn(); const cleanupOrphans = vi.fn(); const answer = vi.fn(); const saveContact = vi.fn(); const ingestQuestion = vi.fn();
    const local = { ...deps, clarifications: { timeoutDue, cleanupOrphans, answer, saveContact, ingestQuestion } as unknown as RouterDeps['clarifications'] };
    for (const path of ['/api/clarifications', '/api/clarifications/question-1/answer', '/api/trusted-contacts']) {
      expect((await handleApi('POST', path, new URLSearchParams(), { runId: 'r1', answer: 'yes' }, local))?.status).toBe(410);
    }
    for (const mutation of [timeoutDue, cleanupOrphans, answer, saveContact, ingestQuestion]) expect(mutation).not.toHaveBeenCalled();
  });

  it('serves core usage independently of pricing activation and validates query windows', async () => {
    const usage = createUsageQueryService({ db: { runsInWindow: () => [] }, usage: { listUsage: () => [] } });
    const pricing = vi.fn(async () => { throw new CapabilityResolutionError('invalid-selection', 'Selected provider is disabled'); });
    const query = new URLSearchParams({ version: '1', repo: 'org/a', from: '2026-09-01T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' });
    const local = { ...deps, usage, pricing };
    expect(await handleApi('GET', '/api/usage/v1', query, null, local)).toMatchObject({ status: 200, json: { version: 1, repo: 'org/a', records: [], reported: { observedCostUsd: null } } });
    expect(pricing).not.toHaveBeenCalled();
    expect(await handleApi('GET', '/api/pricing/v1', query, null, local)).toEqual({ status: 503, json: { error: 'Selected provider is disabled', code: 'invalid-selection' } });
    query.set('from', 'bad');
    expect((await handleApi('GET', '/api/usage/v1', query, null, local))?.status).toBe(400);
    query.set('version', '2');
    expect((await handleApi('GET', '/api/usage/v1', query, null, local))?.status).toBe(400);
  });
  it('continues an existing voyage without creating a replacement run', async () => {
    const resumeRun = vi.fn(async () => {});
    const launch = vi.fn(deps.launch);
    const local = { ...deps, launch, resumeRun, db: { ...deps.db, getRun: () => ({ id: 'original' }) as RunRow } };
    expect(await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), { task: 'ignored' }, local))
      .toEqual({ status: 200, json: { runId: 'original' } });
    expect(resumeRun).toHaveBeenCalledExactlyOnceWith('original');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns continuation validation failures without starting a new run', async () => {
    const resumeRun = vi.fn(async () => { throw new ResumeError('Retained worktree has changed.'); });
    const local = { ...deps, resumeRun, db: { ...deps.db, getRun: () => ({ id: 'original' }) as RunRow } };
    expect(await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), null, local))
      .toEqual({ status: 409, json: { error: 'Retained worktree has changed.' } });
    expect((await handleApi('POST', '/api/agents/bad%20id/resume', new URLSearchParams(), null, local))?.status).toBe(400);
    expect((await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), null, { ...local, db: { ...local.db, getRun: () => null } }))?.status).toBe(404);
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });
  it('retires the shell-owned GitHub profile endpoint', async () => {
    expect((await handleApi('GET', '/api/github/profile', new URLSearchParams(), null, deps))?.status).toBe(410);
  });

  describe('retry failed voyages', () => {
    const failed = (extra: Partial<RunRow> = {}): RunRow => ({
      id: 'failed-run', ticketId: 'PROJ-1', repo: 'o/r', adapter: 'pre-pr:codex', status: 'failed', attempt: 1,
      prNumber: null, startedAt: '2026-09-18', endedAt: '2026-09-18', costUsd: null, worktreePath: '/old/worktree', ...extra,
    });
    const retry = (local: RouterDeps, id = 'failed-run') => handleApi('POST', `/api/agents/${id}/retry`, new URLSearchParams(), null, local);

    it('starts a fresh Jira voyage without changing failed history or reusing its process/worktree', async () => {
      const db = openDb(':memory:');
      try {
        const original = failed({ taskJson: JSON.stringify({ ticketId: 'AIROBUILD-5319', title: 'old', repo: 'o/r', model: 'gpt-5.5', effort: 'high' }) });
        db.insertRun(original);
        const before = db.getRun(original.id);
        const launch = vi.fn(() => 'fresh-run');
        const local = { ...deps, db, launch, context: () => ({ repos: ['o/r'], jiraBaseUrl: 'https://jira' }) };
        expect(await retry(local)).toEqual({ status: 200, json: { runId: 'fresh-run' } });
        expect(launch).toHaveBeenCalledExactlyOnceWith({ repo: 'o/r', adapter: 'codex', mode: 'ticket', ticketId: 'AIROBUILD-5319', model: 'gpt-5.5', effort: 'high', retryOf: original.id });
        expect(db.getRun(original.id)).toEqual(before);
      } finally { db.close(); }
    });

    it.each(['running', 'succeeded', 'stopped'] as const)('rejects %s voyages before launch', async status => {
      const launch = vi.fn();
      const local = { ...deps, launch, db: { ...deps.db, getRun: () => failed({ status }) } };
      expect(await retry(local)).toMatchObject({ status: 409, json: { error: 'Only failed voyages can be retried.' } });
      expect(launch).not.toHaveBeenCalled();
    });

    it('rejects missing IDs, removed repositories, disabled Jira, caps, and missing requirements', async () => {
      const launch = vi.fn();
      const local = { ...deps, launch, db: { ...deps.db, getRun: () => failed() } };
      expect((await retry({ ...local, db: { ...deps.db, getRun: () => null } }))?.status).toBe(404);
      expect((await retry(local, 'bad%20id'))?.status).toBe(400);
      expect((await retry({ ...local, context: () => ({ repos: [], jiraBaseUrl: null }) }))?.status).toBe(409);
      expect((await retry({ ...local, jiraEnabled: () => false }))?.status).toBe(409);
      expect(await retry({ ...local, canStart: () => ({ ok: false, reason: 'max concurrency reached' }) }))
        .toEqual({ status: 409, json: { error: 'max concurrency reached' } });
      expect((await retry({ ...local, db: { ...deps.db, getRun: () => failed({ ticketId: 'freeform' }) } }))?.status).toBe(409);
      expect(launch).not.toHaveBeenCalled();
    });

    it('retries reviews and PR updates while Jira is disabled, preserving their original semantics', async () => {
      const launch = vi.fn(() => 'fresh-run');
      for (const [mode, task] of [
        ['review', { review: true, prNumber: 3, prHeadSha: 'old-head' }],
        ['rerun', { prBranch: 'old-branch', prNumber: 3, task: 'Fix feedback' }],
      ] as const) {
        const local = { ...deps, launch, jiraEnabled: () => false, db: { ...deps.db, getRun: () => failed({ taskJson: JSON.stringify(task) }) } };
        expect((await retry(local))?.status).toBe(200);
        expect(launch).toHaveBeenLastCalledWith({ repo: 'o/r', adapter: 'codex', mode, prNumber: 3, retryOf: 'failed-run', ...(mode === 'rerun' ? { feedback: 'Fix feedback' } : {}) });
      }
    });

    it('claims only the blocked todo still owned by this failed run and prevents duplicate retries', async () => {
      const todos = openTodoStore(':memory:');
      try {
        const todo = todos.create({ title: 'Fix it', repo: 'o/r', description: 'Task requirements' });
        todos.claim(todo.id, 'failed-run');
        todos.finishRun('failed-run', 'failed');
        const launch = vi.fn<RouterDeps['launch']>(body => {
          expect(todos.claim(body.todoId!, 'fresh-run', body.retryOf)).not.toBeNull();
          return 'fresh-run';
        });
        const local = { ...deps, todos, launch, jiraEnabled: () => false, db: { ...deps.db, getRun: () => failed({ taskJson: JSON.stringify({ todoId: todo.id, task: 'old text' }) }) } };
        expect(await retry({ ...local, jiraEnabled: () => true })).toEqual({ status: 200, json: { runId: 'fresh-run' } });
        expect((await retry(local))?.status).toBe(409);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(todos.get(todo.id)).toMatchObject({ runId: 'fresh-run', state: 'in_progress' });
      } finally { todos.close(); }
    });
  });

  it('returns paginated run summaries and counts with bounded defaults', async () => {
    const row = deps.db.listRuns(1)[0]!;
    const runPage = vi.fn().mockReturnValue({ runs: [row], total: 101 });
    const historyDeps = { ...deps, db: { ...deps.db, runPage } };
    expect(await handleApi('GET', '/api/runs', new URLSearchParams(), null, historyDeps))
      .toMatchObject({ status: 200, json: { runs: [{ id: row.id }], total: 101, limit: 25, offset: 0 } });
    expect(runPage).toHaveBeenLastCalledWith(25, 0, null);
    await handleApi('GET', '/api/runs', new URLSearchParams('limit=10&offset=50&repo=owner/repo'), null, historyDeps);
    expect(runPage).toHaveBeenLastCalledWith(10, 50, 'owner/repo');
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'offset=-1', 'offset=NaN', 'offset=1e3', 'offset=9007199254740992', 'repo=../invalid'])('rejects invalid history query %s', async (query) => {
    const runPage = vi.fn();
    expect(await handleApi('GET', '/api/runs', new URLSearchParams(query), null, { ...deps, db: { ...deps.db, runPage } }))
      .toMatchObject({ status: 400 });
    expect(runPage).not.toHaveBeenCalled();
  });

  it('loads navigation context from local configuration', async () => {
    const value = { repos: ['o/r'], jiraBaseUrl: 'https://x.atlassian.net' };
    expect(await handleApi('GET', '/api/context', new URLSearchParams(), null, { ...deps, context: () => value }))
      .toEqual({ status: 200, json: value });
  });

  it('exposes external usage without generating external requests', async () => {
    const outboundUsage = vi.fn(() => ({ totals: { started: 3 } }));
    expect(await handleApi('GET', '/api/usage/external', new URLSearchParams(), null, { ...deps, outboundUsage }))
      .toEqual({ status: 200, json: { totals: { started: 3 } } });
    expect(outboundUsage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retires private feature endpoints without invoking former dependencies (services present: %s)', async servicesPresent => {
    const legacy = vi.fn(() => { throw new Error('Retired implementation must not execute'); });
    const local = { ...deps, dashboard: legacy, triage: legacy, bugs: legacy, prStatus: legacy, prDiff: legacy,
      reviewRequestedPrs: legacy, repoOpenPrs: legacy, submitReview: legacy, localGit: legacy, localGitAction: legacy,
      slackReviewRequest: legacy, campaigns: { handle: legacy }, slack: { snapshot: legacy, markRead: legacy },
      ...(servicesPresent ? { publicCampaigns: {}, publicLocalGit: {}, pullRequestCommands: {}, communication: {}, communicationCommands: {} } : {}) } as unknown as RouterDeps;
    for (const path of ['/api/dashboard', '/api/triage', '/api/bugs', '/api/pr', '/api/pr/diff', '/api/pr/open',
      '/api/pr/review-requests', '/api/pr/review', '/api/repo/local', '/api/campaigns', '/api/campaigns/example/start',
      '/api/slack/review-request', '/api/slack/notifications/known/read']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await handleApi(method, path, new URLSearchParams({ repo: 'o/r', number: '5' }), { repo: 'o/r' }, local))?.status, `${method} ${path}`).toBe(410);
      }
    }
    expect(legacy).not.toHaveBeenCalled();
  });

  it('preserves read-only Slack diagnostics without restoring notification writes', async () => {
    const snapshot = { health: { enabled: false, status: 'disabled' as const, channelName: 'reviews', intervalMs: 300000, lastSuccessAt: null, error: null }, notifications: [] };
    expect(await handleApi('GET', '/api/slack', new URLSearchParams(), null, { ...deps, slack: { snapshot: () => snapshot } })).toEqual({ status: 200, json: snapshot });
    expect(await handleApi('GET', '/api/slack', new URLSearchParams(), null, deps)).toMatchObject({ status: 200, json: { health: { enabled: false, status: 'disabled' }, notifications: [] } });
  });

  it('lists runs', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it.each([
    ['Approve', 'APPROVE'],
    ['Request changes', 'REQUEST_CHANGES'],
    ['Comment only', 'COMMENT'],
  ])('includes persisted %s recommendations on list and detail summaries', async (label, reviewOutcome) => {
    const row = { ...deps.db.listRuns(1)[0]!, status: 'succeeded' as const };
    const reviewVerdict = `Verdict: ${label} — Review result.`;
    const latestReviewVerdict = vi.fn(() => reviewVerdict);
    const listEvents = vi.fn();
    const reviewDeps = { ...deps, db: { ...deps.db, listRuns: () => [row], getRun: () => row, latestReviewVerdict, listEvents } };
    const list = await handleApi('GET', '/api/agents', new URLSearchParams(), null, reviewDeps);
    const detail = await handleApi('GET', '/api/agents/r1', new URLSearchParams(), null, reviewDeps);
    expect((list?.json as { runs: unknown[] }).runs[0]).toMatchObject({ reviewOutcome, reviewVerdict });
    expect(detail?.json).toMatchObject({ reviewOutcome, reviewVerdict });
    expect(latestReviewVerdict).toHaveBeenCalledWith('r1');
    expect(listEvents).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed', 'stopped'] as const)('does not expose a final review recommendation on a %s run', async (status) => {
    const row = { ...deps.db.listRuns(1)[0]!, status };
    const latestReviewVerdict = vi.fn(() => 'Verdict: Approve — Ready.');
    const result = await handleApi('GET', '/api/agents', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, listRuns: () => [row], latestReviewVerdict },
    });
    const summary = (result?.json as { runs: unknown[] }).runs[0];
    expect(summary).not.toHaveProperty('reviewOutcome');
    expect(summary).not.toHaveProperty('reviewVerdict');
    expect(latestReviewVerdict).not.toHaveBeenCalled();
  });

  it.each([null, '', 'Verdict: Unknown — Ready.', 'Verdict: Approve — ', 'Approve'])('omits absent or unrecognized review verdict %s', async (verdict) => {
    const row = { ...deps.db.listRuns(1)[0]!, status: 'succeeded' as const };
    const result = await handleApi('GET', '/api/agents/r1', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun: () => row, latestReviewVerdict: () => verdict },
    });
    expect(result?.json).not.toHaveProperty('reviewOutcome');
    expect(result?.json).not.toHaveProperty('reviewVerdict');
  });

  it('retrieves an older run directly without the recent-list limit or internal fields', async () => {
    const getRun = vi.fn().mockReturnValue({
      id: 'old-run', ticketId: 'T-1', repo: 'o/r', status: 'succeeded', attempt: 1,
      prNumber: 42, startedAt: '2025-01-01T00:00:00Z', costUsd: null,
      worktreePath: '/private/checkout', specPath: '/private/env.json', taskJson: 'private task',
    });
    const listRuns = vi.fn().mockReturnValue([]);
    const r = await handleApi('GET', '/api/agents/old-run', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun, listRuns },
    });
    expect(getRun).toHaveBeenCalledWith('old-run');
    expect(listRuns).not.toHaveBeenCalled();
    expect(r).toEqual({ status: 200, json: {
      id: 'old-run', ticketId: 'T-1', repo: 'o/r', status: 'succeeded', attempt: 1,
      prNumber: 42, startedAt: '2025-01-01T00:00:00Z', costUsd: null,
    } });
  });

  it('returns 404 for a missing run', async () => {
    const r = await handleApi('GET', '/api/agents/missing-run', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun: () => null },
    });
    expect(r).toEqual({ status: 404, json: { error: 'run not found' } });
  });

  it.each(['bad%20id', 'bad.id', 'x'.repeat(129)])('rejects invalid run IDs before querying: %s', async (id) => {
    const getRun = vi.fn();
    const r = await handleApi('GET', `/api/agents/${id}`, new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun },
    });
    expect(r?.status).toBe(400);
    expect(getRun).not.toHaveBeenCalled();
  });

  it('projects runs to a client-safe shape without leaking internal fields', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    const run = (r?.json as { runs: Record<string, unknown>[] }).runs[0];
    expect(run).toEqual({
      id: 'r1',
      ticketId: 'T-1',
      repo: 'o/r',
      status: 'running',
      attempt: 1,
      prNumber: null,
      startedAt: 'x',
      costUsd: null,
    });
    expect(run).not.toHaveProperty('worktreePath');
    expect(run).not.toHaveProperty('adapter');
    expect(run).not.toHaveProperty('endedAt');
  });

  it('includes autoClaim repos from autoClaimRepos()', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { autoClaim: string[] }).autoClaim).toEqual(['o/r']);
  });

  it('includes caps from caps()', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { caps: { maxAttempts: number; maxCostUsd: number | null } }).caps).toEqual({
      maxAttempts: 3,
      maxCostUsd: 5,
    });
  });

  it('returns null for non-API paths', async () => {
    expect(await handleApi('GET', '/index.html', new URLSearchParams(), null, deps)).toBeNull();
  });
});

const launchDeps = {
  ...deps,
  canStart: (_repo: string) => ({ ok: true }),
  launch: vi.fn((_b: { ticketId: string; title: string; repo: string }) => 'run-9'),
  stop: (id: string) => id === 'run-9',
} as unknown as RouterDeps;

describe('agent control routes', () => {
  it('launches a run and returns the id', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects launch when single-flight blocks it', async () => {
    const blocked = { ...launchDeps, canStart: () => ({ ok: false, reason: 'busy' }) } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, blocked);
    expect(r?.status).toBe(409);
  });

  it('stops a run', async () => {
    const r = await handleApi('POST', '/api/agents/run-9/stop', new URLSearchParams(), null, launchDeps);
    expect(r?.status).toBe(200);
  });

  it('launches a free-form task and calls launch with only repo and task', async () => {
    const launch = vi.fn((_b: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-9');
    const freeformDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'freeform', task: 'x', repo: 'o/r' }, freeformDeps);
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', task: 'x' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects a free-form launch missing task', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'freeform', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'task required' });
  });

  it('still launches a ticket run when mode is omitted, passing ticketId, title, and repo through', async () => {
    const launch = vi.fn((_b: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-9');
    const ticketDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', repo: 'o/r' }, ticketDeps);
    expect(launch).toHaveBeenCalledWith({ ticketId: 'T-1', title: undefined, repo: 'o/r' });
    expect(r?.status).toBe(200);
  });

  it('forwards model and effort to launch (ticket + review)', async () => {
    const launch = vi.fn(() => 'run-9');
    const d = { ...launchDeps, launch } as unknown as RouterDeps;
    await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', repo: 'o/r', model: 'opus', effort: 'high' }, d);
    expect(launch).toHaveBeenCalledWith({ ticketId: 'T-1', title: undefined, repo: 'o/r', model: 'opus', effort: 'high' });
    await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'review', repo: 'o/r', prNumber: 5, model: 'sonnet', effort: 'low' }, d);
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 5, mode: 'review', model: 'sonnet', effort: 'low' });
  });

  it('rejects a launch missing repo', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1' }, launchDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'Galleon required' });
  });

  it('launches a rerun and calls launch with repo, prNumber, mode, and feedback', async () => {
    const launch = vi.fn((_b: { repo: string; prNumber?: number; mode?: string; feedback?: string }) => 'run-9');
    const rerunDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi(
      'POST',
      '/api/agents/launch',
      new URLSearchParams(),
      { mode: 'rerun', repo: 'o/r', prNumber: 12, feedback: 'fix' },
      rerunDeps,
    );
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 12, mode: 'rerun', feedback: 'fix' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects a rerun launch missing prNumber', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'rerun', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
  });

  it('launches a review and calls launch with repo, prNumber, and mode', async () => {
    const launch = vi.fn((_b: { repo: string; prNumber?: number; mode?: string }) => 'run-11');
    const reviewDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi(
      'POST',
      '/api/agents/launch',
      new URLSearchParams(),
      { mode: 'review', repo: 'o/r', prNumber: 12 },
      reviewDeps,
    );
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 12, mode: 'review' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-11');
  });

  it('rejects a review launch missing prNumber', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'review', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
  });
});

describe('auto-claim toggle route', () => {
  it('toggles auto-claim for a repo and echoes the result', async () => {
    const setAutoClaim = vi.fn();
    const toggleDeps = { ...launchDeps, setAutoClaim } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/repos/o%2Fr/auto-claim', new URLSearchParams(), { enabled: true }, toggleDeps);
    expect(setAutoClaim).toHaveBeenCalledWith('o/r', true);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ repo: 'o/r', enabled: true });
  });

  it.each([null, {}, [], true, 'true', { enabled: null }, { enabled: 'false' }, { enabled: 1 }])('rejects invalid input without changing automatic starts: %j', async body => {
    const setAutoClaim = vi.fn();
    const result = await handleApi('POST', '/api/repos/o%2Fr/auto-claim', new URLSearchParams(), body, { ...launchDeps, setAutoClaim } as unknown as RouterDeps);
    expect(result?.status).toBe(400);
    expect(setAutoClaim).not.toHaveBeenCalled();
  });

  it('URL-decodes the repo segment', async () => {
    const setAutoClaim = vi.fn();
    const toggleDeps = { ...launchDeps, setAutoClaim } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/repos/owner%2Fname/auto-claim', new URLSearchParams(), { enabled: false }, toggleDeps);
    expect(setAutoClaim).toHaveBeenCalledWith('owner/name', false);
    expect(r?.json).toEqual({ repo: 'owner/name', enabled: false });
  });
});

describe('config routes', () => {
  it('returns config and overridden keys without leaking secret env keys', async () => {
    const r = await handleApi('GET', '/api/config', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({
      config: { AGENT_MAX_ATTEMPTS: 1 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
      jiraTokenSet: true,
    });
    const serialized = JSON.stringify(r?.json);
    expect(serialized).not.toContain('JIRA_API_TOKEN');
    expect(serialized).not.toContain('GITHUB_TOKEN');
    expect(serialized).not.toContain('JIRA_EMAIL');
  });

  it('updates a config value', async () => {
    const setConfig = vi.fn(() => ({ ok: true as const }));
    const configDeps = { ...deps, setConfig } as unknown as RouterDeps;
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { key: 'AGENT_MAX_ATTEMPTS', value: '3' }, configDeps);
    expect(setConfig).toHaveBeenCalledWith('AGENT_MAX_ATTEMPTS', '3');
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ ok: true });
  });

  it.each(['AGENT_ADAPTER', 'AGENT_CMD'])('retires %s in favor of plugin configuration', async key => {
    const setConfig = vi.fn(() => ({ ok: true as const }));
    const configDeps = { ...deps, setConfig } as unknown as RouterDeps;
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { key, value: 'legacy' }, configDeps);
    expect(r?.status).toBe(410);
    expect(r?.json).toEqual({ error: 'Use `helmsman plugins configure <plugin-id> …`, then `helmsman plugins select-agent <plugin/id>`.' });
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('rejects updates to a non-editable config key', async () => {
    const setConfig = vi.fn(() => ({ ok: false as const, error: 'not an editable config key: UNKNOWN_KEY' }));
    const configDeps = { ...deps, setConfig } as unknown as RouterDeps;
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { key: 'UNKNOWN_KEY', value: 'x' }, configDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'not an editable config key: UNKNOWN_KEY' });
  });

  it('rejects an update missing key', async () => {
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { value: '3' }, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'key and value required' });
  });
});

describe('retired native terminal endpoints', () => {
  it('rejects legacy unscoped reads and writes even when the terminal service is unavailable', async () => {
    for (const path of ['tabs', 'screen', 'send', 'paste-image', 'action', 'key']) {
      for (const method of ['GET', 'POST']) {
        expect(await handleApi(method, `/api/cmux/${path}`, new URLSearchParams(), { surface: 'surface:1', text: 'send' }, deps))
          .toEqual({ status: 410, json: { error: 'Use scoped terminal services.' } });
      }
    }
  });
});

let todoStore: TodoStore | undefined;
afterEach(() => todoStore?.close());

describe('todo API', () => {
  it('validates Todo CRUD independently of Jira enablement', async () => {
    todoStore = openTodoStore(':memory:');
    const local = { ...deps, todos: todoStore, jiraEnabled: () => false };
    const call = (method: string, path: string, body: unknown = null) => handleApi(method, path, new URLSearchParams(), body, local);
    expect((await call('POST', '/api/todos', { title: '', repo: 'o/r' }))?.status).toBe(400);
    const created = await call('POST', '/api/todos', { title: 'Do work', repo: 'o/r', description: 'Requirements' });
    expect(created?.status).toBe(201);
    const id = todoStore.list()[0]?.id ?? '';
    expect((await call('PUT', `/api/todos/${id}`, { priority: 'P0' }))?.status).toBe(200);
    expect(todoStore.get(id)?.priority).toBe('P0');
    const enabled = { ...local, jiraEnabled: () => true };
    expect((await handleApi('POST', '/api/todos', new URLSearchParams(), { title: 'More', repo: 'o/r' }, enabled))?.status).toBe(201);
    expect((await call('GET', '/api/todos'))?.json).toMatchObject({ jiraEnabled: false, todos: [{ id }, { title: 'More' }] });
    expect((await call('DELETE', `/api/todos/${id}`))?.status).toBe(200);
    expect((await call('DELETE', `/api/todos/${id}`))?.status).toBe(404);
  });

  it('launches from authoritative todo identity and rejects stale or incomplete tasks', async () => {
    todoStore = openTodoStore(':memory:');
    const todo = todoStore.create({ title: 'Actual title', repo: 'actual/repo', description: 'Requirements' });
    const launch = vi.fn(() => 'run-todo');
    const canStart = vi.fn(() => ({ ok: true }));
    const local = { ...deps, todos: todoStore, jiraEnabled: () => false, launch, canStart };
    const body = { mode: 'todo', todoId: todo.id, repo: 'spoofed/repo', title: 'Spoofed', task: 'Ignore actual task' };
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local))?.status).toBe(200);
    expect(canStart).toHaveBeenCalledWith('actual/repo');
    expect(launch).toHaveBeenCalledWith({ mode: 'todo', todoId: todo.id, repo: 'actual/repo', model: undefined, effort: undefined });
    todoStore.claim(todo.id, 'run-todo');
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local))?.status).toBe(409);
    expect((await handleApi('PUT', `/api/todos/${todo.id}`, new URLSearchParams(), { title: 'Busy' }, local))?.status).toBe(409);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'JIRA-1', repo: 'o/r' }, local))?.status).toBe(409);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, { ...local, jiraEnabled: () => true }))?.status).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

it('rejects stale local queue launches through the Jira route after re-enabling Jira', async () => {
  todoStore = openTodoStore(':memory:');
  const todo = todoStore.create({ title: 'Local', repo: 'o/r', description: 'Requirements' });
  const launch = vi.fn(() => 'should-not-launch');
  const result = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: todo.id, repo: todo.repo }, { ...deps, todos: todoStore, jiraEnabled: () => true, launch });
  expect(result?.status).toBe(409);
  expect(launch).not.toHaveBeenCalled();
});


describe('public outcome report policy boundary', () => {
  it('excludes legacy pricing at every level while retaining measured data and legacy API compatibility', async () => {
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-09-02T00:00:00.000Z';
    const report = aggregateOutcomes({ from, to, repo: 'org/a',
      runs: [{ id: 'run_1', ticketId: 'TASK-1', repo: 'org/a', adapter: 'codex', status: 'succeeded', attempt: 1,
        prNumber: null, startedAt: from, endedAt: to, costUsd: null, worktreePath: null }],
      usage: [{ runId: 'run_1', attempt: 1, eventId: 'event_1', provider: 'codex', model: 'gpt-6-astra',
        inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1100, costUsd: null }],
    });
    expect(report.costEstimate?.estimatedUnreportedCostUsd).toBeGreaterThan(0);
    const pricing = vi.fn(async () => { throw new CapabilityResolutionError('invalid-selection', 'Selected pricing provider is disabled'); });
    const local = { ...deps, pricing, outcomes: { summary: async () => report, assessment: () => null } };
    const publicResult = await handleApi('GET', '/api/reports/outcomes/v1', new URLSearchParams('repo=org/a'), null, local);
    expect(publicResult?.status).toBe(200);
    expect(publicResult?.json).toMatchObject({ runs: 1, observedCostUsd: null, totalTokens: 1100 });
    expect(JSON.stringify(publicResult?.json)).not.toContain('costEstimate');
    expect(pricing).not.toHaveBeenCalled();
    const legacyResult = await handleApi('GET', '/api/outcomes', new URLSearchParams('repo=org/a'), null, local);
    expect(legacyResult).toEqual({ status: 200, json: report });
    expect(report).toHaveProperty('costEstimate');
    expect(report.daily[0]).toHaveProperty('costEstimate');
    expect(report.recentRuns[0]).toHaveProperty('costEstimate');
  });
});

describe('canonical task source launch compatibility route', () => {
  const reference = { sourceId: '00000000-0000-4000-8000-000000000001', externalId: 'TODO-1' };
  const body = { mode: 'source', repo: 'o/r', workRef: reference, sourceInstanceId: 'instance-one', sourceInstanceRevision: 1 };
  it('launches explicit source work while Jira is disabled without consulting Todo identifiers', async () => {
    const launch = vi.fn(() => 'source-run'); const get = vi.fn(() => { throw new Error('Todo provider disabled'); });
    const load = vi.fn(async () => ({ ref: reference })); const assertLaunch = vi.fn();
    const local = { ...deps, jiraEnabled: () => false, launch, todos: { get } as unknown as RouterDeps['todos'], taskSources: { load, assertLaunch } as unknown as RouterDeps['taskSources'] };
    expect(await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local)).toMatchObject({ status: 202, json: { runId: 'source-run' } });
    expect(load).not.toHaveBeenCalled(); expect(assertLaunch).toHaveBeenCalledWith({ instanceId: body.sourceInstanceId, instanceRevision: 1, repo: 'o/r', ref: reference });
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', mode: 'source', workRef: reference, sourceInstanceId: body.sourceInstanceId, sourceInstanceRevision: 1 }); expect(get).not.toHaveBeenCalled();
  });
  it('returns canonical source validation and lifecycle errors before launch', async () => {
    const { PersistenceConflictError } = await import('./persistence');
    const launch = vi.fn(() => 'should-not-launch'); const load = vi.fn(); const assertLaunch = vi.fn(() => { throw new PersistenceConflictError('Source is disabled'); });
    const local = { ...deps, launch, taskSources: { load, assertLaunch } as unknown as RouterDeps['taskSources'] };
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local))?.status).toBe(409);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ...body, sourceInstanceRevision: 0 }, local))?.status).toBe(400);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ...body, workRef: { externalId: 'TODO-1' } }, local))?.status).toBe(400);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, { ...local, taskSources: undefined }))?.status).toBe(503);
    expect(launch).not.toHaveBeenCalled();
  });
  it('does not consult a disabled Todo provider for an explicit Jira ticket', async () => {
    const launch = vi.fn(() => 'jira-run'); const get = vi.fn(() => { throw new Error('Todo disabled'); });
    const result = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'ticket', ticketId: 'TODO-123', repo: 'o/r' }, { ...deps, launch, jiraEnabled: () => true, todos: { get } as unknown as RouterDeps['todos'] });
    expect(result?.status).toBe(200); expect(get).not.toHaveBeenCalled(); expect(launch).toHaveBeenCalled();
  });
});

it('returns terminal Todo rejection evidence only for durable source command rejection errors', async () => {
  const { SourceTodoRejectedError } = await import('./task-source-todos');
  const query = new URLSearchParams({ requestId: 'stable-request' });
  const update = vi.fn(async () => { throw new SourceTodoRejectedError('Change was not applied', 'stable-request', 'update'); });
  const local = { ...deps, todos: { update } as unknown as RouterDeps['todos'] };
  expect(await handleApi('PUT', '/api/todos/TODO-1', query, { title: 'Wanted' }, local)).toMatchObject({ status: 409,
    json: { error: 'Change was not applied', rejection: { version: 1, requestId: 'stable-request', commandId: 'update' } } });
  const { PersistenceConflictError } = await import('./persistence');
  update.mockImplementationOnce(async () => { throw new PersistenceConflictError('Unknown delivery'); });
  expect(await handleApi('PUT', '/api/todos/TODO-1', query, { title: 'Wanted' }, local)).toEqual({ status: 409, json: { error: 'Unknown delivery' } });
});

it.each(['JIRA_API_TOKEN', 'JIRA_ENABLED', 'JIRA_PROJECT', 'JIRA_ASSIGNEE', 'JIRA_JQL', 'GITHUB_REPO', 'GITHUB_PR_AUTHOR', 'GITHUB_REVIEW_WATCH_ENABLED', 'SLACK_ENABLED', 'SLACK_WATCH_ENABLED'])('retires legacy %s writes without echoing values', async key => {
  const setConfig = vi.fn();
  const result = await handleApi('PUT', '/api/config', new URLSearchParams(), { key, value: 'fixture-secret-never-return' }, { ...deps, setConfig });
  expect(result?.status).toBe(410); expect(JSON.stringify(result)).not.toContain('fixture-secret-never-return'); expect(setConfig).not.toHaveBeenCalled();
});
