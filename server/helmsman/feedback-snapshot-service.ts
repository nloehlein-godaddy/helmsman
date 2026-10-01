import type { AgentTask } from './agents/adapter';
import type { ClarificationChannel } from './clarification-protocol-store';
import type { PullRequestSourceRecord } from './pull-request-source';
import { parsePullRequestSource } from './pull-request-source';
import type { PullRequestProviderV1, PullRequestProviderContextV1 } from '../../src/plugins/pull-request-provider';
import { fingerprintPullRequestFeedbackSnapshotV1, parsePullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';
import { persistenceHash } from './persistence';

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export function createFeedbackSnapshotService(input: {
  resolve(runId: string): { attempt: number; channel: ClarificationChannel | null; active: boolean };
  task(runId: string): AgentTask;
  source(record: PullRequestSourceRecord, signal: AbortSignal): Promise<{ provider: PullRequestProviderV1; context: PullRequestProviderContextV1 }>;
}) {
  return async (runId: string, query: URLSearchParams) => {
    const assertScope = () => {
      const retained = input.resolve(runId);
      if (!retained.active || !retained.channel || query.size !== 2 || query.getAll('attempt').length !== 1 || query.getAll('channel').length !== 1
        || query.get('attempt') !== String(retained.attempt) || query.get('channel') !== retained.channel.channelId) throw new Error('Feedback attempt channel is unavailable');
      const task = input.task(runId);
      if (task.workflow?.metadata.feedbackCompletion !== true || task.review || !task.prNumber || !task.prBranch) throw new Error('Feedback workflow is unavailable');
      const source = parsePullRequestSource(task.pullRequestSource);
      if (source.target.repo !== task.repo.toLowerCase() || source.target.number !== task.prNumber) throw new Error('Retained feedback target differs from task');
      return { task, source };
    };
    const retained = assertScope();
    const identity = persistenceHash(retained.source);
    const branch = retained.task.prBranch;
    const assertCurrent = () => {
      const current = assertScope();
      if (persistenceHash(current.source) !== identity || current.task.prBranch !== branch) throw new Error('Retained feedback source changed during collection');
    };
    const signal = AbortSignal.timeout(60_000);
    const { provider, context } = await abortable(input.source(retained.source, signal), signal);
    signal.throwIfAborted(); assertCurrent();
    if (!provider.feedbackSnapshot) throw new Error('Retained PR provider does not support complete feedback snapshots');
    const request = { version: 1 as const, repo: retained.source.target.repo, number: retained.source.target.number };
    const snapshot = parsePullRequestFeedbackSnapshotV1(await abortable(provider.feedbackSnapshot(request, context), signal), request);
    signal.throwIfAborted();
    assertCurrent();
    if (snapshot.headBranch !== branch || snapshot.fingerprint !== await fingerprintPullRequestFeedbackSnapshotV1(snapshot)) {
      throw new Error('Feedback snapshot branch or fingerprint differs from retained source');
    }
    signal.throwIfAborted(); assertCurrent();
    return snapshot;
  };
}
