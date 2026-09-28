import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionHostStagePathsV1, ExecutionHostStageV1 } from '../../src/plugins/execution-host';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import { prepareDockerStage } from './docker-stage';
import { loadExecutionHost } from './execution-host-execution';

export function usesIsolatedExecution(task: Pick<AgentTask, 'dockerExecution' | 'executionHost' | 'hostRuntime' | 'hostConfiguration' | 'hostIsolation'>): boolean {
  return task.dockerExecution !== undefined || task.executionHost?.metadata.stageExecution === 'isolated';
}

function mappedTask(task: AgentTask, paths: ExecutionHostStagePathsV1): AgentTask {
  return {
    ...task,
    executionHost: undefined,
    hostRuntime: undefined,
    hostConfiguration: undefined,
    hostIsolation: undefined,
    dockerExecution: undefined,
    skillsPath: paths.skillsPath ?? undefined,
    reviewOutputPaths: paths.reviewOutputPaths ?? undefined,
    prePr: task.prePr ? {
      ...task.prePr,
      reportPath: paths.reportPath ?? task.prePr.reportPath,
      ...(task.prePr.incompleteReview ? { incompleteReview: { ...task.prePr.incompleteReview, reportPath: paths.priorReportPath ?? task.prePr.incompleteReview.reportPath } } : {}),
      ...(task.prePr.summaryCorrection ? {
        summaryCorrection: {
          ...task.prePr.summaryCorrection,
          reportPath: paths.priorReportPath ?? task.prePr.summaryCorrection.reportPath,
        },
      } : {}),
    } : undefined,
    clarification: paths.clarification ? {
      ...task.clarification,
      questionsPath: paths.clarification.questionsPath,
      answersPath: paths.clarification.answersPath,
    } : undefined,
  };
}

function isolatedStage(task: AgentTask): 'implement' | 'review' | 'fix' | 'pr-review' {
  if (task.review === true) return 'pr-review';
  if (task.prePr?.stage) return task.prePr.stage;
  throw new Error('Isolated execution requires a review or pre-PR stage');
}

export async function prepareExecutionHostStage(adapter: AgentAdapter, task: AgentTask, cwd: string): Promise<ExecutionHostStageV1> {
  if (task.dockerExecution) return prepareDockerStage(adapter, task, cwd);
  if (!usesIsolatedExecution(task) || !task.executionHost || !task.hostRuntime || task.hostConfiguration === undefined || !task.hostIsolation) {
    throw new Error('Retained isolated execution host configuration is unavailable');
  }
  const transport = adapter.metadata?.docker;
  if (transport !== 'openai-responses' && transport !== 'anthropic-messages') {
    throw new Error('Agent provider does not declare isolated execution transport');
  }
  const loaded = await loadExecutionHost(task);
  let stage: ExecutionHostStageV1;
  try {
    if (loaded.provider.metadata.stageExecution !== 'isolated' || !loaded.provider.prepareStage) {
      throw new Error('Retained execution host does not support isolated stages');
    }
    const reviewOutputPaths = task.review === true
      ? task.reviewOutputPaths ?? { markdown: join(cwd, '.agent-review.md'), comments: join(cwd, '.agent-review-comments.json') }
      : null;
    stage = await loaded.provider.prepareStage({
      version: 1,
      runId: task.hostIsolation.runId,
      repo: task.repo,
      cwd: resolve(cwd),
      runtimeRoot: resolve(task.hostIsolation.runtimeRoot ?? tmpdir()),
      gateway: { url: task.hostIsolation.gatewayUrl, capability: task.hostIsolation.capability },
      configuration: task.hostConfiguration,
      transport,
      stage: isolatedStage(task),
      skillsPath: task.skillsPath ?? null,
      reportPath: task.prePr?.reportPath ?? null,
      priorReportPath: task.prePr?.summaryCorrection?.reportPath ?? task.prePr?.incompleteReview?.reportPath ?? null,
      reviewOutputPaths,
      clarification: task.clarification ? {
        questionsPath: task.clarification.questionsPath,
        answersPath: task.clarification.answersPath,
      } : null,
    }, paths => adapter.buildCommand(mappedTask(task, paths)));
  } catch (error) {
    await loaded.dispose();
    throw error;
  }

  let finalized: Promise<void> | undefined;
  const finalize = (success: boolean, stop: boolean) => {
    finalized ??= (async () => {
      let failure: unknown;
      if (stop) {
        try { await stage.stop(); } catch (error) { failure = error; }
      }
      try { await stage.cleanup(success); }
      catch (error) { failure = failure ? new AggregateError([failure, error], 'Execution host stage cleanup failed') : error; }
      finally { await loaded.dispose(); }
      if (failure) throw failure;
    })();
    return finalized;
  };
  return {
    command: stage.command,
    stop: () => finalize(false, true),
    cleanup: success => finalize(success, false),
  };
}
