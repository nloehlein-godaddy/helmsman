import { describe, expect, it, vi } from 'vitest';
import { inspectDetail, inspectDiff, inspectQuery } from '../../src/plugins/pull-request-inspect.test-fixture';
import { prepareTriggerReview } from './trigger-review-preparation';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';

function fixture() {
  let current = true;
  const provider = { detail: vi.fn(async () => inspectDetail), diff: vi.fn(async () => inspectDiff),
    list: vi.fn(), prepareReview: vi.fn(), invokeReview: vi.fn(), reconcileReview: vi.fn() };
  const capture: TriggerPullRequestReadCapture = { provider, revision: 'original',
    binding: { role: 'effect', capability: 'helmsman/pull-request', contributionId: 'example.pr/main', pluginId: 'example.pr',
      artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: 'original', credentialHandle: 'original' }, artifacts: [],
    context: { signal: new AbortController().signal, http: { request: vi.fn() } }, assertCurrent() { if (!current) throw new Error('Source changed'); } };
  return { provider, capture, change() { current = false; } };
}
describe('triggered review preparation', () => {
  it('uses public detail/diff for the pinned PR and preserves preview completeness', async () => {
    const f = fixture(); const result = await prepareTriggerReview({ ...inspectQuery, headSha: inspectDetail.target.headSha }, f.capture);
    expect(result.pr).toMatchObject({ headSha: inspectDetail.target.headSha, headRefName: inspectDetail.headRefName });
    expect(result.scope.complete).toBe(inspectDiff.quality === 'complete' && !inspectDiff.truncated);
    expect(f.provider.diff).toHaveBeenCalledWith({ version: 1, target: inspectDetail.target }, f.capture.context);
    expect(f.capture.context.http.request).not.toHaveBeenCalled();
  });
  it('blocks a changed head before reading its diff', async () => {
    const f = fixture(); await expect(prepareTriggerReview({ ...inspectQuery, headSha: 'f'.repeat(40) }, f.capture)).rejects.toThrow('PR changed');
    expect(f.provider.diff).not.toHaveBeenCalled();
  });
  it('rejects source replacement while the diff is pending', async () => {
    const f = fixture(); let finish!: (value: typeof inspectDiff) => void;
    f.provider.diff.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = prepareTriggerReview(inspectQuery, f.capture);
    await vi.waitFor(() => expect(f.provider.diff).toHaveBeenCalledOnce()); f.change(); finish(inspectDiff);
    await expect(pending).rejects.toThrow('Source changed');
  });
});
