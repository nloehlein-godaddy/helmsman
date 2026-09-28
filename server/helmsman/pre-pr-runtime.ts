import { randomUUID } from 'node:crypto';
import { beginCoordinatorStage } from './coordinator-settlement';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentEvent, AgentTask } from './agents/adapter';
import { codexAdapter } from './agents/codex';
import { claudeCodeAdapter } from './agents/claude-code';
import { assertReviewSummaryCorrection, parsePrePrReview, PrePrGateError, PrePrSummaryTooLongError, runPrePrWorkflow, type PrePrResumeCheckpoint } from './pre-pr-workflow';
import { selectReviewModel, type ReviewScope } from './review-policy';
import { agentAttribution } from './agent-attribution';
import { DEFAULT_PRE_PR_SETTINGS, normalizePrePrSettings, type PrePrSettings } from '../../src/logic/prePrSettings';
import { createRunArtifactStore, prePrArtifactFilename } from './artifacts';
import { sanitizeDockerGit } from './docker-stage';
import { prepareExecutionHostStage, usesIsolatedExecution } from './execution-host-stage';
import { publishApprovedRevision, validatePublicationConnection, type PrePrPublicationConnection } from './publication-client';
import { parseAgentSelectionV1, type AgentRetainedProviderV1 } from './agent-providers';
import { loadRetainedAgentProvider } from './agent-retained-loader';
import { agentProviderAdapter } from './agents/provider';
import { persistenceHash } from './persistence';
import { loadExecutionWorkflow } from './workflow-execution';
import type { WorkflowProviderV1 } from '../../src/plugins/workflow';
import { buildRoutedAgentCommand } from './model-routing';

const exec = promisify(execFile);
const legacyAdapters: Record<string, AgentAdapter> = { codex: codexAdapter, 'claude-code': claudeCodeAdapter };
const STAGE_TIMEOUT = DEFAULT_PRE_PR_SETTINGS.stageTimeoutMinutes * 60_000;

export function githubRepository(remote: string): string | null {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parsePrMetadata(value: unknown, task?: Pick<AgentTask, 'ticketId' | 'task'>): { title: string; body: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing PR metadata');
  const { title, body } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim() || title.length > 256 || /[\r\n\u0000]/.test(title)
    || typeof body !== 'string' || !body.trim() || body.length > 64_000 || body.includes('\0')) throw new Error('Invalid PR metadata');
  if (task && !task.task && !title.split(/[^a-zA-Z0-9_-]+/).includes(task.ticketId)) throw new Error('PR title must include the Jira ticket ID');
  return { title: title.trim(), body };
}

export function localReviewScope(numstat: string, headSha: string): ReviewScope {
  const files = numstat.split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!match?.[3]) throw new Error('Invalid local diff scope');
    return { filename: match[3], changes: Number(match[1] === '-' ? 0 : match[1]) + Number(match[2] === '-' ? 0 : match[2]), patch: null };
  });
  return { files, headSha, complete: true, changedFiles: files.length, changedLines: files.reduce((sum, file) => sum + file.changes, 0) };
}

export async function readPrePrReport(path: string): Promise<unknown> {
  const limit = 256 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Report missing or exceeds 256 KB');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Report exceeds 256 KB');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

async function recordValidatedReport(runsDir: string, runId: string, identity: { stage: string; round: number; reviewer?: string }, path: string): Promise<void> {
  const bytes = await readFile(path);
  const store = createRunArtifactStore(join(runsDir, '.artifacts'));
  await store.write({ runId, ...identity }, bytes);
}

export async function assertClarificationReady(task: AgentTask, runId: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (task.clarification === undefined) return;
  const raw = task.clarification?.gateUrl;
  if (typeof raw !== 'string' || raw.length > 1024) throw new PrePrGateError('Clarification publication gate is unavailable; publication blocked.');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new PrePrGateError('Clarification publication gate URL is invalid; publication blocked.'); }
  const token = task.clarification?.gateToken;
  const dockerGate = url.hostname === 'host.docker.internal' && url.pathname === '/clarification-gate'
    && typeof token === 'string' && /^[a-z\d._~-]{20,4096}$/i.test(token);
  const localGate = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === `/api/runs/${runId}/clarification-gate`;
  const channel = task.clarification;
  const legacy = channel?.version === undefined && channel?.runId === undefined && channel?.attempt === undefined && channel?.channelId === undefined;
  const queryMatches = legacy ? !url.search : channel?.version === 1 && channel.runId === runId
    && Number.isSafeInteger(channel.attempt) && Number(channel.attempt) >= 1
    && typeof channel.channelId === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(channel.channelId)
    && url.searchParams.size === 2 && url.searchParams.getAll('attempt').length === 1 && url.searchParams.getAll('channel').length === 1
    && url.searchParams.get('attempt') === String(channel.attempt) && url.searchParams.get('channel') === channel.channelId;
  if (url.protocol !== 'http:' || !(dockerGate || localGate)
    || url.username || url.password || !queryMatches || url.hash
    || !/^[a-z\d_-]{1,128}$/i.test(runId)) {
    throw new PrePrGateError('Clarification publication gate must match this local voyage; publication blocked.');
  }
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
      ...(dockerGate ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
    if (!response.ok) throw new Error(`gate returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('ready' in body) || body.ready !== true) {
      throw new Error('required clarification has not been answered');
    }
  } catch (error) {
    throw new PrePrGateError(`Clarification publication gate did not pass; publication blocked. ${error instanceof Error ? error.message : 'gate unavailable'}`);
  }
}

export async function executePrePrStage(adapter: AgentAdapter, task: AgentTask, cwd: string, emit: (event: AgentEvent) => void,
  signal: AbortSignal, timeoutMs = STAGE_TIMEOUT): Promise<void> {
  if (signal.aborted) throw new Error('Voyage stopped');
  const stageSettled = beginCoordinatorStage();
  let isolated: Awaited<ReturnType<typeof prepareExecutionHostStage>> | undefined;
  let prepared = false;
  let containmentFailed = false;
  let success = false;
  try {
    isolated = usesIsolatedExecution(task) ? await prepareExecutionHostStage(adapter, task, cwd) : undefined;
    prepared = true;
    const command = isolated?.command ?? buildRoutedAgentCommand(adapter, task);
    await new Promise<void>((done, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command.cmd, command.args, { cwd, env: process.env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killStage = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          containmentFailed = true;
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
    };
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (isolated) void isolated.stop().catch(() => undefined);
      killStage('SIGTERM');
      killTimer ??= setTimeout(() => killStage('SIGKILL'), 5000);
      killTimer.unref();
    };
    const abort = () => stop('Voyage stopped');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Agent stage timed out'), timeoutMs);
    let stdout = '';
    let stderr = '';
    const forward = (line: string, error = false) => {
      if (!line.trim()) return;
      if (!error && adapter.id === 'claude-code') {
        try {
          const value = JSON.parse(line) as { type?: string; is_error?: boolean; subtype?: string } | null;
          if (value?.type === 'result' && (value.is_error === true || value.subtype?.startsWith('error'))) failure ??= new Error('Agent reported an unsuccessful result');
        } catch { /* Non-JSON diagnostic output is handled by the adapter. */ }
      }
      let event: AgentEvent | null;
      try { event = error ? { kind: 'log' as const, text: line } : adapter.parseLine(line); }
      catch { stop('Agent emitted malformed output'); return; }
      if (!event) return;
      const { prNumber: _prNumber, ...safe } = event;
      if (safe.kind === 'error') failure ??= new Error('Agent reported an error');
      if (safe.kind === 'result' && safe.outcome === 'failure') failure ??= new Error('Agent reported an unsuccessful result');
      emit(safe);
    };
    const consume = (chunk: string, error: boolean) => {
      let buffer = (error ? stderr : stdout) + chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { forward(buffer.slice(0, index), error); buffer = buffer.slice(index + 1); }
      if (buffer.length > 1024 * 1024) { stop('Agent emitted an oversized output line'); buffer = ''; }
      if (error) stderr = buffer; else stdout = buffer;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => consume(chunk, false));
    child.stderr.setEncoding('utf8').on('data', chunk => consume(chunk, true));
    child.once('error', error => { failure = error; });
    child.once('exit', () => killStage('SIGKILL'));
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      forward(stdout); forward(stderr, true);
      if (failure) reject(failure);
      else if (code !== 0 || exitSignal) reject(new Error(`Agent exited ${exitSignal ?? code}`));
      else done();
    });
    if (signal.aborted) abort();
    });
    success = true;
  } finally {
    await isolated?.cleanup(success);
    if (prepared && !containmentFailed) stageSettled();
  }
}

export function stageEventEmitter(adapter: AgentAdapter | string, task: AgentTask, emit: (event: AgentEvent) => void): (event: AgentEvent) => void {
  let stageCost = 0;
  let costReported = false;
  const id = typeof adapter === 'string' ? adapter : adapter.id;
  const costReporting = typeof adapter === 'string' ? (id === 'codex' ? 'delta' : 'cumulative') : adapter.metadata?.costReporting
    ?? (id === 'codex' ? 'delta' : id === 'claude-code' ? 'cumulative' : undefined);
  if (!costReporting) throw new Error('Agent provider cost reporting metadata is unavailable');
  const { model, effort } = agentAttribution(id, task, task.review || task.prePr?.stage === 'review' ? 'review agent' : 'PR author');
  const context = { model, effort, stage: task.prePr?.stage ?? (task.review ? 'review' : undefined),
    round: task.prePr?.round ?? (task.review ? 1 : undefined) };
  return event => {
    const { costUsd, ...safe } = event;
    const validCost = Number.isFinite(costUsd) && (costUsd ?? -1) >= 0;
    const nextCost = validCost ? Math.max(stageCost, costUsd ?? 0) : stageCost;
    const delta = costReporting === 'delta' ? costUsd ?? 0 : nextCost - stageCost;
    const includeCost = validCost && (costReporting === 'delta' || !costReported || delta > 0);
    stageCost = nextCost;
    costReported ||= validCost;
    emit({ ...safe, ...context, provider: safe.provider ?? id, ...(includeCost ? { costUsd: delta } : {}) });
  };
}

async function retainedPrePrAdapters(task: AgentTask, legacyWriterId: 'codex' | 'claude-code' | undefined,
  reviewerCount: number, signal: AbortSignal): Promise<{ writerId: string; reviewerIds: string[]; adapters: Map<string, AgentAdapter>;
    workflow: WorkflowProviderV1 | undefined; dispose(): Promise<void> }> {
  if (!task.agentSelection) {
    if (task.workflow) throw new Error('Retained workflow requires a retained agent selection');
    if (!legacyWriterId) throw new Error('Recorded agent selection is required');
    const reviewerIds = reviewerCount === 1 ? [legacyWriterId] : [legacyWriterId, legacyWriterId === 'codex' ? 'claude-code' : 'codex'];
    return { writerId: legacyWriterId, reviewerIds, adapters: new Map(reviewerIds.map(id => [id, legacyAdapters[id]!])), workflow: undefined, dispose: async () => undefined };
  }
  const selection = parseAgentSelectionV1(task.agentSelection);
  const runtime = task.agentRuntime;
  if (!runtime || !Array.isArray(runtime.artifacts)) throw new Error('Recorded agent runtime is required');
  const writerId = selection.writer.binding.providerId;
  const reviewerIds = selection.reviewers.map(record => record.binding.providerId);
  const writerReviewer = selection.reviewers.find(record => record.binding.providerId === writerId);
  if (!reviewerIds.length || !task.workflow && reviewerIds.length !== reviewerCount || !writerReviewer
    || persistenceHash(writerReviewer) !== persistenceHash(selection.writer)) {
    throw new PrePrGateError('retained reviewer set must contain the exact writer record and match the retained policy.');
  }
  const records = new Map<string, AgentRetainedProviderV1>();
  for (const record of [selection.writer, ...selection.reviewers]) {
    if (!record.metadata.supportsPrePr) throw new PrePrGateError(`${record.binding.providerId} does not support the required pre-PR workflow.`);
    const prior = records.get(record.binding.providerId);
    if (prior && persistenceHash(prior) !== persistenceHash(record)) throw new PrePrGateError('retained provider identity is ambiguous.');
    records.set(record.binding.providerId, record);
  }
  const handles: Array<{ dispose(): Promise<void> }> = [];
  const adapters = new Map<string, AgentAdapter>();
  let workflow: Awaited<ReturnType<typeof loadExecutionWorkflow>> = null;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const handle of handles.splice(0).reverse()) {
      try { await handle.dispose(); } catch {}
    }
    if (workflow) {
      try { await workflow.dispose(); } catch {}
    }
  };
  try {
    workflow = await loadExecutionWorkflow(task, signal);
    workflow?.assertMode(task);
    for (const record of records.values()) {
      const loaded = await loadRetainedAgentProvider({ ...runtime, record, signal });
      handles.push(loaded);
      adapters.set(record.binding.providerId, agentProviderAdapter(record, loaded.provider,
        workflow ? renderTask => workflow!.renderPrompt(renderTask, record) : undefined));
    }
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return { writerId, reviewerIds, adapters, workflow: workflow?.provider, dispose };
}

export async function runPrePrRuntime(input: { task: AgentTask; writerId?: 'codex' | 'claude-code'; runsDir: string; settings?: PrePrSettings; publication?: PrePrPublicationConnection }, emit: (event: AgentEvent) => void): Promise<number> {
  const publication = validatePublicationConnection(input.publication);
  const cwd = process.cwd();
  const runId = basename(cwd);
  const settings = normalizePrePrSettings(input.settings);
  const abort = new AbortController();
  const stopped = () => abort.abort();
  process.once('SIGTERM', stopped);
  process.once('SIGINT', stopped);
  process.once('SIGHUP', stopped);
  const command = async (file: string, args: string[], dir = cwd) => {
    if (abort.signal.aborted) throw new Error('Voyage stopped');
    const result = await exec(file, args, { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, signal: abort.signal });
    return result.stdout.replace(/\r?\n$/, '');
  };
  const git = (args: string[], dir = cwd) => command('git', args, dir);
  let remote = '';
  const matchesRepository = async (name: string) => {
    for (const args of [['remote', 'get-url', '--all', name], ['remote', 'get-url', '--push', '--all', name]]) {
      const urls = (await git(args)).split('\n');
      if (!urls.length || urls.some(url => githubRepository(url) !== input.task.repo.toLowerCase())) return false;
    }
    return true;
  };
  const validateRemote = async () => {
    if (!remote || !(await matchesRepository(remote))) throw new Error('Selected remote does not match the voyage GitHub galleon');
  };
  let loaded: Awaited<ReturnType<typeof retainedPrePrAdapters>> | undefined;
  try {
    loaded = await retainedPrePrAdapters(input.task, input.writerId, settings.reviewerCount, abort.signal);
    const { writerId, reviewerIds, adapters } = loaded;
    const effectiveSettings = loaded.workflow ? { reviewerCount: reviewerIds.length,
      maxRounds: loaded.workflow.metadata.maxRounds, stageTimeoutMinutes: loaded.workflow.metadata.stageTimeoutMinutes } : settings;
    if (usesIsolatedExecution(input.task)) await sanitizeDockerGit(cwd, input.task.repo);
    emit({ kind: 'phase', text: `Pre-PR gate: ${reviewerIds.length} reviewer(s), up to ${effectiveSettings.maxRounds} rounds, ${effectiveSettings.stageTimeoutMinutes} minutes per session` });
    const initialHead = await git(['rev-parse', 'HEAD']);
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Author worktree must start clean');
    const matchingRemotes: string[] = [];
    for (const name of (await git(['remote'])).split('\n').filter(Boolean)) {
      if (await matchesRepository(name)) matchingRemotes.push(name);
    }
    remote = matchingRemotes.includes('origin') ? 'origin' : matchingRemotes.length === 1 ? matchingRemotes[0] ?? '' : '';
    if (!remote) throw new Error('Cannot select an unambiguous remote matching the voyage GitHub galleon');
    const repository: unknown = JSON.parse(await command('gh', ['repo', 'view', input.task.repo, '--json', 'nameWithOwner,defaultBranchRef']));
    const repo = repository as { nameWithOwner?: string; defaultBranchRef?: { name?: string } } | null;
    const baseBranch = repo?.defaultBranchRef?.name;
    if (repo?.nameWithOwner?.toLowerCase() !== input.task.repo.toLowerCase() || !baseBranch || baseBranch.startsWith('-')) throw new Error('Cannot determine the galleon default branch');
    await git(['check-ref-format', '--branch', baseBranch]);
    if (branch === baseBranch) throw new Error('Voyage must use a feature branch');
    await git(['fetch', '--no-tags', remote, `refs/heads/${baseBranch}`]);
    const currentBaseSha = await git(['merge-base', initialHead, 'FETCH_HEAD']);
    const checkpoint = input.task.prePrResume;
    const baseSha = checkpoint?.baseSha ?? currentBaseSha;
    if (checkpoint && (checkpoint.headSha !== initialHead || checkpoint.branch !== branch || checkpoint.baseSha !== currentBaseSha)) {
      throw new PrePrGateError('continuation checkpoint does not match the current branch, base, and head; work preserved.');
    }
    const artifactDir = resolve(input.runsDir, `${basename(cwd)}.pre-pr`);
    const relativeArtifacts = relative(cwd, artifactDir);
    if (!relativeArtifacts || (!relativeArtifacts.startsWith('..') && !isAbsolute(relativeArtifacts))) throw new Error('Pre-PR artifacts must be outside the author worktree');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    let metadataPath = '';
    const reviewedRounds = new Map<string, number>();
    const reviewedStages = new Map<string, string>();
    const runStage = async (id: string, task: AgentTask, dir: string) => {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`Retained agent provider ${id} is unavailable`);
      const forward = stageEventEmitter(adapter, task, emit);
      forward({ kind: 'phase', text: `Starting ${id} ${task.prePr?.stage ?? 'agent'} stage` });
      try {
        await executePrePrStage(adapter, task, dir, forward, abort.signal, effectiveSettings.stageTimeoutMinutes * 60_000);
      } catch (error) {
        forward({ kind: 'error', text: error instanceof Error ? error.message : 'Agent stage failed' });
        throw error;
      }
    };
    const snapshot = async () => {
      const headSha = await git(['rev-parse', 'HEAD']);
      await git(['merge-base', '--is-ancestor', baseSha, headSha]);
      return { baseSha, headSha, branch: await git(['symbolic-ref', '--quiet', '--short', 'HEAD']), clean: !(await git(['status', '--porcelain', '--untracked-files=all'])) };
    };
    const review = async (reviewerId: string, context: { baseSha: string; headSha: string; round: number }, savedReportPath?: string) => {
      const reviewerAdapter = adapters.get(reviewerId);
      if (!reviewerAdapter) throw new Error('Retained reviewer is unavailable');
      const scope = localReviewScope(await git(['diff', '--numstat', '--no-renames', '-z', context.baseSha, context.headSha]), context.headSha);
      const choice = selectReviewModel(scope, reviewerAdapter.metadata ?? reviewerId);
      emit({ kind: 'phase', text: `${reviewerId} review: ${choice.effort} effort — ${choice.reason}` });
      const savedReport = savedReportPath ? await readPrePrReport(savedReportPath) : undefined;
      let incompleteReview: NonNullable<AgentTask['prePr']>['incompleteReview'];
      if (savedReportPath) {
        try {
          const parsed = parsePrePrReview(savedReport, context);
          if (parsed.verdict === 'COMMENT') {
            await recordValidatedReport(input.runsDir, runId, { stage: 'review', round: context.round, reviewer: reviewerId }, savedReportPath);
            incompleteReview = { reportPath: savedReportPath, summary: parsed.summary };
          }
        } catch (error) { if (!(error instanceof PrePrSummaryTooLongError)) throw error; }
      }
      const attempt = incompleteReview ? randomUUID() : undefined;
      const reportStage = attempt ? `review-resume-${attempt}` : 'review';
      const root = await mkdtemp(join(tmpdir(), 'helmsman-review-'));
      const worktree = join(root, 'checkout');
      const reportPath = attempt ? join(artifactDir, prePrArtifactFilename('review', context.round, reviewerId).replace(/\.json$/, `.resume-${attempt}.json`))
        : savedReportPath ?? join(artifactDir, prePrArtifactFilename('review', context.round, reviewerId));
      try {
        if (!savedReportPath) await rm(reportPath, { force: true });
        if (usesIsolatedExecution(input.task)) {
          await git(['clone', '--no-hardlinks', '--no-local', cwd, worktree]);
          await git(['checkout', '--detach', context.headSha], worktree);
          await sanitizeDockerGit(worktree, input.task.repo);
        } else await git(['worktree', 'add', '--detach', worktree, context.headSha]);
        const reviewTask: AgentTask = { ...input.task, model: choice.model, effort: choice.effort,
          prePr: { stage: 'review', ...context, reportPath, ...(incompleteReview ? { incompleteReview } : {}) } };
        const assertReviewUnchanged = async () => {
          if ((await git(['rev-parse', 'HEAD'], worktree)) !== context.headSha
            || await git(['status', '--porcelain', '--untracked-files=all'], worktree)) throw new Error('Reviewer modified its immutable worktree');
        };
        if (!savedReportPath || incompleteReview) await runStage(reviewerId, reviewTask, worktree);
        if (savedReportPath && JSON.stringify(await readPrePrReport(savedReportPath)) !== JSON.stringify(savedReport)) {
          throw new PrePrGateError('review continuation modified the original report; publication blocked.');
        }
        await assertReviewUnchanged();
        const originalReport = await readPrePrReport(reportPath);
        try {
          const parsed = parsePrePrReview(originalReport, context);
          await recordValidatedReport(input.runsDir, runId, { stage: reportStage, round: context.round, reviewer: reviewerId }, reportPath);
          reviewedRounds.set(reviewerId, context.round);
          reviewedStages.set(reviewerId, reportStage);
          return parsed;
        } catch (error) {
          if (!(error instanceof PrePrSummaryTooLongError)) throw error;
          emit({ kind: 'phase', text: `${reviewerId}: ${error.message} Requesting one summary-only correction.` });
          const correctedPath = reportPath.endsWith('.corrected.json') ? reportPath : reportPath.replace(/\.json$/, '.corrected.json');
          if (correctedPath === reportPath) throw new PrePrGateError('saved corrected summary is still too long; publication blocked.');
          await rm(correctedPath, { force: true });
          try {
            await runStage(reviewerId, { ...reviewTask, prePr: { stage: 'review', ...context, reportPath: correctedPath,
              summaryCorrection: { reportPath, actualLength: error.actualLength } } }, worktree);
            await assertReviewUnchanged();
            if (JSON.stringify(await readPrePrReport(reportPath)) !== JSON.stringify(originalReport)) {
              throw new PrePrGateError('summary correction modified the original report; publication blocked.');
            }
            const corrected = parsePrePrReview(await readPrePrReport(correctedPath), context);
            assertReviewSummaryCorrection(error.report, corrected);
            await recordValidatedReport(input.runsDir, runId, { stage: reportStage, round: context.round, reviewer: reviewerId }, correctedPath);
            reviewedRounds.set(reviewerId, context.round);
            reviewedStages.set(reviewerId, reportStage);
            return corrected;
          } catch (correctionError) {
            throw new PrePrGateError(`${reviewerId} summary correction failed after one attempt; publication blocked. ${correctionError instanceof Error ? correctionError.message : String(correctionError)}`);
          }
        }
      } finally {
        if (!usesIsolatedExecution(input.task)) {
          try { await exec('git', ['worktree', 'remove', '--force', worktree], { cwd, timeout: 15_000 }); } catch { /* Failed worktree creation needs no git cleanup. */ }
        }
        await rm(root, { recursive: true, force: true });
      }
    };
    let resume: PrePrResumeCheckpoint | undefined;
    if (checkpoint) {
      if (!Number.isInteger(checkpoint.round) || checkpoint.round < 1 || checkpoint.round > effectiveSettings.maxRounds
        || !checkpoint.reviewerReports || typeof checkpoint.reviewerReports !== 'object'
        || Object.keys(checkpoint.reviewerReports).length !== reviewerIds.length
        || reviewerIds.some(id => typeof checkpoint.reviewerReports[id] !== 'string')) {
        throw new PrePrGateError('continuation requires the original complete reviewer set and a valid review round.');
      }
      const assertArtifactPath = (path: string) => {
        if (typeof path !== 'string' || !isAbsolute(path) || resolve(path, '..') !== artifactDir) {
          throw new PrePrGateError('continuation report must be in this voyage artifact directory.');
        }
      };
      assertArtifactPath(checkpoint.metadataPath);
      parsePrMetadata(await readPrePrReport(checkpoint.metadataPath), input.task);
      metadataPath = checkpoint.metadataPath;
      const reviews: PrePrResumeCheckpoint['reviews'] = [];
      for (const reviewer of reviewerIds) {
        const path = checkpoint.reviewerReports[reviewer]!;
        assertArtifactPath(path);
        if (path !== join(artifactDir, prePrArtifactFilename('review', checkpoint.round, reviewer))
          && path !== join(artifactDir, prePrArtifactFilename('review', checkpoint.round, reviewer, true))) {
          throw new PrePrGateError('continuation must use each reviewer’s original report for the checkpoint round.');
        }
        try { parsePrePrReview(await readPrePrReport(path), checkpoint); }
        catch (error) { if (!(error instanceof PrePrSummaryTooLongError)) throw error; }
      }
      emit({ kind: 'phase', text: `Continuing preserved revision ${initialHead} from review round ${checkpoint.round}; implementation will not be repeated` });
      for (const reviewer of reviewerIds) {
        reviews.push({ reviewer, report: await review(reviewer, checkpoint, checkpoint.reviewerReports[reviewer]) });
      }
      resume = { baseSha, headSha: initialHead, branch, round: checkpoint.round, reviews };
    }
    return await runPrePrWorkflow(input.task, {
      writerId, reviewerIds, maxRounds: effectiveSettings.maxRounds, workflow: loaded.workflow, resume, snapshot, isStopped: () => abort.signal.aborted,
      onPhase: text => emit({ kind: 'phase', text }),
      runAuthor: async (stage, context) => {
        metadataPath = join(artifactDir, prePrArtifactFilename(stage, context.round));
        await rm(metadataPath, { force: true });
        await runStage(writerId, { ...input.task, prePr: { stage, ...context, reportPath: metadataPath } }, cwd);
        parsePrMetadata(await readPrePrReport(metadataPath), input.task);
        await recordValidatedReport(input.runsDir, runId, { stage, round: context.round }, metadataPath);
        if (!(await git(['diff', '--name-only', baseSha, 'HEAD']))) throw new Error('Author produced an empty overall diff');
      },
      review,
      publish: async expected => {
        parsePrMetadata(await readPrePrReport(metadataPath), input.task);
        const assertApproved = async () => {
          const actual = await snapshot();
          if (!actual.clean || actual.branch !== branch || actual.headSha !== expected.headSha || actual.baseSha !== expected.baseSha) throw new Error('Approved revision changed before publication');
          await validateRemote();
        };
        await assertApproved();
        await assertClarificationReady(input.task, runId);
        const round = reviewedRounds.get(writerId);
        const metadata = /^(implement|fix)-(\d+)\.json$/.exec(basename(metadataPath));
        if (!round || reviewerIds.some(id => reviewedRounds.get(id) !== round) || !metadata?.[1] || !metadata[2]) throw new Error('Publication review evidence is incomplete');
        const reviewStages = Object.fromEntries([...reviewedStages].filter(([, stage]) => stage !== 'review'));
        return publishApprovedRevision(publication, { version: 1, kind: 'pre-pr', approved: { ...expected, baseBranch, round, reviewers: reviewerIds,
          ...(Object.keys(reviewStages).length ? { reviewStages } : {}),
          metadata: { stage: metadata[1] as 'implement' | 'fix', round: Number(metadata[2]) } } }, abort.signal);
      },
    });
  } finally {
    await loaded?.dispose();
    process.removeListener('SIGTERM', stopped);
    process.removeListener('SIGINT', stopped);
    process.removeListener('SIGHUP', stopped);
  }
}
