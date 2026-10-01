import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentEvent, AgentTask } from './agents/adapter';
import { executePrePrStage, localReviewScope, readPrePrReport, stageEventEmitter, retainedPrePrAdapters, githubRepository } from './pre-pr-runtime';
import { selectReviewModel } from './review-policy';
import { collectFeedbackSnapshot } from './feedback-snapshot-client';
import { runFeedbackUpdateWorkflow } from './feedback-update-workflow';
import { parseFeedbackAudit } from './feedback-audit';
import { waitForFeedbackDecisions, readFeedbackClarifications } from './feedback-clarifications';
import { createRunArtifactStore } from './artifacts';
import { usesIsolatedExecution } from './execution-host-stage';

const exec = promisify(execFile);
export async function runFeedbackUpdateRuntime(input: { task: AgentTask; runsDir: string }, emit: (event: AgentEvent) => void): Promise<void> {
  const { task } = input;
  if (task.review || !task.prBranch || !task.prNumber || task.workflow?.metadata.feedbackCompletion !== true || usesIsolatedExecution(task) || task.hostIsolation || !task.agentSelection || !task.pullRequestSource) {
    throw new Error('Feedback workflow requires an existing PR update on a trusted local host');
  }
  const settings = task.workflow.metadata;
  const cwd = process.cwd();
  const runId = basename(cwd);
  const artifactDir = resolve(input.runsDir, `${runId}.feedback`);
  const artifactsRelative = relative(cwd, artifactDir);
  if (!artifactsRelative || (!artifactsRelative.startsWith('..') && !isAbsolute(artifactsRelative))) throw new Error('Feedback artifacts must be outside the worktree');
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const artifacts = createRunArtifactStore(join(input.runsDir, '.artifacts'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('SIGHUP', stop);
  const command = async (file: string, args: string[], dir = cwd) => {
    const result = await exec(file, args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, signal: abort.signal });
    return result.stdout.replace(/\r?\n$/, '');
  };
  const git = (args: string[], dir = cwd) => command('git', args, dir);
  let loaded: Awaited<ReturnType<typeof retainedPrePrAdapters>> | undefined;
  try {
    loaded = await retainedPrePrAdapters(task, undefined, task.agentSelection.reviewers.length, abort.signal);
    const { writerId, reviewerIds: reviewers, adapters, workflow } = loaded;
    if (!workflow?.nextFeedback) throw new Error('Retained feedback workflow policy is unavailable');
    const runStage = async (provider: string, stageTask: AgentTask, dir: string, round: number) => {
      const adapter = adapters.get(provider);
      if (!adapter) throw new Error('Retained feedback agent is unavailable');
      const stage = stageTask.feedbackStage?.stage === 'audit' ? 'feedback-review' : 'feedback-repair';
      const forward = stageEventEmitter(adapter, stageTask, event => {
        if (event.kind !== 'feedback-outcome' && event.kind !== 'run-complete') emit({ ...event, stage, round });
      });
      forward({ kind: 'phase', text: `Starting ${provider} ${stage} round ${round}` });
      await executePrePrStage(adapter, stageTask, dir, forward, abort.signal, settings.stageTimeoutMinutes * 60_000);
    };
    const remote = (await git(['remote'])).split('\n');
    const matched: string[] = [];
    for (const name of remote) {
      const urls = (await git(['remote', 'get-url', '--all', name])).split('\n');
      if (urls.length && urls.every(url => githubRepository(url) === task.repo.toLowerCase())) matched.push(name);
    }
    const readRemote = matched.includes('origin') ? 'origin' : matched[0];
    if (!readRemote) throw new Error('No Git remote matches the retained PR galleon');
    emit({ kind: 'phase', text: `Feedback completion gate: ${reviewers.length} independent reviewer(s), up to ${settings.maxRounds} repair rounds` });
    await runFeedbackUpdateWorkflow({
      maxRounds: settings.maxRounds,
      collect: () => collectFeedbackSnapshot(task, runId, abort.signal),
      next: input => workflow.nextFeedback!(input),
      isStopped: () => abort.signal.aborted,
      outcome: outcome => emit({ kind: 'feedback-outcome', text: JSON.stringify({ ...outcome, attempt: task.clarification?.attempt, channelId: task.clarification?.channelId }) }),
      assertRevision: async snapshot => {
        if (snapshot.headBranch !== task.prBranch || await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== task.prBranch
          || await git(['rev-parse', 'HEAD']) !== snapshot.headSha
          || await git(['status', '--porcelain', '--untracked-files=all'])) {
          throw new Error('Feedback verification requires a clean committed worktree matching the published PR head and branch');
        }
      },
      author: async (snapshot, feedback, round) => {
        const snapshotPath = join(artifactDir, `author-${round}-snapshot.json`);
        const feedbackPath = join(artifactDir, `author-${round}-feedback.txt`);
        await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
        await writeFile(feedbackPath, feedback, { mode: 0o600 });
        await runStage(writerId, { ...task, feedbackStage: { stage: 'author', round, snapshotPath, feedbackPath,
          snapshot: { repo: snapshot.repo, prNumber: snapshot.prNumber, headSha: snapshot.headSha, baseSha: snapshot.baseSha, fingerprint: snapshot.fingerprint } } }, cwd, round);
      },
      audit: async (snapshot, round, decisions) => {
        const snapshotPath = join(artifactDir, `review-${round}-snapshot.json`);
        const snapshotBytes = JSON.stringify(snapshot);
        await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
        const decisionsPath = join(artifactDir, `review-${round}-decisions.txt`);
        const decisionFingerprint = decisions ? createHash('sha256').update(decisions).digest('hex') : undefined;
        if (decisions) await writeFile(decisionsPath, decisions, { mode: 0o600 });
        const assertEvidenceUnchanged = async () => {
          if (await readFile(snapshotPath, 'utf8') !== snapshotBytes
            || decisions && await readFile(decisionsPath, 'utf8') !== decisions) throw new Error('Feedback reviewer modified captured evidence');
        };
        await artifacts.write({ runId, stage: 'feedback-snapshot', round }, Buffer.from(JSON.stringify(snapshot)));
        if (decisions) await artifacts.write({ runId, stage: 'feedback-decisions', round }, decisions);
        await git(['fetch', '--no-tags', readRemote, `refs/heads/${snapshot.baseBranch}`]);
        await git(['cat-file', '-e', `${snapshot.baseSha}^{commit}`]);
        const scope = localReviewScope(await git(['diff', '--numstat', '--no-renames', '-z', `${snapshot.baseSha}...${snapshot.headSha}`]), snapshot.headSha);
        const reports: unknown[] = [];
        for (const provider of reviewers) {
          const adapter = adapters.get(provider);
          if (!adapter) throw new Error('Retained feedback reviewer is unavailable');
          const choice = selectReviewModel(scope, adapter.metadata ?? provider);
          const root = await mkdtemp(join(tmpdir(), 'helmsman-feedback-review-'));
          const checkout = join(root, 'checkout');
          const reportPath = join(artifactDir, `review-${round}-${createHash('sha256').update(provider).digest('hex')}.json`);
          try {
            await rm(reportPath, { force: true });
            await git(['worktree', 'add', '--detach', checkout, snapshot.headSha]);
            await runStage(provider, { ...task, prHeadSha: snapshot.headSha, model: choice.model, effort: choice.effort,
              feedbackStage: { stage: 'audit', round, snapshotPath, reportPath, ...(decisionFingerprint ? { decisions: { path: decisionsPath, fingerprint: decisionFingerprint } } : {}), snapshot: { repo: snapshot.repo, prNumber: snapshot.prNumber,
                headSha: snapshot.headSha, baseSha: snapshot.baseSha, fingerprint: snapshot.fingerprint } } }, checkout, round);
            if (await git(['rev-parse', 'HEAD'], checkout) !== snapshot.headSha || await git(['status', '--porcelain', '--untracked-files=all'], checkout)) {
              throw new Error('Feedback reviewer modified its immutable worktree');
            }
            await assertEvidenceUnchanged();
            const report = parseFeedbackAudit(await readPrePrReport(reportPath), snapshot, decisionFingerprint);
            await artifacts.write({ runId, stage: 'feedback-review', round, reviewer: provider }, await readFile(reportPath));
            reports.push(report);
          } finally {
            await exec('git', ['worktree', 'remove', '--force', checkout], { cwd }).catch(() => undefined);
            await rm(root, { recursive: true, force: true });
          }
        }
        return reports;
      },
      clarificationEvidence: () => readFeedbackClarifications(task, runId),
      decide: decisions => waitForFeedbackDecisions(task, decisions, abort.signal, settings.stageTimeoutMinutes * 60_000),
    });
  } finally {
    try { await loaded?.dispose(); }
    finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGHUP', stop);
    }
  }
}
