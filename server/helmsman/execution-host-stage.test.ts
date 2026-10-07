// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionHostProviderV1, ExecutionHostStagePathsV1 } from '../../src/plugins/execution-host';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import { loadExecutionHost } from './execution-host-execution';
import { prepareExecutionHostStage, usesIsolatedExecution } from './execution-host-stage';

vi.mock('./execution-host-execution', () => ({ loadExecutionHost: vi.fn() }));

function fixture() {
  const dispose = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const cleanup = vi.fn(async (_success: boolean) => undefined);
  const paths: ExecutionHostStagePathsV1 = {
    skillsPath: '/guest/skills',
    reportPath: '/guest/report.json',
    priorReportPath: '/guest/prior-report.json',
    reviewOutputPaths: null,
    clarification: { questionsPath: '/guest/questions', answersPath: '/guest/answers' },
  };
  const prepareStage = vi.fn<NonNullable<ExecutionHostProviderV1['prepareStage']>>(async (_input, render) => ({
    command: render(paths),
    stop,
    cleanup,
  }));
  const provider = {
    metadata: { version: 1, label: 'Test', workspace: 'clone', stageExecution: 'isolated' },
    prepareStage,
  } as unknown as ExecutionHostProviderV1;
  vi.mocked(loadExecutionHost).mockResolvedValue({ provider, dispose });
  const task = {
    ticketId: 'T-1', title: 'Task', repo: 'org/repo', jiraBaseUrl: '', skillsPath: '/host/skills',
    executionHost: { metadata: provider.metadata },
    hostRuntime: { pluginsRoot: '/plugins', runtimeArtifactsRoot: '/runtime-artifacts', artifacts: [] },
    hostConfiguration: { image: `example/agent@sha256:${'a'.repeat(64)}` },
    hostIsolation: { runId: 'run-1', gatewayUrl: 'http://host.docker.internal:8790/', capability: 'capability', runtimeRoot: '/runtime' },
    prePr: { stage: 'review', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/host/report.json',
      summaryCorrection: { reportPath: '/host/prior-report.json', actualLength: 9000 } },
    clarification: { questionsPath: '/host/questions', answersPath: '/host/answers' },
  } as unknown as AgentTask;
  const buildCommand = vi.fn<AgentAdapter['buildCommand']>(() => ({ cmd: 'agent', args: ['review'] }));
  const adapter: AgentAdapter = { id: 'agent', metadata: { version: 1, label: 'Agent', costReporting: 'delta', supportsPrePr: true,
    defaults: { model: null, effort: null }, review: { low: { model: null, effort: null }, medium: { model: null, effort: null }, high: { model: null, effort: null } },
    reviewSkills: [], reviewDelegation: 'none', docker: 'openai-responses' }, buildCommand, parseLine: () => null };
  return { adapter, task, buildCommand, prepareStage, stop, cleanup, dispose };
}

describe('retained execution host stages', () => {
  it('treats selected isolated metadata as isolated even when retained fields are incomplete', async () => {
    const { adapter, task } = fixture();
    task.hostRuntime = undefined;
    expect(usesIsolatedExecution(task)).toBe(true);
    await expect(prepareExecutionHostStage(adapter, task, '/checkout')).rejects.toThrow('configuration is unavailable');
    expect(loadExecutionHost).not.toHaveBeenCalled();
  });

  it('passes the public stage contract and maps guest paths only into the rendered agent task', async () => {
    const { adapter, task, buildCommand, prepareStage, cleanup, dispose } = fixture();
    const stage = await prepareExecutionHostStage(adapter, task, '/checkout');
    expect(prepareStage).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', cwd: '/checkout', runtimeRoot: '/runtime', transport: 'openai-responses', stage: 'review',
      skillsPath: '/host/skills', reportPath: '/host/report.json', priorReportPath: '/host/prior-report.json',
    }), expect.any(Function));
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      readOnlyCheckout: true, dockerExecution: undefined, executionHost: undefined, hostRuntime: undefined, hostConfiguration: undefined, hostIsolation: undefined,
      skillsPath: '/guest/skills', prePr: expect.objectContaining({ reportPath: '/guest/report.json',
        summaryCorrection: expect.objectContaining({ reportPath: '/guest/prior-report.json' }) }),
      clarification: expect.objectContaining({ questionsPath: '/guest/questions', answersPath: '/guest/answers' }),
    }));
    await stage.cleanup(true);
    expect(cleanup).toHaveBeenCalledWith(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops, cleans unsuccessful state and disposes exactly once', async () => {
    const { adapter, task, stop, cleanup, dispose } = fixture();
    const stage = await prepareExecutionHostStage(adapter, task, '/checkout');
    await stage.stop();
    await stage.cleanup(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(false);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

it('copies interrupted review evidence through the retained isolated host prior-report path', async () => {
  const { adapter, task, buildCommand, prepareStage } = fixture();
  task.prePr = { ...task.prePr!, summaryCorrection: undefined, incompleteReview: { reportPath: '/host/incomplete.json', summary: 'Missing dependencies' } };
  const stage = await prepareExecutionHostStage(adapter, task, '/checkout');
  expect(prepareStage).toHaveBeenCalledWith(expect.objectContaining({ priorReportPath: '/host/incomplete.json' }), expect.any(Function));
  expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ prePr: expect.objectContaining({ incompleteReview: { reportPath: '/guest/prior-report.json', summary: 'Missing dependencies' } }) }));
  await stage.cleanup(true);
});
