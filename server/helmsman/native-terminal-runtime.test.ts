import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeTerminalProviderV1 } from '../../src/plugins/native-terminal';
import { parsePluginPackage } from '../../src/plugins/package';
import { createNativeTerminalProviderRegistry } from './native-terminal-providers';
import { createSelectedNativeTerminalRuntime } from './native-terminal-runtime';
import { createTerminalService } from './terminal-service';
import { openPersistence } from './persistence';
import { selectNativeTerminalProvider } from './plugins/data';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

it('fences provider, settings and native-session changes while preserving recorded receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-native-runtime-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const persistence = openPersistence(':memory:'); cleanup.push(() => persistence.close());
  let enabled = true; let session = 'original';
  const registry = createNativeTerminalProviderRegistry({ eligible: () => enabled });
  const provider: NativeTerminalProviderV1 = {
    metadata: { version: 1, label: 'Alternate terminal', browser: false }, sessionIdentity: () => session,
    listTabs: async () => ({ connected: true, tabs: [{ windowRef: 'window', workspaceRef: 'workspace', workspaceTitle: 'Work',
      surfaceRef: 'remote/session-a?pane=one', surfaceTitle: 'shell', type: 'terminal', cwd: '/work/a', selected: true }] }),
    readScreen: async () => ({ ok: true, text: 'original screen' }),
    send: vi.fn(async () => ({ ok: true as const })), sendKey: async () => ({ ok: true }),
  };
  const pkg = parsePluginPackage({ packageVersion: 1, manifest: { manifestVersion: 1, id: 'example.native', version: '1.0.0', sdkVersion: 1, pages: [] },
    entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 }, backend: { entry: 'backend.js', provides: [{ id: 'helmsman/native-terminal', version: 1, localId: 'first' }, { id: 'helmsman/native-terminal', version: 1, localId: 'second' }],
      nativeTerminals: { first: { access: ['native-session'] }, second: { access: ['native-session'] } }, settings: {}, storageVersion: 1 } });
  const register = (localId: string, settings = {}) => registry.publish([registry.stage({ provider, package: pkg, origin: 'external', settings,
    binding: { providerId: `example.native/${localId}`, pluginId: 'example.native', artifactHash: 'a'.repeat(64), contractVersion: 1 } })]);
  register('first'); register('second');
  const runtime = createSelectedNativeTerminalRuntime({ root, registry, defaultProviderId: 'example.native/first' });
  const service = createTerminalService({ persistence, ...runtime, repos: () => ['org/a'], roots: () => [{ repo: 'org/a', path: '/work/a' }], authorize: () => {} });
  const caller = 'example.terminal/panel';
  const target = (await service.list(caller, { version: 1, repo: 'org/a' }, 'org/a')).tabs[0]!.target;
  const command = { version: 1 as const, requestId: '30000000-0000-4000-8000-000000000001', target, operation: { kind: 'text' as const, text: 'once', enter: false } };
  expect((await service.control(caller, command, 'org/a')).status).toBe('succeeded');
  const original = runtime.sessionIdentity();
  registry.removePlugin('example.native'); register('second'); register('first', { socketPath: '/changed' }); expect(runtime.sessionIdentity()).not.toBe(original);
  expect((await service.control(caller, { ...command, requestId: '30000000-0000-4000-8000-000000000002' }, 'org/a')).status).toBe('rejected');
  const settingsChanged = runtime.sessionIdentity();
  selectNativeTerminalProvider(root, 'terminal', 'example.native/second'); expect(runtime.sessionIdentity()).not.toBe(settingsChanged);
  const providerChanged = runtime.sessionIdentity(); session = 'replacement-native-session'; expect(runtime.sessionIdentity()).not.toBe(providerChanged);
  enabled = false;
  await expect(service.list(caller, { version: 1, repo: 'org/a' }, 'org/a')).rejects.toMatchObject({ reason: 'service-unavailable' });
  expect((await service.control(caller, command, 'org/a')).status).toBe('succeeded');
  expect(provider.send).toHaveBeenCalledOnce();
});
