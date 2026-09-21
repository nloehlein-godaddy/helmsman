import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPullRequestReviewBody, type PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import { openExecutionStore, type ArtifactBinding, type ProviderBinding } from './execution-store';
import { dispatchOperation } from './operation-dispatcher';
import { openOperationStore } from './operations';
import { openPersistence, type Persistence } from './persistence';
import { createPullRequestProviderEffects } from './pull-request-provider-effects';
import { createPullRequestProviderRegistry } from './pull-request-providers';

const directories: string[] = []; const databases: Persistence[] = [];
afterEach(() => { databases.splice(0).forEach(value => value.close()); directories.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })); });
const sha = 'a'.repeat(40); const artifact: ArtifactBinding = { pluginId: 'example.github', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] };
const binding: ProviderBinding = { role: 'effect', capability: 'helmsman/pull-request', contractVersion: 1, contributionId: 'example.github/github', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: 'github-connection', credentialHandle: 'github-primary' };
const command = { version: 1 as const, requestId: '12345678-1234-4123-8123-123456789abc', repo: 'owner/repo', number: 12, expectedHeadSha: sha, event: 'COMMENT' as const, body: 'Review comment' };
type MutableReviewRequest = { method: 'POST'; path: string; query: Record<string, string>; body: Record<string, string> };

function fixture() {
  let draining = false;
  let selected: ProviderBinding | null = binding;
  let authorize: (() => Promise<{ allowed: true } | { allowed: false; reason: string }>) | null = null;
  const upstream = vi.fn(async () => ({ status: 200, body: {} }));
  const invokeReview = vi.fn<PullRequestProviderV1['invokeReview']>(async () => ({ status: 'acknowledged' as const, receipt: { repo: command.repo, prNumber: command.number, headSha: sha, actor: 'other-actor', reviewId: 42 } }));
  const provider: PullRequestProviderV1 = {
    list: async () => ({ items: [], quality: 'complete', truncated: false, browseUrl: null }), detail: async () => { throw new Error('Unused'); }, diff: async () => { throw new Error('Unused'); },
    prepareReview: async () => ({ repo: command.repo, number: command.number, headSha: sha, actor: 'reviewer' }),
    invokeReview,
    reconcileReview: async () => ({ status: 'unknown' as const, reason: 'Not observed', evidence: { code: 'not-observed' } }),
  };
  const registry = createPullRequestProviderRegistry({ eligible: (_binding, purpose) => !draining || purpose === 'obligation' });
  registry.publish([registry.stage({ providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null }, provider)]);
  const effects = createPullRequestProviderEffects({ registry, selected: () => selected, artifacts: () => [artifact], verifyArtifacts: async () => {},
    http: () => ({ request: upstream }), authorize: async () => authorize?.() ?? { allowed: true as const } });
  return { provider, invokeReview, registry, effects, upstream, setAuthorize: (value: typeof authorize) => { authorize = value; }, setDraining: (value: boolean) => { draining = value; }, setSelected: (value: ProviderBinding | null) => { selected = value; } };
}

function operation(operations: ReturnType<typeof openOperationStore>) {
  return operations.enqueue({ version: 1, key: 'public-review:test', kind: 'pull-request.review',
    origin: { kind: 'public-pull-request-review', id: command.requestId, revision: 'c'.repeat(64), runId: null, attempt: null }, binding, artifacts: [artifact],
    target: { repo: command.repo, prNumber: command.number, headSha: sha, actor: 'reviewer' }, payload: { caller: 'example.reviews/review', command, event: command.event, body: command.body, manual: true, expectedHeadSha: sha } });
}

describe('pull request provider effects', () => {
  it('keeps an exact provider obligation while denying a disabled provider new admissions', async () => {
    const f = fixture(); const { requestId: _requestId, ...input } = command; const prepared = await f.effects.prepareReview(input);
    expect(prepared.target).toEqual({ repo: command.repo, prNumber: command.number, headSha: sha, actor: 'reviewer' });
    f.setDraining(true);
    await expect(f.effects.prepareReview(input)).rejects.toThrow('unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'provider-effects-')); directories.push(directory);
    const persistence = openPersistence(join(directory, 'state.sqlite')); databases.push(persistence);
    const operations = openOperationStore(persistence, openExecutionStore(persistence));
    const retained = operation(operations);
    const settled = await dispatchOperation(operations, retained.id, f.effects.resolve, { reconcile: true });
    expect(settled.status).toBe('uncertain');
    expect(f.invokeReview).toHaveBeenCalledTimes(1);
  });
  it('rejects a preparation that completed after the selected binding changed', async () => {
    const f = fixture(); const { requestId: _requestId, ...input } = command;
    f.provider.prepareReview = async () => {
      f.setSelected({ ...binding, credentialHandle: 'replaced-credential' });
      return { repo: command.repo, number: command.number, headSha: sha, actor: 'reviewer' };
    };
    await expect(f.effects.prepareReview(input)).rejects.toThrow('changed during preparation');
  });
  it.each([
    ['foreign target', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { request.path = '/repos/owner/other/pulls/12/reviews'; }],
    ['foreign head', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { request.body.commit_id = 'e'.repeat(40); }],
    ['foreign event', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { request.body.event = 'APPROVE'; }],
    ['foreign body', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { request.body.body = 'replacement'; }],
    ['extra body field', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { Object.assign(request.body, { extra: 'replacement' }); }],
    ['nonempty query', (request: { path: string; query: Record<string, string>; body: Record<string, string> }) => { request.query.page = '2'; }],
  ])('does not forward an unbound %s mutation to credential transport', async (_name, mutate) => {
    const f = fixture();
    f.invokeReview.mockImplementation(async (input, context) => {
      const request: MutableReviewRequest = { method: 'POST', path: `/repos/${input.repo}/pulls/${input.number}/reviews`, query: {}, body: {
        event: input.event, body: formatPullRequestReviewBody(input), commit_id: input.headSha,
      } };
      mutate(request);
      await context.http.request(request);
      return { status: 'unknown', reason: 'unreachable', evidence: { code: 'unreachable' } };
    });
    const directory = mkdtempSync(join(tmpdir(), 'provider-effects-')); directories.push(directory);
    const persistence = openPersistence(join(directory, 'state.sqlite')); databases.push(persistence);
    const operations = openOperationStore(persistence, openExecutionStore(persistence)); const retained = operation(operations);
    const settled = await dispatchOperation(operations, retained.id, f.effects.resolve);
    expect(settled.status).toBe('uncertain');
    expect(f.upstream).not.toHaveBeenCalled();
  });
  it('reconstructs and forwards only the canonical retained review mutation', async () => {
    const f = fixture();
    f.invokeReview.mockImplementation(async (input, context) => {
      await context.http.request({ method: 'POST', path: `/repos/${input.repo}/pulls/${input.number}/reviews`, query: {}, body: {
        event: input.event, body: formatPullRequestReviewBody(input), commit_id: input.headSha,
      } });
      return { status: 'acknowledged', receipt: { repo: input.repo, prNumber: input.number, headSha: input.headSha, actor: input.actor, reviewId: 42 } };
    });
    const directory = mkdtempSync(join(tmpdir(), 'provider-effects-')); directories.push(directory);
    const persistence = openPersistence(join(directory, 'state.sqlite')); databases.push(persistence);
    const operations = openOperationStore(persistence, openExecutionStore(persistence)); const retained = operation(operations);
    expect((await dispatchOperation(operations, retained.id, f.effects.resolve)).status).toBe('completed');
    expect(f.upstream).toHaveBeenCalledWith({ method: 'POST', path: '/repos/owner/repo/pulls/12/reviews', query: {}, body: {
      event: 'COMMENT', body: formatPullRequestReviewBody({ id: retained.id, contentHash: retained.contentHash, body: command.body }), commit_id: sha,
    } });
  });
  it('forwards the pre-authorization canonical snapshot when a provider mutates its request while authorization waits', async () => {
    const f = fixture(); let calls = 0; let release!: () => void;
    const authorized = new Promise<void>(resolve => { release = resolve; });
    f.setAuthorize(async () => {
      calls++;
      if (calls === 2) await authorized;
      return { allowed: true };
    });
    f.invokeReview.mockImplementation(async (input, context) => {
      const request: MutableReviewRequest = { method: 'POST', path: `/repos/${input.repo}/pulls/${input.number}/reviews`, query: {}, body: {
        event: input.event, body: formatPullRequestReviewBody(input), commit_id: input.headSha,
      } };
      const pending = context.http.request(request);
      request.path = '/repos/owner/other/pulls/12/reviews'; request.query.page = '2'; request.body.event = 'APPROVE'; request.body.body = 'replacement'; request.body.commit_id = 'e'.repeat(40);
      release(); await pending;
      return { status: 'acknowledged', receipt: { repo: input.repo, prNumber: input.number, headSha: input.headSha, actor: input.actor, reviewId: 42 } };
    });
    const directory = mkdtempSync(join(tmpdir(), 'provider-effects-')); directories.push(directory);
    const persistence = openPersistence(join(directory, 'state.sqlite')); databases.push(persistence);
    const operations = openOperationStore(persistence, openExecutionStore(persistence)); const retained = operation(operations);
    expect((await dispatchOperation(operations, retained.id, f.effects.resolve)).status).toBe('completed');
    expect(f.upstream).toHaveBeenCalledWith({ method: 'POST', path: '/repos/owner/repo/pulls/12/reviews', query: {}, body: {
      event: 'COMMENT', body: formatPullRequestReviewBody({ id: retained.id, contentHash: retained.contentHash, body: command.body }), commit_id: sha,
    } });
  });
});
