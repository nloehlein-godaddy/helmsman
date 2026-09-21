import { describe, expect, it } from 'vitest';
import type { PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import { createPullRequestProviderRegistry } from './pull-request-providers';

const hash = 'a'.repeat(64);
const binding = { providerId: 'example.github/github', pluginId: 'example.github', artifactHash: hash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
const provider: PullRequestProviderV1 = {
  list: async () => ({ items: [], quality: 'complete', truncated: false, browseUrl: null }),
  detail: async () => { throw new Error('Unused'); }, diff: async () => { throw new Error('Unused'); },
  prepareReview: async () => { throw new Error('Unused'); }, invokeReview: async () => { throw new Error('Unused'); }, reconcileReview: async () => { throw new Error('Unused'); },
};

describe('pull request provider registry', () => {
  it('denies new admissions while retaining only the exact pinned provider for obligations', () => {
    let draining = false;
    const registry = createPullRequestProviderRegistry({ eligible: (candidate, purpose) => candidate.pluginId === binding.pluginId && (!draining || purpose === 'obligation') });
    registry.publish([registry.stage(binding, provider)]);
    expect(registry.resolve(binding, 'admission').provider).toBe(provider);
    draining = true;
    expect(registry.list()).toEqual([]);
    expect(() => registry.resolve(binding, 'admission')).toThrow('unavailable');
    expect(registry.resolve(binding, 'obligation').provider).toBe(provider);
    expect(() => registry.resolve({ ...binding, artifactHash: 'b'.repeat(64) }, 'obligation')).toThrow('unavailable');
  });

  it('rejects incomplete provider implementations before publication', () => {
    const registry = createPullRequestProviderRegistry({ eligible: () => true });
    expect(() => registry.stage(binding, { ...provider, reconcileReview: undefined } as unknown as PullRequestProviderV1)).toThrow('Invalid pull request provider');
  });
  it('keeps profiles optional and rejects noncallable profile hooks', () => {
    const registry = createPullRequestProviderRegistry({ eligible: () => true });
    expect(() => registry.stage(binding, provider)).not.toThrow();
    expect(() => registry.stage(binding, { ...provider, profile: async () => ({ displayName: null, login: null }) })).not.toThrow();
    expect(() => registry.stage(binding, { ...provider, profile: null } as unknown as PullRequestProviderV1)).toThrow('Invalid pull request provider');
  });
});
