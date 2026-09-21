import { describe, expect, it, vi } from 'vitest';
import { createCommunicationProviderEffects } from './communication-provider-effects';

const hash = 'a'.repeat(64);
const binding = { role: 'effect' as const, capability: 'helmsman/communication', contractVersion: 1 as const, contributionId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: hash, connectionId: 'connection', credentialHandle: 'credential' };
const destination = { providerId: binding.contributionId, artifactHash: hash, workspace: 'T123', channel: 'C123', mention: 'reviewers', connectionId: 'connection' };
const provider = { prepareReviewRequest: vi.fn(async () => ({ workspace: 'T123', channel: 'C123', mention: 'reviewers', connectionId: 'connection' })), invokeReviewRequest: vi.fn(async () => ({ status: 'unknown' as const, reason: 'unconfirmed', evidence: {} })), reconcileReviewRequest: vi.fn(async () => ({ status: 'unknown' as const, reason: 'unconfirmed', evidence: {} })), scanReviewRequests: vi.fn(async () => ({ messages: [], complete: true })) };

function effects(watchedChannel = { id: 'C123', name: 'reviews' }) {
  return createCommunicationProviderEffects({
    registry: { resolve: vi.fn(() => ({ binding: { providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: hash, contractVersion: 1 as const, connectionId: null, credentialHandle: null }, provider })) } as never,
    selected: () => binding, destination: () => destination, artifacts: () => [{ pluginId: binding.pluginId, artifactHash: hash, packageVersion: '1.0.0', requires: [] }], verifyArtifacts: async () => {},
    session: () => ({ surface: 'surface', watchedChannel, browser: { tree: async () => ({}), focus: async () => {}, evaluate: async () => ({}), click: async () => {}, fill: async () => {}, wait: async () => {} } }),
  });
}

describe('communication provider effects', () => {
  it('pins the selected destination during preparation', async () => {
    const result = await effects().prepareReviewRequest({ repo: 'owner/repo', number: 1, expectedDestination: destination });
    expect(result).toMatchObject({ binding, target: { repo: 'owner/repo', number: 1, destination } });
  });
  it('prepares review delivery without watcher configuration', async () => {
    await expect(effects({ id: '', name: '' }).prepareReviewRequest({ repo: 'owner/repo', number: 1, expectedDestination: destination })).resolves.toMatchObject({ target: { destination } });
  });
  it('does not claim legacy Slack operations', async () => {
    const operation = { kind: 'slack.review-request', origin: { kind: 'slack-request', runId: null, attempt: null } };
    await expect(effects().resolve(operation as never, new AbortController().signal)).resolves.toBeNull();
  });
});
