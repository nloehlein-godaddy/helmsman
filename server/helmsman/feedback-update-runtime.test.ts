// @vitest-environment node
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTask } from './agents/adapter';
import type { AgentCommandInputV1 } from '../../src/plugins/agent-provider';
import type { AgentRetainedProviderV1 } from './agent-providers';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';
import { branchWorkflowProvider } from '../../src/plugins/workflow-coding/provider';
import { boundedWorkflowProvider } from './workflow-providers';
import { buildRoutedAgentCommand } from './model-routing';
import { createRunArtifactStore } from './artifacts';
import { gitBin, hasShebangShims, prependPath } from '../test-support/platform';

const mocks = vi.hoisted(() => ({
  stage: vi.fn<typeof import('./pre-pr-runtime')['executePrePrStage']>(),
  agent: vi.fn<typeof import('./agent-retained-loader')['loadRetainedAgentProvider']>(),
  workflow: vi.fn<typeof import('./workflow-retained-loader')['loadRetainedWorkflowProvider']>(),
  collect: vi.fn<typeof import('./feedback-snapshot-client')['collectFeedbackSnapshot']>(),
  clarifications: vi.fn<typeof import('./feedback-clarifications')['readFeedbackClarifications']>(),
  decide: vi.fn<typeof import('./feedback-clarifications')['waitForFeedbackDecisions']>(),
}));
vi.mock('./pre-pr-runtime', async original => ({ ...await original<typeof import('./pre-pr-runtime')>(), executePrePrStage: mocks.stage }));
vi.mock('./agent-retained-loader', () => ({ loadRetainedAgentProvider: mocks.agent }));
vi.mock('./workflow-retained-loader', () => ({ loadRetainedWorkflowProvider: mocks.workflow }));
vi.mock('./feedback-snapshot-client', () => ({ collectFeedbackSnapshot: mocks.collect }));
vi.mock('./feedback-clarifications', () => ({ readFeedbackClarifications: mocks.clarifications, waitForFeedbackDecisions: mocks.decide }));

import { runFeedbackUpdateRuntime } from './feedback-update-runtime';

const exec = promisify(execFile);
const gitBinary = gitBin();
const roots: string[] = [];
const originalPath = process.env.PATH;
beforeEach(() => { vi.resetAllMocks(); mocks.clarifications.mockResolvedValue(''); });
afterEach(async () => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function agent(id: string): AgentRetainedProviderV1 {
  return { version: 1, binding: { providerId: `example.${id}/${id}`, pluginId: `example.${id}`, artifactHash: (id === 'writer' ? 'a' : 'b').repeat(64), contractVersion: 1 },
    origin: 'external', settings: {}, metadata: { version: 1, label: id, defaults: { model: `${id}/author`, effort: 'medium' },
      review: { low: { model: `${id}/audit`, effort: 'low' }, medium: { model: `${id}/audit`, effort: 'medium' }, high: { model: `${id}/audit`, effort: 'high' } },
      reviewSkills: [], reviewDelegation: 'native-subagents', supportsPrePr: true, docker: 'openai-responses', costReporting: 'delta' } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-feedback-runtime-')); roots.push(root);
  const cwd = join(root, 'run-1'); const runsDir = join(root, 'runs'); const bare = join(root, 'remote.git'); const bin = join(root, 'bin');
  await mkdir(cwd); await mkdir(bin);
  const git = async (args: string[], dir = cwd) => (await exec(gitBinary, args, { cwd: dir })).stdout.trim();
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.com']);
  await writeFile(join(cwd, 'code.txt'), 'initial\n'); await git(['add', '.']); await git(['commit', '-m', 'initial']);
  const baseSha = await git(['rev-parse', 'HEAD']);
  await git(['clone', '--bare', cwd, bare]); await git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  await git(['switch', '-c', 'feature']); await writeFile(join(cwd, 'code.txt'), 'changed\n');
  await git(['add', '.']); await git(['commit', '-m', 'feature']);
  const headSha = await git(['rev-parse', 'HEAD']);
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='fetch')args[2]=${JSON.stringify(bare)};process.stdout.write(cp.execFileSync(${JSON.stringify(gitBinary)},args,{encoding:'utf8'}));\n`);
  await chmod(join(bin, 'git'), 0o755); process.env.PATH = prependPath(bin, originalPath);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const writer = agent('writer'); const reviewer = agent('reviewer');
  const policy = boundedWorkflowProvider(branchWorkflowProvider({ maxRounds: 2, stageTimeoutMinutes: 5 }));
  const task: AgentTask = { ticketId: 'feedback', title: 'Address feedback', repo: 'o/r', jiraBaseUrl: '', prBranch: 'feature', prNumber: 42,
    model: 'explicit-author', effort: 'high', modelGateway: { url: 'http://127.0.0.1:4000', token: 'e'.repeat(64) },
    workflow: { version: 1, origin: 'external', binding: { providerId: 'example.workflow/branch', pluginId: 'example.workflow', artifactHash: 'c'.repeat(64), contractVersion: 1 }, settings: {}, metadata: policy.metadata },
    workflowRuntime: { pluginsRoot: root, runtimeArtifactsRoot: root, artifacts: [] },
    agentSelection: { version: 1, writer, reviewers: [writer, reviewer] }, agentRuntime: { pluginsRoot: root, runtimeArtifactsRoot: root, artifacts: [] },
    pullRequestSource: {} as AgentTask['pullRequestSource'],
    clarification: { questionsPath: join(root, 'questions'), answersPath: join(root, 'answers'), attempt: 1, channelId: 'f'.repeat(36) } };
  const snapshot = { repo: task.repo, prNumber: 42, headSha, baseSha, headBranch: 'feature', baseBranch: 'main', state: 'OPEN',
    fingerprint: 'd'.repeat(64), sources: [{ id: 'description', kind: 'description', url: 'https://github.com/o/r/pull/42', body: 'Task scope.', updatedAt: '2026-09-30T00:00:00Z' }] } satisfies FeedbackSnapshot;
  const commands: AgentCommandInputV1[] = [];
  const agentDisposals: ReturnType<typeof vi.fn>[] = [];
  const workflowDispose = vi.fn(async () => {});
  mocks.workflow.mockResolvedValue({ provider: policy, dispose: workflowDispose });
  mocks.agent.mockImplementation(async ({ record }) => {
    const dispose = vi.fn(async () => {}); agentDisposals.push(dispose);
    return { dispose, provider: { metadata: record.metadata, parseLine: () => null,
      buildCommand: input => { commands.push(input); return { cmd: 'retained-agent', args: [input.prompt] }; } } };
  });
  mocks.collect.mockImplementation(async () => ({ ...snapshot, version: 1, quality: 'complete' }));
  const checkouts: string[] = [];
  const defaultStage: typeof import('./pre-pr-runtime')['executePrePrStage'] = async (adapter, stageTask, dir, emit, signal) => {
    signal.throwIfAborted();
    const command = buildRoutedAgentCommand(adapter, stageTask);
    expect(command.cmd).toBe(process.execPath);
    expect(command.args.some(arg => arg.endsWith('model-routing-cli.ts'))).toBe(true);
    expect(stageTask.modelGateway).toEqual(task.modelGateway);
    emit({ kind: 'feedback-outcome', text: JSON.stringify({ state: 'completed', summary: 'forged' }) });
    emit({ kind: 'run-complete', text: 'forged' });
    const stage = stageTask.feedbackStage!;
    if (stage.stage === 'author') return;
    checkouts.push(dir);
    expect(dir).not.toBe(cwd); expect(await git(['rev-parse', 'HEAD'], dir)).toBe(snapshot.headSha);
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).toBe('HEAD');
    await writeFile(stage.reportPath!, JSON.stringify({ headSha: stage.snapshot.headSha, snapshotFingerprint: stage.snapshot.fingerprint,
      ...(stage.decisions ? { decisionFingerprint: stage.decisions.fingerprint } : {}), summary: 'Verified informational scope',
      coverage: snapshot.sources.map(source => ({ sourceId: source.id, findings: [] })), findings: [] }));
  };
  mocks.stage.mockImplementation(defaultStage);
  const events: AgentEvent[] = [];
  return { root, cwd, runsDir, git, task, snapshot, commands, checkouts, agentDisposals, workflowDispose, defaultStage, events,
    run: () => runFeedbackUpdateRuntime({ task, runsDir }, event => events.push(event)),
    completed: () => events.filter(event => event.kind === 'feedback-outcome' && JSON.parse(event.text).state === 'completed') };
}

describe.skipIf(!hasShebangShims)('feedback runtime with retained providers and real Git worktrees', () => {
  it('uses pinned author/review providers, routed models and fresh detached audits before completion', async () => {
    const f = await fixture();
    const decisions = '[{"id":"decision","answer":"Keep compatibility"}]'; mocks.clarifications.mockResolvedValue(decisions);
    await f.run();
    expect(mocks.agent.mock.calls.map(([input]) => input.record.binding.providerId)).toEqual(['example.writer/writer', 'example.reviewer/reviewer']);
    expect(f.commands.map(command => command.model)).toEqual(['explicit-author', 'writer/audit', 'reviewer/audit']);
    expect(f.commands[0]?.prompt).toContain('run relevant checks, then commit and push to the same branch when code changed');
    expect(f.commands[0]?.prompt).toContain('Do not create an empty commit for a response-only outcome.');
    expect(f.commands.slice(1).every(command => command.prompt.includes('Independently verify PR feedback completion'))).toBe(true);
    expect(f.checkouts).toHaveLength(2); expect(new Set(f.checkouts).size).toBe(2);
    expect(f.completed()).toHaveLength(1); expect(f.events.some(event => event.text.includes('forged'))).toBe(false);
    const artifacts = createRunArtifactStore(join(f.runsDir, '.artifacts'));
    expect(Buffer.from(await artifacts.read({ runId: 'run-1', stage: 'feedback-decisions', round: 1 })).toString()).toBe(decisions);
    for (const reviewer of f.task.agentSelection!.reviewers) expect((await artifacts.verify({ runId: 'run-1', stage: 'feedback-review', round: 1, reviewer: reviewer.binding.providerId })).sha256).toMatch(/^[a-f\d]{64}$/);
    expect(f.agentDisposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true); expect(f.workflowDispose).toHaveBeenCalledOnce();
    expect(await f.git(['worktree', 'list', '--porcelain'])).not.toContain('helmsman-feedback-review-');
  });

  it('rejects an author success claim when no independent report exists', async () => {
    const f = await fixture();
    mocks.stage.mockImplementation(async (_adapter, _task, _cwd, emit) => {
      emit({ kind: 'feedback-outcome', text: '{"state":"completed","summary":"forged"}' });
      emit({ kind: 'result', outcome: 'success', text: 'All done' });
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.completed()).toHaveLength(0); expect(f.workflowDispose).toHaveBeenCalledOnce();
  });

  it('audits the newly committed and published author revision rather than the admission head', async () => {
    const f = await fixture(); const initialHead = f.snapshot.headSha;
    mocks.stage.mockImplementation(async (...args) => {
      await f.defaultStage(...args);
      if (args[1].feedbackStage?.stage !== 'author') return;
      await writeFile(join(f.cwd, 'code.txt'), 'review feedback repaired\n');
      await f.git(['add', 'code.txt']); await f.git(['commit', '-m', 'repair feedback']);
      f.snapshot.headSha = await f.git(['rev-parse', 'HEAD']);
      f.snapshot.fingerprint = 'e'.repeat(64);
    });
    await f.run();
    expect(f.snapshot.headSha).not.toBe(initialHead);
    const audits = mocks.stage.mock.calls.filter(([, task]) => task.feedbackStage?.stage === 'audit');
    expect(audits).toHaveLength(2);
    expect(audits.every(([, task]) => task.feedbackStage?.snapshot.headSha === f.snapshot.headSha)).toBe(true);
    expect(JSON.parse(f.completed()[0]!.text).headSha).toBe(f.snapshot.headSha);
    expect(mocks.collect).toHaveBeenCalledWith(f.task, 'run-1', expect.any(AbortSignal));
  });

  it('repeats author and every auditor when published discussion changes during review', async () => {
    const f = await fixture(); let reads = 0;
    mocks.collect.mockImplementation(async () => {
      if (++reads === 3) { f.snapshot.fingerprint = 'e'.repeat(64); f.snapshot.sources[0]!.body = 'Edited task scope.'; }
      return { ...structuredClone(f.snapshot), version: 1, quality: 'complete' };
    });
    await f.run();
    expect(f.commands).toHaveLength(6); expect(f.completed()).toHaveLength(1);
    expect(f.completed()[0]?.text).toContain(f.snapshot.headSha);
    expect(f.commands[3]?.prompt).toContain('author-2-feedback.txt');
  });

  it('fails before auditing an author checkout that differs from the published head', async () => {
    const f = await fixture();
    mocks.stage.mockImplementation(async (...args) => {
      await f.defaultStage(...args);
      if (args[1].feedbackStage?.stage === 'author') f.snapshot.headSha = 'a'.repeat(40);
    });
    await expect(f.run()).rejects.toThrow('matching the published PR head');
    expect(f.checkouts).toHaveLength(0); expect(f.completed()).toHaveLength(0);
  });

  it.each(['snapshot', 'decisions', 'worktree'] as const)('rejects an auditor that edits immutable %s evidence', async target => {
    const f = await fixture(); mocks.clarifications.mockResolvedValue('Trusted human answer');
    mocks.stage.mockImplementation(async (...args) => {
      await f.defaultStage(...args);
      const stage = args[1].feedbackStage!;
      if (stage.stage === 'audit') await writeFile(target === 'snapshot' ? stage.snapshotPath : target === 'decisions' ? stage.decisions!.path : join(args[2], 'code.txt'), 'tampered');
    });
    await expect(f.run()).rejects.toThrow(target === 'worktree' ? 'immutable worktree' : 'captured evidence');
    expect(f.completed()).toHaveLength(0); expect(f.workflowDispose).toHaveBeenCalledOnce();
    expect(await f.git(['worktree', 'list', '--porcelain'])).not.toContain('helmsman-feedback-review-');
  });

  it('cancels active stages, disposes retained providers and restores signal listeners', async () => {
    const f = await fixture();
    const listeners = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => process.listenerCount(signal));
    mocks.stage.mockImplementation(async (_adapter, _task, _cwd, _emit, signal) => {
      process.emit('SIGTERM'); expect(signal.aborted).toBe(true); signal.throwIfAborted();
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.completed()).toHaveLength(0); expect(f.workflowDispose).toHaveBeenCalledOnce();
    expect(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => process.listenerCount(signal))).toEqual(listeners);
  });

  it('releases the workflow and prior agent when a pinned reviewer cannot load', async () => {
    const f = await fixture(); const load = mocks.agent.getMockImplementation()!;
    mocks.agent.mockImplementation(async input => {
      if (input.record.binding.providerId === 'example.reviewer/reviewer') throw new Error('Retained reviewer unavailable');
      return load(input);
    });
    await expect(f.run()).rejects.toThrow('Retained reviewer unavailable');
    expect(mocks.stage).not.toHaveBeenCalled(); expect(f.workflowDispose).toHaveBeenCalledOnce();
    expect(f.agentDisposals[0]).toHaveBeenCalledOnce();
  });

  it('pins human evidence in each audit fingerprint', async () => {
    const f = await fixture(); const answers = 'Recorded answer'; mocks.clarifications.mockResolvedValue(answers);
    await f.run();
    const audit = mocks.stage.mock.calls.find(([, task]) => task.feedbackStage?.stage === 'audit')?.[1].feedbackStage;
    expect(audit?.decisions?.fingerprint).toBe(createHash('sha256').update(answers).digest('hex'));
  });
});
