// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { inspectPrePrContinuation, resumeFailedPrePrRun } from './resume';
import type { LaunchSpec, RunHost } from './run-host';
import { createRunArtifactStore, prePrArtifactFilename } from './artifacts';
import type { DurableRunnerAttempt, DurableRunnerCoordinator } from './runner';

const fixtures: { root: string; db: Db }[] = [];
afterEach(() => { for (const { root, db } of fixtures.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-resume-'));
  const db = openDb(':memory:');
  fixtures.push({ root, db });
  const id = 'resume-run';
  const runsDir = join(root, 'runs');
  const cwd = join(root, '.worktrees', id);
  const artifacts = join(runsDir, `${id}.pre-pr`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'task.txt'), 'base\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '-b', `agent/${id}`);
  writeFileSync(join(cwd, 'task.txt'), 'implemented\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'implementation');
  const headSha = git('rev-parse', 'HEAD');
  const task = { ticketId: 'PROJ-1', title: 'Retained task', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.com', jiraContext: 'Original criteria', model: 'gpt-5.6-sol', effort: 'high' };
  const settings = { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 };
  const specPath = join(runsDir, `${id}.json`);
  const logPath = join(runsDir, `${id}.log`);
  const exitPath = join(runsDir, `${id}.exit`);
  const spec = { cwd, cmd: 'node', args: [JSON.stringify({ task, settings, writerId: 'codex', runsDir })] };
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(logPath, 'original log\n');
  writeFileSync(exitPath, '1');
  const report = { baseSha, headSha, verdict: 'REQUEST_CHANGES', summary: 'Fix the remaining issue.', findings: [{ title: 'Timing issue', body: 'Reproduce the remaining crash loop.' }] };
  writeFileSync(join(artifacts, 'review-2-codex.json'), JSON.stringify(report));
  writeFileSync(join(artifacts, 'review-2-claude-code.json'), JSON.stringify({ ...report, verdict: 'APPROVE', findings: [], summary: 'x'.repeat(2064) }));
  writeFileSync(join(artifacts, 'fix-1.json'), JSON.stringify({ title: 'PROJ-1 implement task', body: 'Original implementation and tests.' }));
  const row: RunRow = { id, ticketId: task.ticketId, repo: task.repo, adapter: 'pre-pr:codex', status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-09-18T00:00:00Z', endedAt: '2026-09-18T01:00:00Z', costUsd: 5.2, worktreePath: cwd,
    hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 111 }), logPath, exitPath, specPath, logOffset: 13,
    taskJson: JSON.stringify(task), launchJson: JSON.stringify({ repo: task.repo, mode: 'ticket', ticketId: task.ticketId }) };
  db.insertRun(row); db.appendEvent(id, 'run-complete', 'failed', row.endedAt!);
  const host: RunHost = { kind: 'detached', isAlive: vi.fn(async () => false), stop: vi.fn(async () => {}), launch: vi.fn(async (spec: LaunchSpec) => {
    writeFileSync(spec.specPath, JSON.stringify(spec));
    appendFileSync(spec.logPath, 'new stage\n');
    return { kind: 'detached' as const, pid: 222 };
  }) };
  const deps = { db, host, runsDir, now: () => '2026-09-18T02:00:00Z' };
  return { root, db, row, deps, task, settings, spec, artifacts, cwd, baseSha, headSha, git };
}

function bindRetainedAgent(f: ReturnType<typeof fixture>) {
  const metadata = { version: 1 as const, label: 'Retained', defaults: { model: null, effort: null },
    review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } },
    reviewSkills: [], reviewDelegation: 'none' as const, supportsPrePr: true, docker: null, costReporting: 'delta' as const };
  const providerId = 'example.agent/worker';
  const record = { version: 1 as const, binding: { providerId, pluginId: 'example.agent', artifactHash: 'a'.repeat(64), contractVersion: 1 as const },
    origin: 'external' as const, settings: {}, metadata };
  const task = { ...f.task, agentSelection: { version: 1 as const, writer: record, reviewers: [record] },
    agentRuntime: { pluginsRoot: join(f.root, 'plugins'), runtimeArtifactsRoot: join(f.root, 'runtime-artifacts'),
      artifacts: [{ pluginId: 'example.agent', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] }] } };
  const settings = { ...f.settings, reviewerCount: 1 };
  const spec = { ...f.spec, args: [JSON.stringify({ task, settings, runsDir: f.deps.runsDir })] };
  writeFileSync(f.row.specPath!, JSON.stringify(spec));
  f.row.adapter = `pre-pr:${providerId}`;
  f.row.taskJson = JSON.stringify(task);
  const reportPath = join(f.artifacts, prePrArtifactFilename('review', 2, providerId));
  writeFileSync(reportPath, JSON.stringify({ baseSha: f.baseSha, headSha: f.headSha, verdict: 'REQUEST_CHANGES', summary: 'x'.repeat(2064),
    findings: [{ title: 'Timing issue', body: 'Reproduce the remaining crash loop.' }] }));
  return { task, settings, providerId, reportPath };
}

describe('same-voyage pre-PR continuation', () => {
  it('validates a saved round and allows only the known summary-length defect', async () => {
    const f = fixture();
    const checkpoint = await inspectPrePrContinuation(f.row, f.deps.runsDir);
    expect(checkpoint.task).toMatchObject({ ...f.task, prePrResume: { baseSha: f.baseSha, headSha: f.headSha, branch: `agent/${f.row.id}`, round: 2,
      reviewerReports: { codex: join(f.artifacts, 'review-2-codex.json'), 'claude-code': join(f.artifacts, 'review-2-claude-code.json') }, metadataPath: join(f.artifacts, 'fix-1.json') } });
    expect(checkpoint.settings).toEqual(f.settings);
  });

  it('relaunches on the preserved worktree and row with appended logs, original costs/context and archived attempt files', async () => {
    const f = fixture();
    const result = await resumeFailedPrePrRun(f.row, f.deps);
    expect(f.deps.host.launch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: f.row.id, status: 'running', attempt: 2, endedAt: null, costUsd: 5.2, logOffset: 13,
      startedAt: f.row.startedAt, worktreePath: f.cwd, hostRef: JSON.stringify({ kind: 'detached', pid: 222 }), launchJson: f.row.launchJson });
    expect(JSON.parse(result.taskJson ?? '{}')).toMatchObject(f.task);
    const launched = JSON.parse(readFileSync(f.row.specPath!, 'utf8')) as LaunchSpec;
    expect(launched.cwd).toBe(f.cwd);
    expect(JSON.parse(launched.args.at(-1)!)).toMatchObject({ settings: f.settings, task: { prePrResume: { headSha: f.headSha, round: 2 } } });
    expect(readFileSync(f.row.logPath!, 'utf8')).toBe('original log\nnew stage\n');
    const archive = readdirSync(f.deps.runsDir).find(name => name.startsWith(`${f.row.id}.attempt-1-`));
    expect(JSON.parse(readFileSync(join(f.deps.runsDir, archive!, 'spec.json'), 'utf8'))).toEqual(f.spec);
    expect(readFileSync(join(f.deps.runsDir, archive!, 'exit'), 'utf8')).toBe('1');
    expect(f.db.listEvents(f.row.id).map(event => event.kind)).toEqual(['run-complete', 'phase']);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.headSha);
  });

  it.each(['dirty', 'changed-head', 'malformed-report', 'missing-report', 'invalid-settings', 'unconsumed-log', 'branch-changed', 'running', 'todo', 'host-alive', 'cancelled'])('rejects %s before launching', async reason => {
    const f = fixture();
    if (reason === 'dirty') writeFileSync(join(f.cwd, 'unrelated.txt'), 'draft');
    if (reason === 'changed-head') { writeFileSync(join(f.cwd, 'task.txt'), 'changed'); f.git('add', '.'); f.git('commit', '--quiet', '-m', 'changed'); }
    if (reason === 'malformed-report') writeFileSync(join(f.artifacts, 'review-2-claude-code.json'), JSON.stringify({ baseSha: f.baseSha, headSha: f.headSha, verdict: 'APPROVE', summary: 'x'.repeat(2064), findings: [{}] }));
    if (reason === 'missing-report') rmSync(join(f.artifacts, 'review-2-claude-code.json'));
    if (reason === 'invalid-settings') writeFileSync(f.row.specPath!, JSON.stringify({ ...f.spec, args: [JSON.stringify({ task: f.task, writerId: 'codex', runsDir: f.deps.runsDir, settings: { ...f.settings, maxRounds: 99 } })] }));
    if (reason === 'unconsumed-log') appendFileSync(f.row.logPath!, 'unread');
    if (reason === 'branch-changed') f.git('checkout', '--quiet', '-b', 'different');
    if (reason === 'running') f.row.status = 'running';
    if (reason === 'todo') f.row.taskJson = JSON.stringify({ ...f.task, todoId: 'TODO-1' });
    if (reason === 'host-alive') vi.mocked(f.deps.host.isAlive).mockResolvedValue(true);
    await expect(resumeFailedPrePrRun(f.row, { ...f.deps, isStopped: () => reason === 'cancelled' })).rejects.toThrow();
    expect(f.deps.host.launch).not.toHaveBeenCalled();
    expect(f.db.getRun(f.row.id)?.status).toBe('failed');
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe('1');
  });

  it('restores the original row, spec and exit marker when launching fails', async () => {
    const f = fixture();
    vi.mocked(f.deps.host.launch).mockImplementation(async spec => { writeFileSync(spec.specPath, 'replaced'); throw new Error('host failed'); });
    await expect(resumeFailedPrePrRun(f.row, f.deps)).rejects.toThrow('could not start');
    expect(f.db.getRun(f.row.id)).toMatchObject(f.row);
    expect(JSON.parse(readFileSync(f.row.specPath!, 'utf8'))).toEqual(f.spec);
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe('1');
    expect(readFileSync(f.row.logPath!, 'utf8')).toBe('original log\n');
  });

  it('rejects a report altered after an immutable artifact was recorded, while legacy reports remain resumable', async () => {
    const f = fixture();
    const reportPath = join(f.artifacts, 'review-2-codex.json');
    await createRunArtifactStore(join(f.deps.runsDir, '.artifacts')).write({ runId: f.row.id, stage: 'review', round: 2, reviewer: 'codex' }, readFileSync(reportPath));
    writeFileSync(reportPath, '{"tampered":true}');
    await expect(inspectPrePrContinuation(f.row, f.deps.runsDir)).rejects.toThrow('changed after');
  });

  it('requires immutable manifests for retained agent checkpoints', async () => {
    const f = fixture();
    bindRetainedAgent(f);
    await expect(inspectPrePrContinuation(f.row, f.deps.runsDir)).rejects.toThrow('manifest is required');
  });

  it('resumes a retained agent checkpoint from its immutable corrected report', async () => {
    const f = fixture();
    const retained = bindRetainedAgent(f);
    const correctedPath = join(f.artifacts, prePrArtifactFilename('review', 2, retained.providerId, true));
    const corrected = { baseSha: f.baseSha, headSha: f.headSha, verdict: 'REQUEST_CHANGES', summary: 'Concise corrected summary.',
      findings: [{ title: 'Timing issue', body: 'Reproduce the remaining crash loop.' }] };
    writeFileSync(correctedPath, JSON.stringify(corrected));
    const store = createRunArtifactStore(join(f.deps.runsDir, '.artifacts'));
    await store.write({ runId: f.row.id, stage: 'review', round: 2, reviewer: retained.providerId }, readFileSync(correctedPath));
    const metadataPath = join(f.artifacts, 'fix-1.json');
    await store.write({ runId: f.row.id, stage: 'fix', round: 1 }, readFileSync(metadataPath));
    const checkpoint = await inspectPrePrContinuation(f.row, f.deps.runsDir);
    expect(checkpoint.task.prePrResume?.reviewerReports).toEqual({ [retained.providerId]: correctedPath });
  });
});

function durableFixture() {
  const f = fixture();
  const paths = { logPath: join(f.deps.runsDir, `${f.row.id}.attempt-2.log`), exitPath: join(f.deps.runsDir, `${f.row.id}.attempt-2.exit`),
    specPath: join(f.deps.runsDir, `${f.row.id}.attempt-2.json`), receiptPath: join(f.deps.runsDir, `${f.row.id}.attempt-2.receipt`) };
  const attempt: DurableRunnerAttempt = {
    launchId: 'continued-launch-2', attempt: 2, paths, preparation: 'prepared', hostRef: null,
    ready: vi.fn(), launching: vi.fn(), launched: vi.fn(ref => f.db.updateRun(f.row.id, { hostKind: ref.kind, hostRef: JSON.stringify(ref) })),
    attachment: vi.fn(), terminal: vi.fn(), finalize: vi.fn(), renew: vi.fn(), close: vi.fn(),
  };
  const retained = { ...attempt, attempt: 1, close: vi.fn() };
  const durable: DurableRunnerCoordinator = {
    recover: vi.fn(async () => retained),
    prepare: vi.fn(async row => { f.db.updateRun(row.id, { ...row, ...paths }); return attempt; }),
    cleanupEligibility: () => ({ allowed: false, reasons: ['retained checkpoint'] }),
  };
  const original = { spec: readFileSync(f.row.specPath!, 'utf8'), exit: readFileSync(f.row.exitPath!, 'utf8'), log: readFileSync(f.row.logPath!, 'utf8') };
  return { ...f, original, attempt, retained, durable, deps: { ...f.deps, durable } };
}

describe('durable continuation faults', () => {
  it('validates retained bindings before preparation or file mutation', async () => {
    const f = durableFixture();
    vi.mocked(f.durable.recover).mockRejectedValue(new Error('retained runtime unavailable'));
    await expect(resumeFailedPrePrRun(f.row, f.deps)).rejects.toThrow('retained runtime unavailable');
    expect(f.durable.prepare).not.toHaveBeenCalled();
    expect(f.deps.host.launch).not.toHaveBeenCalled();
    expect(readFileSync(f.row.specPath!, 'utf8')).toBe(f.original.spec);
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe(f.original.exit);
    expect(f.db.getRun(f.row.id)?.attempt).toBe(1);
  });

  it('preserves new launch files, old checkpoint files, and prepared ownership after an ambiguous launch', async () => {
    const f = durableFixture();
    vi.mocked(f.deps.host.launch).mockImplementation(async spec => { writeFileSync(spec.specPath, JSON.stringify(spec)); throw new Error('remote worker started but response lost'); });
    await expect(resumeFailedPrePrRun(f.row, f.deps)).rejects.toThrow('ownership needs reconciliation');
    expect(f.db.getRun(f.row.id)).toMatchObject({ status: 'running', attempt: 2, endedAt: null });
    expect(JSON.parse(readFileSync(f.attempt.paths.specPath, 'utf8'))).toMatchObject({ launchId: f.attempt.launchId, attempt: 2 });
    expect(readFileSync(f.row.specPath!, 'utf8')).toBe(f.original.spec);
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe(f.original.exit);
    expect(readFileSync(f.row.logPath!, 'utf8')).toBe(f.original.log);
    expect(f.deps.host.stop).not.toHaveBeenCalled();
    expect(f.attempt.attachment).toHaveBeenCalledWith('blocked', 'remote worker started but response lost');
    expect(f.attempt.close).toHaveBeenCalledOnce();
  });

  it('continues after verified prior exit without treating inaccessible boolean liveness as absence', async () => {
    const f = durableFixture();
    vi.mocked(f.deps.host.isAlive).mockRejectedValue(new Error('dead PID cannot be verified'));
    const resumed = await resumeFailedPrePrRun(f.row, f.deps);
    expect(resumed.attempt).toBe(2);
    expect(f.deps.host.isAlive).not.toHaveBeenCalled();
    expect(f.durable.recover).toHaveBeenCalledWith(f.row);
  });

  it('does not let stale-lease diagnostics mask uncertain remote ownership', async () => {
    const f = durableFixture();
    vi.mocked(f.attempt.launched).mockImplementation(() => { throw new Error('lease expired after launch'); });
    vi.mocked(f.attempt.attachment).mockImplementation(() => { throw new Error('stale lease'); });
    vi.mocked(f.attempt.close).mockImplementation(() => { throw new Error('stale lease'); });
    await expect(resumeFailedPrePrRun(f.row, f.deps)).rejects.toThrow('ownership needs reconciliation');
    expect(f.db.getRun(f.row.id)).toMatchObject({ status: 'running', attempt: 2 });
    expect(f.deps.host.stop).not.toHaveBeenCalled();
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe(f.original.exit);
  });
});
