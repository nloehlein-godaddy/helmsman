import type { AgentTask } from './agents/adapter';
import { parsePullRequestFeedbackSnapshotV1, fingerprintPullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';

export async function collectFeedbackSnapshot(task: AgentTask, runId: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  signal.throwIfAborted();
  const channel = task.clarification;
  const url = new URL(channel?.gateUrl ?? '');
  if (!channel || channel.version !== 1 || channel.runId !== runId || !Number.isSafeInteger(channel.attempt) || Number(channel.attempt) < 1
    || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(channel.channelId ?? '') || !/^[a-z\d_-]{1,128}$/i.test(runId)
    || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== `/api/runs/${runId}/clarification-gate` || url.username || url.password || url.hash
    || url.searchParams.size !== 2 || url.searchParams.getAll('attempt').length !== 1 || url.searchParams.getAll('channel').length !== 1
    || url.searchParams.get('attempt') !== String(channel.attempt) || url.searchParams.get('channel') !== channel.channelId) {
    throw new Error('Feedback snapshot service requires the current local attempt channel');
  }
  url.pathname = `/api/runs/${runId}/feedback-snapshot`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const response = await fetcher(url, { redirect: 'error', signal: requestSignal });
  requestSignal.throwIfAborted();
  if (!response.ok) throw new Error(`Feedback snapshot unavailable (HTTP ${response.status})`);
  const snapshot = parsePullRequestFeedbackSnapshotV1(await response.json(), { version: 1, repo: task.repo, number: task.prNumber! });
  requestSignal.throwIfAborted();
  if (snapshot.headBranch !== task.prBranch) throw new Error('Feedback snapshot branch does not match the task');
  if (snapshot.fingerprint !== await fingerprintPullRequestFeedbackSnapshotV1(snapshot)) throw new Error('Feedback snapshot fingerprint does not match its contents');
  requestSignal.throwIfAborted();
  return snapshot;
}
