import { describe, expect, it, vi } from 'vitest';
import { inspectDetail, inspectQuery, inspectTarget } from '../../src/plugins/pull-request-inspect.test-fixture';
import { parsePullRequestSource, prepareCommunicationReview, pullRequestExecutionSnapshot, readOutcomePullRequest, readPullRequestDetail, retainPullRequestSource, verifyPullRequestExecution } from './pull-request-source';
import type { TriggerPullRequestReadCapture } from './trigger-read-source';
import { validateExecutionSnapshot, type ExecutionSnapshotInput, type ProviderBinding } from './execution-store';
import { persistenceHash } from './persistence';

const artifact = { pluginId: 'example.pr', artifactHash: 'c'.repeat(64), packageVersion: '1.0.0', requires: [] };
const binding: ProviderBinding = { role: 'effect', capability: 'helmsman/pull-request', contributionId: 'example.pr/main', pluginId: artifact.pluginId,
  artifactHash: artifact.artifactHash, contractVersion: 1, connectionId: 'original', credentialHandle: 'original' };
const settings = { author: 'original' };
const base: ExecutionSnapshotInput = { version: 1, runId: 'run-1', attempt: 1, repo: inspectQuery.repo,
  logicalWork: { source: 'github-review', instance: 'original', taskId: 'review' }, task: {}, workflowSnapshotId: null,
  artifacts: [], bindings: [], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: {} } };
function fixture() {
  let current = true;
  const controller = new AbortController();
  const provider = { detail: vi.fn(async () => inspectDetail), diff: vi.fn(), list: vi.fn(), prepareReview: vi.fn(), invokeReview: vi.fn(), reconcileReview: vi.fn() };
  const capture: TriggerPullRequestReadCapture = { provider, binding, settings, artifacts: [artifact], repos: [inspectQuery.repo],
    revision: persistenceHash({ binding, settings }), context: { signal: controller.signal, http: { request: vi.fn() } },
    assertCurrent() { if (!current) throw new Error('PR source changed or disabled'); } };
  return { capture, provider, controller, disable() { current = false; } };
}

describe('selected public PR source for new actions', () => {
  it('takes rerun branch/head from the replacement and never reaches the private HTTP adapter', async () => {
    const f = fixture(); f.provider.detail.mockResolvedValue({ ...inspectDetail, headRefName: 'replacement-branch' });
    const result = await readPullRequestDetail({ ...inspectQuery, headSha: inspectTarget.headSha }, f.capture);
    expect(result.headRefName).toBe('replacement-branch'); expect(result.target.headSha).toBe(inspectTarget.headSha);
    expect(f.capture.context.http.request).not.toHaveBeenCalled();
  });
  it('rejects disabled sources, removed scope, changed heads and invalid public results', async () => {
    const f = fixture(); f.disable(); await expect(readPullRequestDetail(inspectQuery, f.capture)).rejects.toThrow('disabled');
    expect(f.provider.detail).not.toHaveBeenCalled();
    const g = fixture(); g.capture.repos = [];
    await expect(readPullRequestDetail(inspectQuery, g.capture)).rejects.toThrow('scope');
    g.capture.repos = [inspectQuery.repo];
    await expect(readPullRequestDetail({ ...inspectQuery, headSha: 'f'.repeat(40) }, g.capture)).rejects.toThrow('PR changed');
    g.provider.detail.mockResolvedValue(null as never);
    await expect(readPullRequestDetail(inspectQuery, g.capture)).rejects.toThrow();
  });
  it('rejects selection changes and cancellation while public detail is pending', async () => {
    const f = fixture(); let complete!: () => void;
    f.provider.detail.mockImplementation(async () => { await new Promise<void>(resolve => { complete = resolve; }); return inspectDetail; });
    const pending = readPullRequestDetail(inspectQuery, f.capture);
    f.disable(); complete(); await expect(pending).rejects.toThrow('changed');
    const g = fixture(); g.controller.abort();
    await expect(readPullRequestDetail(inspectQuery, g.capture)).rejects.toThrow(); expect(g.provider.detail).not.toHaveBeenCalled();
  });
  it('uses selected ownership for communication eligibility and preserves incomplete Costs evidence as unknown', async () => {
    const f = fixture();
    expect(await prepareCommunicationReview(inspectQuery, f.capture)).toMatchObject({ binding, settings, target: inspectTarget, artifacts: [artifact] });
    f.provider.detail.mockResolvedValue({ ...inspectDetail, isOwnPr: false });
    await expect(prepareCommunicationReview(inspectQuery, f.capture)).rejects.toThrow('not eligible');
    f.provider.detail.mockResolvedValue({ ...inspectDetail, reviews: { ...inspectDetail.reviews, quality: 'partial', approved: null, changesRequested: null, commented: null, requested: null, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } });
    expect(await readOutcomePullRequest(inspectQuery, f.capture)).toMatchObject({ reviewsAvailable: false });
  });
});

describe('retained PR preparation evidence', () => {
  it('preserves original source, settings, head and artifacts without consulting a replacement during recovery', () => {
    const f = fixture(); const source = retainPullRequestSource(f.capture, inspectTarget);
    const snapshot = pullRequestExecutionSnapshot(base, { pullRequestSource: source }); f.disable();
    expect(parsePullRequestSource(source)).toEqual(source);
    expect(() => verifyPullRequestExecution({ pullRequestSource: source }, snapshot)).not.toThrow();
    expect(snapshot.settings.pullRequestSource).toEqual(source); expect(snapshot.artifacts).toEqual([artifact]);
    expect(() => validateExecutionSnapshot({ ...snapshot, task: { pullRequestSource: source },
      bindings: [{ ...binding, role: 'host', capability: 'helmsman/host' }] })).not.toThrow();
    expect(f.provider.detail).not.toHaveBeenCalled();
    expect(() => verifyPullRequestExecution({ pullRequestSource: { ...source, settings: { author: 'replacement' } } }, snapshot)).toThrow('differs');
    expect(() => verifyPullRequestExecution({}, snapshot)).toThrow('differs');
    expect(() => verifyPullRequestExecution({ pullRequestSource: source }, { ...snapshot, artifacts: [] })).toThrow('closure');
    expect(() => parsePullRequestSource({ ...source, settings: { author: 'replacement' } })).toThrow('Invalid retained');
  });
  it('keeps pre-extraction snapshots untouched and rejects conflicting artifact closures', () => {
    expect(pullRequestExecutionSnapshot(base, {})).toBe(base); expect(() => verifyPullRequestExecution({}, base)).not.toThrow();
    const f = fixture(); const source = retainPullRequestSource(f.capture, inspectTarget);
    expect(() => pullRequestExecutionSnapshot({ ...base, artifacts: [{ ...artifact, artifactHash: 'd'.repeat(64) }] }, { pullRequestSource: source })).toThrow('Conflicting');
  });
});
