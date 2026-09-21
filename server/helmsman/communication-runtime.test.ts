import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunicationRuntime } from './communication-runtime';
import { bootstrapCommunicationProviderSelection, createCommunicationProviderRegistry } from './communication-providers';
import type { CommunicationProviderV1 } from '../../src/plugins/communication-provider';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'communication-runtime-')); roots.push(root);
  const env: Record<string, string | undefined> = { SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'true', SLACK_CLIENT_ID: 'T123', SLACK_CHANNEL_ID: 'C123', SLACK_CHANNEL_NAME: 'watched', SLACK_REVIEW_CHANNEL: 'C456', SLACK_REVIEW_MENTION: 'reviewers' };
  const scan = vi.fn<CommunicationProviderV1['scanReviewRequests']>(async () => ({ messages: [], complete: true }));
  const provider: CommunicationProviderV1 = { prepareReviewRequest: vi.fn(), invokeReviewRequest: vi.fn(), reconcileReviewRequest: vi.fn(), scanReviewRequests: scan };
  const registry = createCommunicationProviderRegistry({ eligible: () => true });
  const binding = { providerId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  registry.publish([registry.stage(binding, provider)]); bootstrapCommunicationProviderSelection(root, binding.providerId);
  const browserRecord = { version: 1 as const, binding: { providerId: 'example.browser/browser', pluginId: 'example.browser', artifactHash: 'b'.repeat(64), contractVersion: 1 as const },
    origin: 'external' as const, settings: { binary: 'browser' }, metadata: { version: 1 as const, label: 'Browser', browser: true } };
  const nativeBrowser = { tree: vi.fn(async () => ({})), focus: vi.fn(async () => {}), evaluate: vi.fn(async () => ({})), click: vi.fn(async () => {}), fill: vi.fn(async () => {}), wait: vi.fn(async () => {}) };
  const nativeProvider = { metadata: browserRecord.metadata, sessionIdentity: () => 'ephemeral', listTabs: vi.fn(), readScreen: vi.fn(), send: vi.fn(), sendKey: vi.fn(), browser: nativeBrowser };
  const registration = { record: browserRecord, provider: nativeProvider };
  const nativeTerminals = { list: vi.fn(() => [registration]), resolve: vi.fn(() => registration), assertCurrent: vi.fn() };
  const runtime = createCommunicationRuntime({ root, env: () => env, registry, operations: {} as never, nativeTerminals: nativeTerminals as never,
    defaultBrowserProviderId: browserRecord.binding.providerId, browserRuntime: { pluginsRoot: root, runtimeArtifactsRoot: root },
    artifacts: providerBinding => [{ pluginId: providerBinding.pluginId, artifactHash: providerBinding.artifactHash, packageVersion: '1.0.0', requires: [] }], verifyArtifacts: async () => {} });
  return { browserRecord, env, nativeTerminals, runtime, scan };
}
it.each([undefined, '', 'surface:3'])('keeps notification scanner identity valid with optional browser surface %s', async surface => {
  const f = fixture(); f.env.SLACK_BROWSER_SURFACE = surface;
  const key = f.runtime.scanKey(); expect(JSON.parse(key).settings.surface).toBe(surface || null);
  await expect(f.runtime.scan({ since: null })).resolves.toEqual({ complete: true, messages: [] }); expect(f.scan).toHaveBeenCalledTimes(1);
  f.env.SLACK_WATCH_ENABLED = 'false'; expect(() => f.runtime.scanKey()).not.toThrow();
});
it('rejects scanner results when the browser surface changes during the read', async () => {
  const f = fixture(); let complete!: () => void; f.scan.mockImplementationOnce(async () => { await new Promise<void>(resolve => { complete = resolve; }); return { messages: [], complete: true }; });
  const result = f.runtime.scan({ since: null }); await vi.waitFor(() => expect(f.scan).toHaveBeenCalledOnce()); f.env.SLACK_BROWSER_SURFACE = 'surface:4'; complete(); await expect(result).rejects.toThrow('Communication scanner changed during read.');
});
it('changes the connection identity when retained browser settings change', () => {
  const f = fixture(); const before = f.runtime.destination()?.connectionId;
  f.browserRecord.settings.binary = 'replacement';
  expect(f.runtime.destination()?.connectionId).not.toBe(before);
});
it('returns a stable unavailable scan key when no browser provider is selected', () => {
  const f = fixture(); f.nativeTerminals.list.mockReturnValue([]);
  const first = f.runtime.scanKey(); const second = f.runtime.scanKey();
  expect(second).toBe(first);
  expect(JSON.parse(first)).toMatchObject({ binding: null, browser: null, unavailable: true });
  expect(f.runtime.selected()).toBeNull();
});
