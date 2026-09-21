import { describe, expect, it, vi } from 'vitest';
import { createCommunicationProviderEffects } from './communication-provider-effects';

const hash = 'a'.repeat(64);
const browserHash = 'b'.repeat(64);
const binding = { role: 'effect' as const, capability: 'helmsman/communication', contractVersion: 1 as const, contributionId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: hash, connectionId: 'connection', credentialHandle: 'credential' };
const destination = { providerId: binding.contributionId, artifactHash: hash, workspace: 'T123', channel: 'C123', mention: 'reviewers', connectionId: 'connection' };
const communicationArtifact = { pluginId: binding.pluginId, artifactHash: hash, packageVersion: '1.0.0', requires: [] };
const browserArtifact = { pluginId: 'example.browser', artifactHash: browserHash, packageVersion: '1.0.0', requires: [] };
const browserTransport = { provider: { version: 1 as const, binding: { providerId: 'example.browser/browser', pluginId: 'example.browser', artifactHash: browserHash, contractVersion: 1 as const },
  origin: 'external' as const, settings: { binary: 'browser' }, metadata: { version: 1 as const, label: 'Browser', browser: true } }, artifacts: [browserArtifact], surface: 'browser/slack' };
const provider = { prepareReviewRequest: vi.fn(async () => ({ workspace: 'T123', channel: 'C123', mention: 'reviewers', connectionId: 'connection' })), invokeReviewRequest: vi.fn(async () => ({ status: 'unknown' as const, reason: 'unconfirmed', evidence: {} })), reconcileReviewRequest: vi.fn(async () => ({ status: 'unknown' as const, reason: 'unconfirmed', evidence: {} })), scanReviewRequests: vi.fn(async () => ({ messages: [], complete: true })) };
const browser = { tree: async () => ({}), focus: async () => {}, evaluate: async () => ({}), click: async () => {}, fill: async () => {}, wait: async () => {} };

function fixture(watchedChannel = { id: 'C123', name: 'reviews' }, assertCurrent = () => {}) {
  const retainedSession = vi.fn(async () => ({ surface: browserTransport.surface, watchedChannel, browser, dispose: vi.fn(async () => {}) }));
  const effects = createCommunicationProviderEffects({
    registry: { resolve: vi.fn(() => ({ binding: { providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: hash, contractVersion: 1 as const, connectionId: null, credentialHandle: null }, provider })) } as never,
    selected: () => binding, destination: () => destination, artifacts: () => [communicationArtifact], verifyArtifacts: async () => {},
    admissionSession: () => ({ browserTransport, surface: browserTransport.surface, watchedChannel, browser, assertCurrent }), retainedSession,
  });
  return { effects, retainedSession };
}

describe('communication provider effects', () => {
  it('pins the selected destination and exact browser transport during preparation', async () => {
    const result = await fixture().effects.prepareReviewRequest({ repo: 'owner/repo', number: 1, expectedDestination: destination });
    expect(result).toMatchObject({ binding, artifacts: [communicationArtifact, browserArtifact], target: { repo: 'owner/repo', number: 1, destination, browserTransport } });
  });
  it('prepares review delivery without watcher configuration', async () => {
    await expect(fixture({ id: '', name: '' }).effects.prepareReviewRequest({ repo: 'owner/repo', number: 1, expectedDestination: destination })).resolves.toMatchObject({ target: { destination } });
  });
  it('rejects a browser selection revision change during preparation', async () => {
    const assertCurrent = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('selection changed'); });
    await expect(fixture(undefined, assertCurrent).effects.prepareReviewRequest({ repo: 'owner/repo', number: 1, expectedDestination: destination })).rejects.toThrow('selection changed');
  });
  it('reconciles through the originally captured browser transport', async () => {
    const f = fixture();
    const operation = { kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, binding,
      artifacts: [communicationArtifact, browserArtifact], target: { repo: 'owner/repo', number: 1, destination, browserTransport }, payload: { caller: 'example.page/panel', requestId: 'request' } };
    const adapter = await f.effects.resolve(operation as never, new AbortController().signal);
    expect(adapter).not.toBeNull();
    await adapter!.reconcile(operation as never, { signal: new AbortController().signal, idempotencyKey: 'key', generation: 1 });
    expect(f.retainedSession).toHaveBeenCalledWith(expect.objectContaining({ provider: browserTransport.provider }), destination, expect.any(AbortSignal));
  });
  it('does not claim legacy operations without a captured browser transport', async () => {
    const operation = { kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, binding,
      artifacts: [communicationArtifact], target: { repo: 'owner/repo', number: 1, destination }, payload: { caller: 'example.page/panel', requestId: 'request' } };
    await expect(fixture().effects.resolve(operation as never, new AbortController().signal)).resolves.toBeNull();
  });
  it('does not fall back when a captured browser artifact is missing', async () => {
    const f = fixture();
    const operation = { kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, binding,
      artifacts: [communicationArtifact], target: { repo: 'owner/repo', number: 1, destination, browserTransport }, payload: { caller: 'example.page/panel', requestId: 'request' } };
    await expect(f.effects.resolve(operation as never, new AbortController().signal)).resolves.toBeNull();
    expect(f.retainedSession).not.toHaveBeenCalled();
  });
});
