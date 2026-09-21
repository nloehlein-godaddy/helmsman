import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
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

function fixture() {
  let draining = false;
  let selected: ProviderBinding | null = binding;
  const provider: PullRequestProviderV1 = {
    list: async () => ({ items: [], quality: 'complete', truncated: false, browseUrl: null }), detail: async () => { throw new Error('Unused'); }, diff: async () => { throw new Error('Unused'); },
    prepareReview: async () => ({ repo: command.repo, number: command.number, headSha: sha, actor: 'reviewer' }),
    invokeReview: vi.fn(async () => ({ status: 'acknowledged' as const, receipt: { repo: command.repo, prNumber: command.number, headSha: sha, actor: 'other-actor', reviewId: 42 } })),
    reconcileReview: async () => ({ status: 'unknown' as const, reason: 'Not observed', evidence: { code: 'not-observed' } }),
  };
  const registry = createPullRequestProviderRegistry({ eligible: (_binding, purpose) => !draining || purpose === 'obligation' });
  registry.publish([registry.stage({ providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null }, provider)]);
  const effects = createPullRequestProviderEffects({ registry, selected: () => selected, artifacts: () => [artifact], verifyArtifacts: async () => {},
    http: () => ({ request: async () => ({ status: 200, body: {} }) }) });
  return { provider, registry, effects, setDraining: (value: boolean) => { draining = value; }, setSelected: (value: ProviderBinding | null) => { selected = value; } };
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
    const operation = operations.enqueue({ version: 1, key: 'public-review:test', kind: 'pull-request.review',
      origin: { kind: 'public-pull-request-review', id: command.requestId, revision: 'c'.repeat(64), runId: null, attempt: null }, binding, artifacts: [artifact],
      target: prepared.target, payload: { caller: 'example.reviews/review', command, event: command.event, body: command.body, manual: true, expectedHeadSha: sha } });
    const settled = await dispatchOperation(operations, operation.id, f.effects.resolve, { reconcile: true });
    expect(settled.status).toBe('uncertain');
    expect(f.provider.invokeReview).toHaveBeenCalledTimes(1);
  });
  it('rejects a preparation that completed after the selected binding changed', async () => {
    const f = fixture(); const { requestId: _requestId, ...input } = command;
    f.provider.prepareReview = async () => {
      f.setSelected({ ...binding, credentialHandle: 'replaced-credential' });
      return { repo: command.repo, number: command.number, headSha: sha, actor: 'reviewer' };
    };
    await expect(f.effects.prepareReview(input)).rejects.toThrow('changed during preparation');
  });
});
