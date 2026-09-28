import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommunicationProviderV1 } from '../../src/plugins/communication-provider';
import { createCommunicationRuntime } from './communication-runtime';
import { bootstrapCommunicationProviderSelection, createCommunicationProviderRegistry } from './communication-providers';
import { selectCommunicationProvider } from './plugins/data';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture(withConnection = true) {
  const root = mkdtempSync(join(tmpdir(), 'communication-connection-')); roots.push(root);
  let eligible = true;
  const registry = createCommunicationProviderRegistry({ eligible: () => eligible });
  const provider: CommunicationProviderV1 = {
    prepareReviewRequest: vi.fn(), invokeReviewRequest: vi.fn(), reconcileReviewRequest: vi.fn(), scanReviewRequests: vi.fn(), connectionIdentity: () => null,
    ...(withConnection ? { connection: { status: vi.fn(), begin: vi.fn(), complete: vi.fn(), disconnect: vi.fn(), check: vi.fn() } } : {}),
  };
  const binding = { providerId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  const registration = registry.stage(binding, provider, { client: 'original' }, 'provider-network');
  registry.publish([registration]); bootstrapCommunicationProviderSelection(root, binding.providerId);
  const nativeTerminals = { list: vi.fn(() => { throw new Error('Browser must not be resolved'); }) };
  const runtime = createCommunicationRuntime({ root, registry, env: () => ({ SLACK_CLIENT_ID: 'T123', SLACK_ENABLED: 'true' }), operations: {} as never, nativeTerminals: nativeTerminals as never,
    defaultBrowserProviderId: 'example.browser/browser', browserRuntime: { pluginsRoot: root, runtimeArtifactsRoot: root }, artifacts: () => [], verifyArtifacts: async () => {} });
  return { root, runtime, registry, binding, provider, registration, nativeTerminals, disable() { eligible = false; } };
}

it('exposes connection setup before credentials exist without resolving a browser', () => {
  const f = fixture(); const captured = f.runtime.captureConnection();
  expect(captured?.providerId).toBe(f.binding.providerId); expect(captured?.provider).toBe(f.provider.connection);
  expect(() => captured?.assertCurrent()).not.toThrow(); expect(f.nativeTerminals.list).not.toHaveBeenCalled();
});

it('leaves providers without the opt-in connection contract unsupported', () => {
  expect(fixture(false).runtime.captureConnection()).toBeNull();
});

it.each(['disabled', 'deselected', 'removed'] as const)('invalidates a retained capture when its provider is %s', change => {
  const f = fixture(); const captured = f.runtime.captureConnection()!;
  if (change === 'disabled') f.disable();
  else if (change === 'deselected') selectCommunicationProvider(f.root, null);
  else f.registry.removePlugin(f.binding.pluginId);
  expect(() => captured.assertCurrent()).toThrow('Communication provider changed'); expect(f.runtime.captureConnection()).toBeNull();
});

it('rejects an older registration even when its replacement has the same public binding', () => {
  const f = fixture(); const captured = f.runtime.captureConnection()!;
  f.registry.removePlugin(f.binding.pluginId); f.registry.publish([f.registry.stage(f.binding, f.provider, { client: 'original' }, 'provider-network')]);
  expect(f.runtime.captureConnection()?.identity).toBe(captured.identity);
  expect(() => captured.assertCurrent()).toThrow('Communication provider changed');
});

it('changes connection capture identity when the artifact or provider settings change', () => {
  const f = fixture(); const captured = f.runtime.captureConnection()!;
  f.registry.removePlugin(f.binding.pluginId);
  f.registry.publish([f.registry.stage({ ...f.binding, artifactHash: 'b'.repeat(64) }, f.provider, { client: 'replacement' }, 'provider-network')]);
  expect(f.runtime.captureConnection()?.identity).not.toBe(captured.identity); expect(() => captured.assertCurrent()).toThrow('Communication provider changed');
});


it('refreshes an expired connection before host selection without browser status calls', async () => {
  const f = fixture(); let identity: string | null = null;
  f.provider.connectionIdentity = () => identity;
  vi.mocked(f.provider.connection!.status).mockImplementation(async () => {
    identity = 'same-account-grant';
    return { status: 'connected', message: 'Connected', accountLabel: 'operator', redirectUri: null };
  });
  expect(f.runtime.selected()).toBeNull();
  await f.runtime.refreshConnection(new AbortController().signal);
  expect(f.runtime.selected()?.contributionId).toBe(f.binding.providerId);
  expect(f.nativeTerminals.list).not.toHaveBeenCalled();
});

it('rejects refresh completion after the selected provider becomes unavailable', async () => {
  const f = fixture();
  vi.mocked(f.provider.connection!.status).mockImplementation(async () => {
    f.disable();
    return { status: 'connected', message: 'Connected', accountLabel: 'operator', redirectUri: null };
  });
  await expect(f.runtime.refreshConnection(new AbortController().signal)).rejects.toThrow('Communication provider changed');
  expect(f.runtime.selected()).toBeNull();
});
