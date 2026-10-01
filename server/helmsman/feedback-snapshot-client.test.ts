// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { collectFeedbackSnapshot } from './feedback-snapshot-client';
import { createClarificationChannel } from './clarification-protocol-store';
import { fingerprintPullRequestFeedbackSnapshotV1, parsePullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';
import type { AgentTask } from './agents/adapter';

const runId = 'run-1'; const repo = 'org/project';
async function fixture() {
  const task: AgentTask = { ticketId: 'rerun', title: 'Feedback', jiraBaseUrl: '', repo, prNumber: 42, prBranch: 'fix/feedback',
    clarification: createClarificationChannel('/tmp/feedback-client', { runId, attempt: 2, gateUrl: `http://127.0.0.1:8787/api/runs/${runId}/clarification-gate` }) };
  const raw = parsePullRequestFeedbackSnapshotV1({ version: 1, quality: 'complete', repo, prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    headBranch: task.prBranch, baseBranch: 'main', state: 'OPEN', sources: [{ id: 'description:42', kind: 'description',
      url: `https://github.com/${repo}/pull/42`, body: 'Complete description', updatedAt: '2026-09-30T10:00:00Z' }], fingerprint: '0'.repeat(64) }, { version: 1, repo, number: 42 });
  const snapshot = { ...raw, fingerprint: await fingerprintPullRequestFeedbackSnapshotV1(raw) };
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot));
  return { task, snapshot, controller, fetcher, read: () => collectFeedbackSnapshot(task, runId, controller.signal, fetcher) };
}

describe('feedback snapshot worker client', () => {
  it('reads the local attempt-bound endpoint and independently verifies its content fingerprint', async () => {
    const f = await fixture();
    expect(await f.read()).toEqual(f.snapshot);
    const [url, options] = f.fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(f.task.clarification?.gateUrl?.replace('/clarification-gate?', '/feedback-snapshot?'));
    expect(options).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it.each(['https://127.0.0.1:8787', 'http://other.example', 'http://secret@127.0.0.1:8787'])('rejects an invalid authority %s without fetching', async origin => {
    const f = await fixture(); const channel = f.task.clarification;
    if (!channel) throw new Error('Missing fixture channel');
    channel.gateUrl = `${origin}/api/runs/${runId}/clarification-gate?attempt=2&channel=${channel.channelId}`;
    await expect(f.read()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(['wrong-run', 'wrong-attempt', 'wrong-channel', 'extra-query', 'missing-channel', 'fragment'] as const)('rejects %s gate evidence before fetching', async change => {
    const f = await fixture(); const channel = f.task.clarification;
    if (!channel?.gateUrl) throw new Error('Missing fixture gate');
    const url = new URL(channel.gateUrl);
    if (change === 'wrong-run') url.pathname = '/api/runs/run-2/clarification-gate';
    else if (change === 'wrong-attempt') url.searchParams.set('attempt', '1');
    else if (change === 'wrong-channel') url.searchParams.set('channel', 'old');
    else if (change === 'extra-query') url.searchParams.set('extra', '1');
    else if (change === 'missing-channel') url.searchParams.delete('channel');
    else url.hash = 'fragment';
    channel.gateUrl = url.href;
    await expect(f.read()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([{ quality: 'partial' }, { repo: 'other/project' }, { prNumber: 43 }, { sources: [] }, { fingerprint: 'f'.repeat(64) }])(
    'rejects incomplete or mismatched server evidence %j', async patch => {
      const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ ...f.snapshot, ...patch }));
      await expect(f.read()).rejects.toThrow();
    });

  it('rejects non-OK responses and transport errors', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(f.read()).rejects.toThrow('HTTP 503');
    f.fetcher.mockRejectedValueOnce(new Error('unreachable'));
    await expect(f.read()).rejects.toThrow('unreachable');
  });

  it('does not accept a correctly signed snapshot on another branch', async () => {
    const f = await fixture(); const changed = { ...f.snapshot, headBranch: 'different' };
    f.fetcher.mockResolvedValueOnce(Response.json({ ...changed, fingerprint: await fingerprintPullRequestFeedbackSnapshotV1(changed) }));
    await expect(f.read()).rejects.toThrow('branch');
  });

  it('does not fetch after cancellation or accept evidence if cancellation arrives during the response', async () => {
    const f = await fixture(); f.controller.abort();
    await expect(f.read()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    const pending = await fixture(); pending.fetcher.mockImplementationOnce(async () => {
      pending.controller.abort(); return Response.json(pending.snapshot);
    });
    await expect(pending.read()).rejects.toThrow();
  });
});
