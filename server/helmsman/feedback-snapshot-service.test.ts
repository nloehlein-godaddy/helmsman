// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackSnapshotService } from './feedback-snapshot-service';
import { createClarificationChannel } from './clarification-protocol-store';
import { fingerprintPullRequestFeedbackSnapshotV1, parsePullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';
import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import type { AgentTask } from './agents/adapter';
import type { PullRequestSourceRecord } from './pull-request-source';
import { persistenceHash } from './persistence';

const repo = 'org/project'; const runId = 'run-1';
const query = { version: 1 as const, repo, number: 42 };
const artifact = { pluginId: 'example.pr', artifactHash: 'c'.repeat(64), packageVersion: '1.0.0', requires: [] };
const binding = { role: 'effect' as const, capability: 'helmsman/pull-request', contributionId: 'example.pr/main', pluginId: artifact.pluginId,
  artifactHash: artifact.artifactHash, contractVersion: 1, connectionId: 'original', credentialHandle: 'original' };
const settings = { author: 'original' };

async function fixture() {
  const snapshot = parsePullRequestFeedbackSnapshotV1({ version: 1, quality: 'complete', repo, prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    headBranch: 'fix/feedback', baseBranch: 'main', state: 'OPEN', fingerprint: '0'.repeat(64),
    sources: [{ id: 'description:42', kind: 'description', url: `https://github.com/${repo}/pull/42`, body: 'Description', updatedAt: '2026-09-30T10:00:00Z' }] }, query);
  const signed = { ...snapshot, fingerprint: await fingerprintPullRequestFeedbackSnapshotV1(snapshot) };
  const channel = createClarificationChannel('/tmp/feedback-service', { runId, attempt: 2 });
  const scope = { attempt: 2, channel, active: true };
  const sourceRecord: PullRequestSourceRecord = { binding, settings, artifacts: [artifact], revision: persistenceHash({ binding, settings }),
    target: { repo, number: 42, headSha: 'd'.repeat(40), baseSha: snapshot.baseSha } };
  const task: AgentTask = { ticketId: 'rerun', title: 'Feedback', repo, jiraBaseUrl: '', prNumber: 42, prBranch: snapshot.headBranch,
    pullRequestSource: sourceRecord, clarification: channel,
    workflow: { version: 1, origin: 'builtin', binding: { providerId: 'example.workflow/feedback', pluginId: 'example.workflow', artifactHash: 'e'.repeat(64), contractVersion: 1 },
      settings: {}, metadata: { version: 1, label: 'Feedback', execution: 'direct', feedbackCompletion: true, modes: ['branch'], requiredSkills: [], maxRounds: 3, stageTimeoutMinutes: 45 } } };
  const feedbackSnapshot = vi.fn<NonNullable<PullRequestProviderV1['feedbackSnapshot']>>(async () => signed);
  const provider: PullRequestProviderV1 = { feedbackSnapshot, detail: vi.fn(), diff: vi.fn(), list: vi.fn(), prepareReview: vi.fn(), invokeReview: vi.fn(), reconcileReview: vi.fn() };
  const http = { request: vi.fn() };
  const source = vi.fn(async (_record: PullRequestSourceRecord, signal: AbortSignal) => ({ provider, context: { signal, http } }));
  const service = createFeedbackSnapshotService({ resolve: () => scope, task: () => task, source });
  const params = new URLSearchParams({ attempt: '2', channel: channel.channelId });
  return { snapshot: signed, task, scope, channel, provider, feedbackSnapshot, source, sourceRecord, params, http,
    read: (parameters = params) => service(runId, parameters) };
}

afterEach(() => vi.restoreAllMocks());

describe('retained feedback snapshot service', () => {
  it('uses the exact retained provider and accepts a new published head on the same PR branch', async () => {
    const f = await fixture();
    expect(await f.read()).toEqual(f.snapshot);
    expect(f.source).toHaveBeenCalledWith(f.sourceRecord, expect.any(AbortSignal));
    expect(f.feedbackSnapshot).toHaveBeenCalledWith(query, expect.objectContaining({ http: f.http }));
    expect(f.http.request).not.toHaveBeenCalled();
    expect(f.snapshot.headSha).not.toBe(f.sourceRecord.target.headSha);
  });

  it.each(['', 'attempt=2', 'attempt=1&channel=old', 'attempt=02&channel=old', 'attempt=2&attempt=2&channel=old'])('rejects malformed or stale channel query %s before provider resolution', async raw => {
    const f = await fixture();
    await expect(f.read(new URLSearchParams(raw))).rejects.toThrow('channel');
    expect(f.source).not.toHaveBeenCalled();
  });

  it('rejects inactive runs and non-feedback tasks', async () => {
    const f = await fixture(); f.scope.active = false;
    await expect(f.read()).rejects.toThrow('channel');
    f.scope.active = true; f.task.review = true;
    await expect(f.read()).rejects.toThrow('workflow');
    expect(f.source).not.toHaveBeenCalled();
  });

  it('fails closed when the retained provider lacks snapshot support or cannot be loaded', async () => {
    const f = await fixture(); delete f.provider.feedbackSnapshot;
    await expect(f.read()).rejects.toThrow('does not support complete');
    expect(f.feedbackSnapshot).not.toHaveBeenCalled();
    f.source.mockRejectedValueOnce(new Error('retained artifact is unavailable'));
    await expect(f.read()).rejects.toThrow('retained artifact');
  });

  it('rejects retained source identity and provenance tampering before provider resolution', async () => {
    for (const patch of [{ target: { repo: 'other/project', number: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } },
      { settings: { author: 'replacement' } }, { artifacts: [] }, { binding: { ...binding, artifactHash: 'f'.repeat(64) } }]) {
      const f = await fixture(); f.task.pullRequestSource = { ...f.sourceRecord, ...patch };
      await expect(f.read()).rejects.toThrow(); expect(f.source).not.toHaveBeenCalled();
    }
  });

  it.each([{ repo: 'other/project' }, { prNumber: 43 }, { quality: 'partial' }, { sources: [] }, { fingerprint: 'f'.repeat(64) }])(
    'rejects mismatched, incomplete or forged provider output %j', async patch => {
      const f = await fixture(); f.feedbackSnapshot.mockResolvedValueOnce({ ...f.snapshot, ...patch } as never);
      await expect(f.read()).rejects.toThrow();
    });

  it('rejects a correctly fingerprinted snapshot for a different branch', async () => {
    const f = await fixture(); const changed = { ...f.snapshot, headBranch: 'different' };
    f.feedbackSnapshot.mockResolvedValueOnce({ ...changed, fingerprint: await fingerprintPullRequestFeedbackSnapshotV1(changed) });
    await expect(f.read()).rejects.toThrow('branch');
  });

  it.each(['attempt', 'source', 'active'] as const)('rejects changed %s while provider collection is pending', async change => {
    const f = await fixture();
    f.feedbackSnapshot.mockImplementationOnce(async () => {
      if (change === 'attempt') f.scope.attempt = 3;
      else if (change === 'active') f.scope.active = false;
      else {
        const changed = { author: 'replacement' };
        f.task.pullRequestSource = { ...f.sourceRecord, settings: changed, revision: persistenceHash({ binding, settings: changed }) };
      }
      return f.snapshot;
    });
    await expect(f.read()).rejects.toThrow();
  });

  it('rechecks the active attempt after asynchronous fingerprint verification', async () => {
    const f = await fixture(); const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      const digest = await original(...args); f.scope.active = false; return digest;
    });
    await expect(f.read()).rejects.toThrow('channel');
  });

  it('does not invoke a provider after its source resolution outlives the active attempt', async () => {
    const f = await fixture();
    f.source.mockImplementationOnce(async (_record, signal) => {
      f.scope.attempt = 3; return { provider: f.provider, context: { signal, http: f.http } };
    });
    await expect(f.read()).rejects.toThrow('channel');
    expect(f.feedbackSnapshot).not.toHaveBeenCalled();
  });

  it('bounds a provider that ignores its cancellation signal', async () => {
    const f = await fixture(); const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    f.feedbackSnapshot.mockImplementationOnce(() => {
      controller.abort(new Error('provider deadline exceeded')); return new Promise(() => {});
    });
    await expect(f.read()).rejects.toThrow('provider deadline');
  });
});
