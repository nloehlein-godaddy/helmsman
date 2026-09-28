import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { PRE_PR_SETTING_DEFINITIONS, parsePrePrSettingValue, type PrePrSettings } from '../../src/logic/prePrSettings';
import type { AgentTask } from './agents/adapter';
import { isPrePrAdapter, prePrAdapter } from './agents/pre-pr';
import type { PrePrPublicationConnection } from './publication-client';
import type { Db, RunRow } from './db';
import { readExitEvidence, type HostRef, type LaunchSpec, type RunHost } from './run-host';
import type { DurableRunnerCoordinator } from './runner';
import { parsePrMetadata, readPrePrReport } from './pre-pr-runtime';
import { parsePrePrReview, PrePrSummaryTooLongError } from './pre-pr-workflow';
import { createRunArtifactStore, prePrArtifactFilename } from './artifacts';
import { parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { parseAgentSelectionV1 } from './agent-providers';
import { persistenceHash } from './persistence';

const exec = promisify(execFile);

export class ResumeError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function verifyArtifactIfPresent(runsDir: string, runId: string, identity: { stage: string; round: number; reviewer?: string }, path: string,
  required = false): Promise<boolean> {
  const store = createRunArtifactStore(join(runsDir, '.artifacts'));
  let manifest;
  try { manifest = await store.manifest({ runId, ...identity }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return false;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResumeError('The immutable report manifest is required for a retained agent continuation.');
    throw new ResumeError('The immutable report manifest could not be verified.');
  }
  await store.verify({ runId, ...identity });
  const bytes = await readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.sha256 || bytes.byteLength !== manifest.bytes) throw new ResumeError('A report changed after its immutable artifact was recorded.');
  return true;
}

export async function inspectPrePrContinuation(row: RunRow, runsDir: string) {
  if (row.status !== 'failed' || !isPrePrAdapter(row.adapter) || row.prNumber !== null || !row.worktreePath
    || !/^[a-z\d_-]{1,128}$/i.test(row.id) || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    throw new ResumeError('Only failed pre-PR voyages with a retained worktree can continue.');
  }
  const task = record(JSON.parse(row.taskJson ?? 'null'));
  if (!task || task.repo !== row.repo || task.ticketId !== row.ticketId || typeof task.title !== 'string'
    || typeof task.jiraBaseUrl !== 'string' || task.review || task.prBranch || task.prNumber) {
    throw new ResumeError('The original voyage task is incomplete or cannot continue from a pre-PR checkpoint.');
  }
  if (task.todoId) throw new ResumeError('Local todo voyages must use Retry from Todos.');
  const root = resolve(runsDir);
  const base = row.specPath === join(root, `${row.id}.attempt-${row.attempt}.json`) ? `${row.id}.attempt-${row.attempt}` : row.id;
  const logPath = join(root, `${base}.log`);
  const exitPath = join(root, `${base}.exit`);
  const specPath = join(root, `${base}.json`);
  if (row.logPath !== logPath || row.exitPath !== exitPath || row.specPath !== specPath) {
    throw new ResumeError('The saved voyage files do not match the configured runs directory.');
  }
  for (const path of [logPath, exitPath, specPath]) {
    if (!(await lstat(path)).isFile()) throw new ResumeError('Voyage log, exit marker, and launch specification must be regular files.');
  }
  const spec = record(await readPrePrReport(specPath));
  if (spec?.launchId) {
    const evidence = await readExitEvidence({ ...spec, runId: row.id, attempt: row.attempt, specPath, exitPath } as unknown as LaunchSpec);
    if (!evidence || evidence.exitCode === 0) throw new ResumeError('The previous worker has no verified failed exit for this attempt.');
  } else {
    const exit = (await readFile(exitPath, 'utf8')).trim();
    if (!/^[1-9]\d*$/.test(exit)) throw new ResumeError('The previous worker has not recorded a failed exit.');
  }
  const logSize = (await lstat(logPath)).size;
  if (row.logOffset !== logSize) throw new ResumeError('The original log must be fully processed before continuing.');
  const args = spec?.args;
  const original = Array.isArray(args) && typeof args.at(-1) === 'string' ? record(JSON.parse(args.at(-1))) : null;
  const originalTask = record(original?.task);
  const selection = task.agentSelection === undefined ? undefined : parseAgentSelectionV1(task.agentSelection);
  const writerId = selection?.writer.binding.providerId
    ?? (row.adapter === 'pre-pr:codex' ? 'codex' : row.adapter === 'pre-pr:claude-code' ? 'claude-code' : '');
  const legacy = writerId === 'codex' || writerId === 'claude-code';
  if (!writerId || row.adapter !== `pre-pr:${writerId}` || spec?.cwd !== row.worktreePath
    || (legacy && original?.writerId !== writerId) || (!legacy && original?.writerId !== undefined)
    || original?.runsDir !== root
    || originalTask?.repo !== row.repo || originalTask?.ticketId !== row.ticketId) {
    throw new ResumeError('The saved worker specification does not match the voyage.');
  }
  if (selection && persistenceHash(originalTask?.agentSelection) !== persistenceHash(selection)) {
    throw new ResumeError('The retained agent selection differs from the original worker specification.');
  }
  if (selection && persistenceHash(originalTask?.agentRuntime) !== persistenceHash(task.agentRuntime)) {
    throw new ResumeError('The retained agent artifact closure differs from the original worker specification.');
  }
  if (task.executionHost !== undefined) {
    parseExecutionHostRetainedProviderV1(task.executionHost);
    for (const field of ['executionHost', 'hostRuntime', 'hostConfiguration'] as const) {
      if (persistenceHash(task[field]) !== persistenceHash(originalTask?.[field])) throw new ResumeError('The retained execution host differs from the original worker specification.');
    }
  }
  const savedSettings = record(original?.settings);
  const settings = {} as PrePrSettings;
  for (const definition of PRE_PR_SETTING_DEFINITIONS) {
    const value = parsePrePrSettingValue(savedSettings?.[definition.key], definition);
    if (value === undefined) throw new ResumeError('The saved review settings are missing or invalid.');
    settings[definition.key] = value;
  }
  const cwd = await realpath(row.worktreePath);
  const git = async (args: string[]) => (await exec('git', args, { cwd, timeout: 15_000, encoding: 'utf8' })).stdout.trim();
  if (basename(cwd) !== row.id || await realpath(await git(['rev-parse', '--show-toplevel'])) !== cwd
    || await git(['status', '--porcelain', '--untracked-files=all'])) throw new ResumeError('The retained voyage worktree must be clean and unchanged.');
  const headSha = await git(['rev-parse', 'HEAD']);
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== `agent/${row.id}`) throw new ResumeError('The retained voyage branch has changed.');
  const artifactDir = join(root, `${row.id}.pre-pr`);
  if (!(await lstat(artifactDir)).isDirectory()) throw new ResumeError('The review checkpoint directory is unavailable.');
  const files = new Set(await readdir(artifactDir));
  const reviewers = selection?.reviewers.map(record => record.binding.providerId)
    ?? (settings.reviewerCount === 1 ? [writerId] : [writerId, writerId === 'codex' ? 'claude-code' : 'codex']);
  if (reviewers.length !== settings.reviewerCount || !reviewers.includes(writerId)) throw new ResumeError('The original retained reviewer set is incomplete.');
  const rounds = Array.from({ length: settings.maxRounds }, (_, index) => index + 1)
    .filter(round => reviewers.every(reviewer => files.has(prePrArtifactFilename('review', round, reviewer))
      || files.has(prePrArtifactFilename('review', round, reviewer, true))));
  const round = Math.max(0, ...rounds);
  if (!round || round > settings.maxRounds) throw new ResumeError('There is no valid completed review round to continue.');
  const reviewerReports: Record<string, string> = {};
  let baseSha = '';
  for (const reviewer of reviewers) {
    const identity = { stage: 'review', round, reviewer };
    const corrected = prePrArtifactFilename('review', round, reviewer, true);
    const correctedPath = join(artifactDir, corrected);
    const useCorrected = files.has(corrected)
      && await verifyArtifactIfPresent(runsDir, row.id, identity, correctedPath, Boolean(selection));
    const path = useCorrected ? correctedPath : join(artifactDir, prePrArtifactFilename('review', round, reviewer));
    if (!useCorrected) await verifyArtifactIfPresent(runsDir, row.id, identity, path, Boolean(selection));
    const value = await readPrePrReport(path);
    const raw = record(value);
    if (!baseSha && typeof raw?.baseSha === 'string') baseSha = raw.baseSha;
    try { parsePrePrReview(value, { baseSha, headSha }); }
    catch (error) { if (!(error instanceof PrePrSummaryTooLongError)) throw error; }
    reviewerReports[reviewer] = path;
  }
  await git(['merge-base', '--is-ancestor', baseSha, headSha]);
  if (baseSha === headSha) throw new ResumeError('The checkpoint contains no committed implementation.');
  const metadataPath = join(artifactDir, prePrArtifactFilename(round === 1 ? 'implement' : 'fix', round === 1 ? 0 : round - 1));
  await verifyArtifactIfPresent(runsDir, row.id, { stage: round === 1 ? 'implement' : 'fix', round: round === 1 ? 0 : round - 1 }, metadataPath, Boolean(selection));
  parsePrMetadata(await readPrePrReport(metadataPath), task as unknown as AgentTask);
  const resumedTask: AgentTask = { ...task as unknown as AgentTask, prePrResume: { baseSha, headSha, branch, round, reviewerReports, metadataPath } };
  return { task: resumedTask, settings, writerId, cwd: row.worktreePath, logPath, exitPath, specPath, logSize };
}

export async function resumeFailedPrePrRun(row: RunRow, deps: { publication?: PrePrPublicationConnection; durable?: DurableRunnerCoordinator; db: Db; host: RunHost; runsDir: string; now(): string; isStopped?(): boolean; prepareTask?(task: AgentTask): Promise<AgentTask> }): Promise<RunRow> {
  let checkpoint: Awaited<ReturnType<typeof inspectPrePrContinuation>>;
  try { checkpoint = await inspectPrePrContinuation(row, deps.runsDir); }
  catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError(`The retained review checkpoint could not be verified: ${error instanceof Error ? error.message : 'invalid checkpoint'}`);
  }
  if (deps.isStopped?.()) throw new ResumeError('Continuation was cancelled before launch.');
  const priorRef = record(row.hostRef ? JSON.parse(row.hostRef) : null);
  if (row.hostKind !== deps.host.kind || !priorRef || priorRef.kind !== deps.host.kind
    || priorRef.kind === 'detached' && (!Number.isSafeInteger(priorRef.pid) || Number(priorRef.pid) < 1)
    || priorRef.kind === 'cmux' && typeof priorRef.workspace !== 'string') {
    throw new ResumeError('The saved worker host does not match the configured host.');
  }
  if (!deps.durable && await deps.host.isAlive(priorRef as unknown as HostRef)) throw new ResumeError('The previous worker host is still active. Stop it before continuing.');
  const current = deps.db.getRun(row.id);
  if (!current || current.status !== 'failed' || current.attempt !== row.attempt || current.taskJson !== row.taskJson) {
    throw new ResumeError('The voyage changed while its checkpoint was being verified.');
  }
  if (deps.durable) {
    const retained = await deps.durable.recover(row);
    retained.close();
  }
  const retainedAgentRuntime = checkpoint.task.agentRuntime ? persistenceHash(checkpoint.task.agentRuntime) : null;
  const retainedAgentSelection = checkpoint.task.agentSelection ? persistenceHash(checkpoint.task.agentSelection) : null;
  const hostState = (task: AgentTask) => persistenceHash([task.executionHost ?? null, task.hostRuntime ?? null, task.hostConfiguration ?? null]);
  const retainedHost = hostState(checkpoint.task);
  const previousSnapshotId = checkpoint.task.workflowSnapshotId;
  if (deps.prepareTask) checkpoint.task = await deps.prepareTask(checkpoint.task);
  if (hostState(checkpoint.task) !== retainedHost) throw new ResumeError('Continuation must retain the original execution host configuration.');
  if ((checkpoint.task.agentRuntime ? persistenceHash(checkpoint.task.agentRuntime) : null) !== retainedAgentRuntime
    || (checkpoint.task.agentSelection ? persistenceHash(checkpoint.task.agentSelection) : null) !== retainedAgentSelection) {
    throw new ResumeError('Continuation must retain the original agent provider records and artifact closure.');
  }
  const recordPromptUpgrade = () => {
    if (previousSnapshotId && checkpoint.task.workflowSnapshotId && previousSnapshotId !== checkpoint.task.workflowSnapshotId) {
      deps.db.appendEvent(row.id, 'phase', `Explicit continuation upgraded prompt snapshot ${previousSnapshotId} to ${checkpoint.task.workflowSnapshotId}; prior workflow choices, verified skills, and original history retained.`, deps.now());
    }
  };
  const adapter = prePrAdapter(checkpoint.writerId, resolve(deps.runsDir), checkpoint.settings, deps.publication);
  const command = adapter.buildCommand(checkpoint.task);
  if (deps.durable) {
    const next = { ...row, status: 'running' as const, attempt: row.attempt + 1, endedAt: null,
      taskJson: JSON.stringify(checkpoint.task), hostKind: null, hostRef: null, logOffset: 0 };
    const attempt = await deps.durable.prepare(next, checkpoint.task);
    let leaseError: unknown;
    const heartbeat = setInterval(() => { try { attempt.renew(); } catch (error) { leaseError = error; } }, 10_000);
    heartbeat.unref();
    try {
      attempt.ready(checkpoint.cwd);
      if (deps.isStopped?.()) throw new ResumeError('Continuation was cancelled before launch.');
      attempt.launching();
      const ref = await deps.host.launch({ runId: row.id, ...command, cwd: checkpoint.cwd, ...attempt.paths,
        launchId: attempt.launchId, attempt: attempt.attempt });
      if (leaseError) throw leaseError;
      attempt.launched(ref, { launchId: attempt.launchId, attempt: attempt.attempt, ref });
      recordPromptUpgrade();
      deps.db.appendEvent(row.id, 'phase', `Continuing preserved revision ${checkpoint.task.prePrResume?.headSha} from review round ${checkpoint.task.prePrResume?.round}; original implementation and history retained.`, deps.now());
      const resumed = deps.db.getRun(row.id);
      if (!resumed) throw new ResumeError('The resumed voyage could not be read.');
      return resumed;
    } catch (error) {
      try { attempt.attachment('blocked', error instanceof Error ? error.message : 'Continuation launch needs reconciliation'); } catch {}
      throw new ResumeError('Continuation ownership needs reconciliation; its files and reservation are retained.');
    } finally { clearInterval(heartbeat); try { attempt.close(); } catch {} }
  }
  const archive = join(resolve(deps.runsDir), `${row.id}.attempt-${row.attempt}-${randomUUID()}`);
  await mkdir(archive, { mode: 0o700 });
  await copyFile(checkpoint.specPath, join(archive, 'spec.json'), constants.COPYFILE_EXCL);
  await rename(checkpoint.exitPath, join(archive, 'exit'));
  let ref: HostRef | undefined;
  try {
    if (deps.isStopped?.()) throw new ResumeError('Continuation was cancelled before launch.');
    deps.db.updateRun(row.id, { status: 'running', endedAt: null, attempt: row.attempt + 1,
      taskJson: JSON.stringify(checkpoint.task), hostKind: null, hostRef: null });
    ref = await deps.host.launch({ runId: row.id, ...command, cwd: checkpoint.cwd,
      logPath: checkpoint.logPath, exitPath: checkpoint.exitPath, specPath: checkpoint.specPath });
    deps.db.updateRun(row.id, { hostKind: ref.kind, hostRef: JSON.stringify(ref) });
    recordPromptUpgrade();
    deps.db.appendEvent(row.id, 'phase', `Continuing preserved revision ${checkpoint.task.prePrResume?.headSha} from review round ${checkpoint.task.prePrResume?.round}; original implementation and history retained.`, deps.now());
    const resumed = deps.db.getRun(row.id);
    if (!resumed) throw new Error('The resumed voyage could not be read.');
    return resumed;
  } catch (error) {
    if (ref) await deps.host.stop(ref);
    await rm(checkpoint.exitPath, { force: true });
    await copyFile(join(archive, 'spec.json'), checkpoint.specPath);
    await rename(join(archive, 'exit'), checkpoint.exitPath);
    deps.db.updateRun(row.id, row);
    throw error instanceof ResumeError ? error : new ResumeError('The continuation worker could not start; the failed voyage was preserved.');
  }
}
