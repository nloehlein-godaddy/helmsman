import { describe, expect, it, vi } from 'vitest';
import { inspectDetail } from '../../src/plugins/pull-request-inspect.test-fixture';
import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import { observeAutomaticReviewOwnership, parseAutomaticReviewPolicy } from './automatic-review-ownership';
import { persistenceHash } from './persistence';
import type { ReviewNotificationProposal } from './slack/store';
import type { TriggerProvenanceV1 } from './trigger-provenance';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';

function fixture() {
  const proposal: ReviewNotificationProposal = { eventId: 'event', targetId: 'target', repo: inspectDetail.target.repo, number: inspectDetail.target.number,
    headSha: inspectDetail.target.headSha, title: inspectDetail.title, url: inspectDetail.url, status: 'open', draft: false,
    workflowRef: 'review@1', sourceUrl: 'https://example.slack.com/message', author: 'sender', channelName: 'reviews' };
  const binding: TriggerPullRequestReadCapture['binding'] = { role: 'effect', capability: 'helmsman/pull-request', contributionId: 'example.pr/main',
    pluginId: 'example.pr', artifactHash: 'c'.repeat(64), contractVersion: 1, connectionId: 'retained', credentialHandle: 'retained' };
  const provider: PullRequestProviderV1 = { profile: vi.fn(async () => ({ displayName: 'Viewer', login: 'viewer' })),
    detail: vi.fn(async () => inspectDetail), list: vi.fn(), diff: vi.fn(), prepareReview: vi.fn(), invokeReview: vi.fn(), reconcileReview: vi.fn() };
  const controller = new AbortController();
  const pullRequest: TriggerPullRequestReadCapture = { binding, provider, revision: 'pr-source', settings: { author: 'author' }, artifacts: [],
    repos: [proposal.repo], context: { signal: controller.signal, configuredAuthor: 'author', http: { request: vi.fn() } }, assertCurrent: vi.fn() };
  const source = { source: { sourceKey: 'slack', revision: 'source-1', bindings: [binding] }, assertCurrent: vi.fn() };
  const trigger: TriggerProvenanceV1 = { version: 1, instanceId: 'slack-review', proposalHash: persistenceHash(proposal), source: source.source,
    selectionRevision: 'selected', inputHash: 'a'.repeat(64), capturedAt: '2026-09-22T00:00:00Z',
    artifacts: [{ pluginId: binding.pluginId, artifactHash: binding.artifactHash, packageVersion: '1', requires: [] }],
    provider: { version: 1, origin: 'external', settings: {}, binding: { pluginId: binding.pluginId, artifactHash: binding.artifactHash,
      providerId: binding.contributionId, contractVersion: 1 }, metadata: { version: 1, label: 'Reviews', kind: 'review-watch', source: 'communication', intervalMs: 1000 } } };
  const input = { proposal, trigger, pullRequest, source, assertCurrent: vi.fn(), now: () => '2026-09-22T00:00:00Z' };
  return { input, provider, pullRequest, source, controller, observe: () => observeAutomaticReviewOwnership(input) };
}

describe('automatic Slack review ownership', () => {
  it('uses the authenticated actor despite configured ownership, without bypassing the selected provider', async () => {
    const f = fixture();
    const result = await f.observe();
    expect(result).toMatchObject({ blockedReason: null, policy: { decision: 'other', actorLogin: 'viewer', authorLogin: 'author',
      headSha: inspectDetail.target.headSha, sourceRevision: 'source-1', providerBindingHash: persistenceHash({ binding: f.pullRequest.binding, settings: f.pullRequest.settings }) } });
    expect(f.provider.profile).toHaveBeenCalledWith(f.pullRequest.context);
    expect(f.provider.detail).toHaveBeenCalledWith({ version: 1, repo: inspectDetail.target.repo, number: 42 }, f.pullRequest.context);
    expect(f.pullRequest.context.http.request).not.toHaveBeenCalled();
  });

  it('blocks case-insensitive authenticated ownership even when configured ownership is false', async () => {
    const f = fixture();
    vi.mocked(f.provider.profile!).mockResolvedValue({ displayName: null, login: 'AUTHOR' });
    vi.mocked(f.provider.detail).mockResolvedValue({ ...inspectDetail, isOwnPr: false });
    expect(await f.observe()).toMatchObject({ policy: { decision: 'own', actorLogin: 'author', authorLogin: 'author' },
      blockedReason: 'Automatic Slack review skipped: PR is authored by the authenticated GitHub account' });
  });
  it('accepts a mixed-case galleon returned by a trigger within the configured scope', async () => {
    const f = fixture(); const repo = f.input.proposal.repo.toUpperCase();
    f.input.proposal.repo = repo; f.input.trigger = { ...f.input.trigger, proposalHash: persistenceHash(f.input.proposal) };
    vi.mocked(f.provider.detail).mockResolvedValue({ ...inspectDetail, target: { ...inspectDetail.target, repo } });
    expect(await f.observe()).toMatchObject({ blockedReason: null, policy: { decision: 'other' } });
  });

  it.each(['missing-profile', 'empty-login', 'invalid-profile', 'missing-author', 'profile-error', 'invalid-detail'] as const)('keeps %s retryable', async kind => {
    const f = fixture();
    if (kind === 'missing-profile') f.provider.profile = undefined;
    if (kind === 'empty-login') vi.mocked(f.provider.profile!).mockResolvedValue({ displayName: null, login: ' ' });
    if (kind === 'invalid-profile') vi.mocked(f.provider.profile!).mockResolvedValue(null as never);
    if (kind === 'missing-author') vi.mocked(f.provider.detail).mockResolvedValue({ ...inspectDetail, authorLogin: null, isOwnPr: null });
    if (kind === 'profile-error') vi.mocked(f.provider.profile!).mockRejectedValue(new Error('Authorization secret must not be persisted'));
    if (kind === 'invalid-detail') vi.mocked(f.provider.detail).mockResolvedValue(null as never);
    const result = await f.observe();
    expect(result).toMatchObject({ blockedReason: null, policy: { decision: 'unknown', actorLogin: null } });
    expect(JSON.stringify(result.policy)).not.toContain('secret');
  });

  it.each(['head', 'closed', 'draft'] as const)('blocks a %s target before reading authenticated identity', async kind => {
    const f = fixture();
    vi.mocked(f.provider.detail).mockResolvedValue({ ...inspectDetail, ...(kind === 'head' ? { target: { ...inspectDetail.target, headSha: 'd'.repeat(40) } }
      : kind === 'closed' ? { status: 'closed' } : { draft: true }) });
    expect(await f.observe()).toMatchObject({ policy: { decision: 'unknown' }, blockedReason: expect.stringContaining('PR target changed') });
    expect(f.provider.profile).not.toHaveBeenCalled();
  });

  it.each(['pull-request', 'source', 'trigger', 'abort'] as const)('rejects a late profile after its %s authority changes', async kind => {
    const f = fixture(); let finish!: () => void;
    vi.mocked(f.provider.profile!).mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { displayName: null, login: 'viewer' }; });
    const pending = f.observe();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const changed = () => { throw new Error('Captured authority changed'); };
    if (kind === 'pull-request') f.pullRequest.assertCurrent = changed;
    if (kind === 'source') f.source.assertCurrent.mockImplementation(changed);
    if (kind === 'trigger') f.input.assertCurrent.mockImplementation(changed);
    if (kind === 'abort') f.controller.abort();
    finish(); await expect(pending).rejects.toThrow();
  });

  it('keeps the returned authority fence live through the synchronous dispatch decision', async () => {
    const f = fixture(); const result = await f.observe();
    f.pullRequest.assertCurrent = () => { throw new Error('Credential changed'); };
    expect(() => result.assertCurrent()).toThrow('Credential changed');
  });

  it.each(['detail', 'profile'] as const)('bounds a %s provider that ignores cancellation', async method => {
    const f = fixture();
    const blocked = vi.fn(() => new Promise<never>(() => {}));
    f.provider[method] = blocked;
    const pending = f.observe();
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('blocks changed retained source evidence before reading another provider', async () => {
    const f = fixture(); f.source.source = { ...f.source.source, revision: 'replacement' };
    expect(await f.observe()).toMatchObject({ policy: { decision: 'unknown' }, blockedReason: expect.stringContaining('source or proposal') });
    expect(f.provider.detail).not.toHaveBeenCalled();
  });

  it('rejects malformed stored ownership evidence and contradictory ownership', async () => {
    const f = fixture(); const { policy } = await f.observe();
    expect(() => parseAutomaticReviewPolicy({ ...policy, decision: 'own' })).toThrow();
    expect(() => parseAutomaticReviewPolicy({ ...policy, actorLogin: null })).toThrow();
    expect(() => parseAutomaticReviewPolicy({ ...policy, reason: 'a'.repeat(513) })).toThrow();
    expect(() => parseAutomaticReviewPolicy({ ...policy, token: 'credential' })).toThrow();
  });
});
