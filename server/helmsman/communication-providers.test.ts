import { describe, expect, it } from 'vitest';
import { createCommunicationProviderRegistry } from './communication-providers';

const hash = 'a'.repeat(64);
const binding = { providerId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: hash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
const provider = { prepareReviewRequest: async () => ({ workspace: 'T123', channel: 'C123', mention: 'reviewers', connectionId: 'connection' }), invokeReviewRequest: async () => ({ status: 'unknown' as const, reason: 'unknown', evidence: {} }), reconcileReviewRequest: async () => ({ status: 'unknown' as const, reason: 'unknown', evidence: {} }), scanReviewRequests: async () => ({ messages: [], complete: true }) };

describe('communication provider registry', () => {
  it('uses an exact artifact binding and removes registrations by plugin', () => {
    const registry = createCommunicationProviderRegistry({ eligible: () => true });
    registry.publish([registry.stage(binding, provider)]);
    expect(registry.resolve(binding, 'admission').provider).toBe(provider);
    expect(() => registry.resolve({ ...binding, artifactHash: 'b'.repeat(64) }, 'admission')).toThrow();
    registry.removePlugin(binding.pluginId);
    expect(registry.list()).toEqual([]);
  });
});
