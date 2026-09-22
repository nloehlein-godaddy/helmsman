import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunicationRuntime } from './communication-runtime';
import { bootstrapCommunicationProviderSelection, createCommunicationProviderRegistry } from './communication-providers';
import type { CommunicationProviderV1 } from '../../src/plugins/communication-provider';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(network = false) {
  const root = mkdtempSync(join(tmpdir(), 'communication-runtime-')); roots.push(root);
  const env: Record<string, string | undefined> = { SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'true', SLACK_CLIENT_ID: 'T123', SLACK_CHANNEL_ID: 'C123', SLACK_CHANNEL_NAME: 'watched', SLACK_REVIEW_CHANNEL: 'C456', SLACK_REVIEW_MENTION: 'reviewers' };
  const scan = vi.fn<CommunicationProviderV1['scanReviewRequests']>(async () => ({ messages: [], complete: true }));
  const provider: CommunicationProviderV1 = { prepareReviewRequest: vi.fn(), invokeReviewRequest: vi.fn(), reconcileReviewRequest: vi.fn(), scanReviewRequests: scan };
  const registry = createCommunicationProviderRegistry({ eligible: () => true });
  const binding = { providerId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  let identity: string | null = 'endpoint-and-token-hash';
  if (network) provider.connectionIdentity = () => identity;
  registry.publish([registry.stage(binding, provider, {}, network ? 'provider-network' : 'browser-session')]); bootstrapCommunicationProviderSelection(root, binding.providerId);
  const browserRecord = { version: 1 as const, binding: { providerId: 'example.browser/browser', pluginId: 'example.browser', artifactHash: 'b'.repeat(64), contractVersion: 1 as const },
    origin: 'external' as const, settings: { binary: 'browser' }, metadata: { version: 1 as const, label: 'Browser', browser: true } };
  const nativeBrowser = { tree: vi.fn(async () => ({})), focus: vi.fn(async () => {}), evaluate: vi.fn(async () => ({})), click: vi.fn(async () => {}), fill: vi.fn(async () => {}), wait: vi.fn(async () => {}) };
  const nativeProvider = { metadata: browserRecord.metadata, sessionIdentity: () => 'ephemeral', listTabs: vi.fn(), readScreen: vi.fn(), send: vi.fn(), sendKey: vi.fn(), browser: nativeBrowser };
  const registration = { record: browserRecord, provider: nativeProvider };
  const nativeTerminals = { list: vi.fn(() => [registration]), resolve: vi.fn(() => registration), assertCurrent: vi.fn() };
  let operation: unknown;
  const runtime = createCommunicationRuntime({ root, env: () => env, registry, operations: { get: () => operation } as never, nativeTerminals: nativeTerminals as never,
    defaultBrowserProviderId: browserRecord.binding.providerId, browserRuntime: { pluginsRoot: root, runtimeArtifactsRoot: root },
    artifacts: providerBinding => [{ pluginId: providerBinding.pluginId, artifactHash: providerBinding.artifactHash, packageVersion: '1.0.0', requires: [] }], verifyArtifacts: async () => {} });
  return { browserRecord, env, nativeTerminals, runtime, scan, provider, registry, setOperation: (value: unknown) => { operation = value; }, setIdentity: (value: string | null) => { identity = value; } };
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

it('scans and prepares network communication without resolving a browser', async () => {
  const f = fixture(true);
  f.nativeTerminals.list.mockImplementation(() => { throw new Error('Browser unavailable'); });
  f.env.SLACK_BROWSER_SURFACE = 'stale-firefox-surface';
  f.provider.prepareReviewRequest = async (_input, context) => context.destination;
  const destination = f.runtime.destination()!;
  expect(destination).not.toBeNull();
  const scan = f.runtime.captureScan();
  expect(scan.bindings).toHaveLength(1);
  expect(scan.artifacts.map(item => item.pluginId)).toEqual(['example.slack']);
  await expect(f.runtime.scan({ since: null })).resolves.toEqual({ messages: [], complete: true });
  const prepared = await f.runtime.effects.prepareReviewRequest({ repo: 'org/repo', number: 1, expectedDestination: destination });
  expect(prepared.target.browserTransport).toBeUndefined();
  expect(prepared.target.networkTransport).toMatchObject({ kind: 'provider-network', connectionId: destination.connectionId });
  expect(prepared.artifacts.map(item => item.pluginId)).toEqual(['example.slack']);
  expect(f.nativeTerminals.list).not.toHaveBeenCalled();
  const context = f.scan.mock.calls[0][1];
  await expect(context.browser.tree()).rejects.toThrow('Browser access is unavailable');
  await expect(context.beforeSend()).rejects.toThrow('scans cannot send');
});
it('invalidates network scans and admission after credentials change', async () => {
  const f = fixture(true);
  const previous = f.runtime.destination();
  const captured = f.runtime.captureScan();
  f.scan.mockImplementationOnce(async () => { f.setIdentity('replacement-credentials'); return { messages: [], complete: true }; });
  await expect(f.runtime.scan({ since: null })).rejects.toThrow('network connection changed');
  expect(() => captured.assertCurrent()).toThrow('scanner changed');
  expect(f.runtime.destination()?.connectionId).not.toBe(previous?.connectionId);
  f.setIdentity(null);
  expect(f.runtime.selected()).toBeNull();
  expect(() => f.runtime.assertAdmission()).toThrow('unavailable');
});
it('retains network reconciliation and refuses changed credentials before calling the provider', async () => {
  const f = fixture(true);
  f.provider.prepareReviewRequest = async (_input, context) => context.destination;
  f.provider.reconcileReviewRequest = vi.fn<CommunicationProviderV1['reconcileReviewRequest']>(async (_input, context) => {
    await expect(context.beforeSend()).rejects.toThrow('reconciliation cannot send');
    return { status: 'unknown', reason: 'No exact receipt', evidence: {} };
  });
  const prepared = await f.runtime.effects.prepareReviewRequest({ repo: 'org/repo', number: 1, expectedDestination: f.runtime.destination()! });
  const operation = { kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, ...prepared,
    payload: { caller: 'example.page/panel', requestId: 'request' } };
  const signal = new AbortController().signal;
  const adapter = await f.runtime.effects.resolve(operation as never, signal);
  expect(adapter).not.toBeNull();
  const context = { signal, idempotencyKey: 'key', generation: 1 };
  await expect(adapter!.reconcile(operation as never, context)).resolves.toMatchObject({ status: 'unknown' });
  f.setIdentity('replacement-credentials');
  await expect(adapter!.reconcile(operation as never, context)).rejects.toThrow('network connection changed');
  expect(f.provider.reconcileReviewRequest).toHaveBeenCalledTimes(1);
});

it('checks retained network delivery authority immediately before send', async () => {
  const f = fixture(true);
  f.provider.prepareReviewRequest = async (_input, context) => context.destination;
  const send = vi.fn();
  f.provider.invokeReviewRequest = async (_input, context) => {
    await context.beforeSend();
    send();
    return { status: 'acknowledged', receipt: { ...context.destination, permalink: null } };
  };
  const prepared = await f.runtime.effects.prepareReviewRequest({ repo: 'org/repo', number: 1, expectedDestination: f.runtime.destination()! });
  const operation = { id: 'operation', contentHash: 'content', generation: 1, status: 'leased', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, ...prepared,
    payload: { caller: 'example.page/panel', requestId: 'request' } };
  f.setOperation(operation);
  const signal = new AbortController().signal;
  const adapter = await f.runtime.effects.resolve(operation as never, signal);
  const context = { signal, idempotencyKey: 'key', generation: 1 };
  await expect(adapter!.invoke(operation as never, context)).resolves.toMatchObject({ status: 'acknowledged' });
  f.provider.invokeReviewRequest = async (_input, context) => {
    f.setIdentity('changed-before-send');
    await context.beforeSend();
    send();
    return { status: 'unknown', reason: 'uncertain', evidence: {} };
  };
  await expect(adapter!.invoke(operation as never, context)).rejects.toThrow('connection changed');
  expect(send).toHaveBeenCalledTimes(1);
});
it('refuses retained reconciliation after provider settings change', async () => {
  const f = fixture(true);
  f.provider.prepareReviewRequest = async (_input, context) => context.destination;
  const prepared = await f.runtime.effects.prepareReviewRequest({ repo: 'org/repo', number: 1, expectedDestination: f.runtime.destination()! });
  const operation = { kind: 'communication.review-request', origin: { kind: 'public-communication-review-request', runId: null, attempt: null }, ...prepared,
    payload: { caller: 'example.page/panel', requestId: 'request' } };
  const signal = new AbortController().signal;
  const adapter = await f.runtime.effects.resolve(operation as never, signal);
  const registration = f.registry.list()[0];
  f.registry.removePlugin(registration.binding.pluginId);
  f.registry.publish([f.registry.stage(registration.binding, f.provider, { endpoint: 'changed' }, 'provider-network')]);
  await expect(adapter!.reconcile(operation as never, { signal, idempotencyKey: 'key', generation: 1 })).rejects.toThrow('network connection changed');
  expect(f.provider.reconcileReviewRequest).not.toHaveBeenCalled();
});
