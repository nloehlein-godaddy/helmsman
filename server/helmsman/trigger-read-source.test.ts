import { describe, expect, it, vi } from 'vitest';
import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import { inspectDetail, inspectQuery } from '../../src/plugins/pull-request-inspect.test-fixture';
import { captureTriggerReviewSource } from './trigger-read-source';

function fixture() {
  let current = true; let repos = [inspectQuery.repo];
  const controller = new AbortController();
  const provider: PullRequestProviderV1 = { detail: vi.fn(async () => inspectDetail),
    list: vi.fn(async () => ({ items: [], quality: 'complete' as const, truncated: false, browseUrl: null })),
    diff: vi.fn(), prepareReview: vi.fn(), invokeReview: vi.fn(), reconcileReview: vi.fn() };
  const source = captureTriggerReviewSource({ role: 'github-review', signal: controller.signal, repos: () => repos,
    pullRequest: { provider, revision: 'captured-settings', binding: { role: 'effect', capability: 'helmsman/pull-request',
      contributionId: 'example.pr/main', pluginId: 'example.pr', artifactHash: 'a'.repeat(64), contractVersion: 1,
      connectionId: 'original-connection', credentialHandle: 'original-credential' },
    artifacts: [{ pluginId: 'example.pr', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] }],
    context: { signal: controller.signal, http: { request: vi.fn() } },
    assertCurrent() { if (!current) throw new Error('Source changed'); } } });
  return { source, provider, controller, changeSource() { current = false; }, changeRepos() { repos = []; } };
}

describe('trigger selected-source reads', () => {
  it('projects public selected-provider detail and rejects out-of-scope reads before dispatch', async () => {
    const f = fixture();
    expect(await f.source.detail(inspectQuery)).toEqual({ repo: inspectQuery.repo, number: inspectQuery.number,
      headSha: inspectDetail.target.headSha, title: inspectDetail.title, url: inspectDetail.url, status: inspectDetail.status, draft: inspectDetail.draft });
    expect(await f.source.detail({ repo: 'private/project', number: 2 })).toBeNull();
    expect(f.provider.detail).toHaveBeenCalledOnce();
    expect(f.source).not.toHaveProperty('messages');
    expect(f.source.source.bindings[0]?.connectionId).toBe('original-connection');
  });
  it.each(['source', 'scope', 'abort'] as const)('discards an asynchronous response after %s changes', async kind => {
    const f = fixture(); let finish!: (value: typeof inspectDetail) => void;
    vi.mocked(f.provider.detail).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.source.detail(inspectQuery);
    if (kind === 'source') f.changeSource(); else if (kind === 'scope') f.changeRepos(); else f.controller.abort();
    finish(inspectDetail); await expect(pending).rejects.toThrow();
  });
  it('rejects a provider response for a different PR head target identity', async () => {
    const f = fixture(); vi.mocked(f.provider.detail).mockResolvedValue({ ...inspectDetail, target: { ...inspectDetail.target, number: inspectQuery.number + 1 } });
    await expect(f.source.detail(inspectQuery)).rejects.toThrow();
  });
});
