// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNativeTerminalTabsV1, type NativeTerminalMetadataV1, type NativeTerminalProviderV1 } from '../../src/plugins/native-terminal';
import { parsePluginPackage } from '../../src/plugins/package';
import { boundedNativeTerminalProvider, createNativeTerminalProviderRegistry, parseNativeTerminalRetainedProviderV1 } from './native-terminal-providers';
import { loadRetainedNativeTerminalProvider } from './native-terminal-retained-loader';
import { assertNativeTerminalSelectionCurrent, resolveNativeTerminalSelection } from './native-terminal-selection';
import { retainLegacyRuntime } from './legacy-runtime-artifact';
import { installPluginArtifact } from './plugins/artifacts';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { clearPluginSettings, nativeTerminalProviderSelectionInitialized, initializeNativeTerminalProviderSelection, initializeNativeTerminalSettings, readNativeTerminalProviderSelection, readPluginSettings, selectNativeTerminalProvider, writePluginSettings } from './plugins/data';
import { pluginCommand } from './plugins/cli';

const metadata: NativeTerminalMetadataV1 = { version: 1, label: 'Example terminal', browser: false };
const surface = { windowRef: 'window/one', workspaceRef: 'space:one', workspaceTitle: '', surfaceRef: 'remote/tab-1', surfaceTitle: 'Shell', type: 'terminal', cwd: null, selected: true };
const provider: NativeTerminalProviderV1 = { metadata, sessionIdentity: () => 'original-session', async listTabs() { return { connected: true, tabs: [surface] }; }, async readScreen() { return { ok: true, text: 'hello\n\u001b[0m' }; }, async send() { return { ok: true }; }, async sendKey() { return { ok: true }; } };
const browser: NonNullable<NativeTerminalProviderV1['browser']> = { async tree() { return { windows: [] }; }, async focus() {}, async evaluate() { return null; }, async click() {}, async fill() {}, async wait() {} };
function descriptor(id = 'example.terminal') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/native-terminal', version: 1, localId: 'native' }], nativeTerminals: { native: { access: ['native-session'] } }, storageVersion: 1,
      settings: { socket: { type: 'string', default: 'original', maxLength: 4096 } } } };
}
const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(value => value.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-terminals-')); roots.push(root); return root; }
const source = `export default { activate(context) {
 if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerNativeTerminal,settings,signal') throw new Error('Unexpected terminal services');
 context.registerNativeTerminal('native', { metadata: ${JSON.stringify(metadata)}, sessionIdentity() { return context.settings.socket; },
 async listTabs() { return {connected:true,tabs:[]}; }, async readScreen() { return {ok:true,text:context.settings.socket}; }, async send() { return {ok:true}; }, async sendKey() { return {ok:true}; } });
} };`;
async function fixture(body = source, pkg = descriptor()) {
  const root = await temporary();
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: pkg, files: [{ path: 'backend.js', base64: Buffer.from(body).toString('base64') }] })));
  const record = parseNativeTerminalRetainedProviderV1({ version: 1, binding: { providerId: 'example.terminal/native', pluginId: 'example.terminal', artifactHash: archive.hash, contractVersion: 1 }, origin: 'external', settings: { socket: 'retained' }, metadata });
  const artifacts = [{ pluginId: 'example.terminal', artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }];
  return { root, archive, record, artifacts, load: () => loadRetainedNativeTerminalProvider({ pluginsRoot: root, runtimeArtifactsRoot: join(root, 'legacy'), record, artifacts }) };
}
it('checks the entire retained closure before evaluating the selected compatible provider', async () => {
  const marker = '__retainedClosurenative_terminal';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    const f = await fixture(`globalThis.${marker} = true; export default { activate() {} };`);
    const dependency = await installPluginArtifact(f.root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
      package: { ...f.archive.package, manifest: { ...f.archive.package.manifest, id: 'example.incompatible' }, node: { minMajor: major + 1, maxMajorExclusive: major + 2 } },
      files: [...f.archive.files].map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') })),
    })));
    const artifacts = [{ ...f.artifacts[0]!, requires: ['example.incompatible'] },
      { pluginId: 'example.incompatible', artifactHash: dependency.hash, packageVersion: '1.0.0', requires: [] }];
    await expect(loadRetainedNativeTerminalProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts })).rejects.toThrow('does not support Node');
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('blocks retained external code outside its Node range before top-level evaluation', async () => {
  const marker = '__retainedCompatibilitynative_terminal';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    for (const node of [{ minMajor: major - 1, maxMajorExclusive: major }, { minMajor: major + 1, maxMajorExclusive: major + 2 }]) {
      const f = await fixture(`globalThis.${marker} = true;\n${source}`, { ...descriptor(), node });
      await expect(f.load()).rejects.toThrow('does not support Node');
      expect(Reflect.get(globalThis, marker)).toBeUndefined();
    }
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('accepts opaque references and rejects malformed native values before side effects', async () => {
  const send = vi.fn(provider.send); const sendKey = vi.fn(provider.sendKey); const readScreen = vi.fn(provider.readScreen);
  const bounded = boundedNativeTerminalProvider({ ...provider, send, sendKey, readScreen });
  await expect(bounded.listTabs()).resolves.toEqual({ connected: true, tabs: [surface] });
  await expect(bounded.readScreen(surface.surfaceRef, 10)).resolves.toEqual({ ok: true, text: 'hello\n\u001b[0m' }); readScreen.mockClear();
  for (const ref of ['', 'a\nb', 'x'.repeat(257)]) await expect(bounded.send(ref, 'hello', true)).rejects.toThrow();
  await expect(bounded.send(surface.surfaceRef, 'bad\0text', true)).rejects.toThrow();
  await expect(bounded.send(surface.surfaceRef, 'x'.repeat(128 * 1024 + 1), true)).rejects.toThrow();
  await expect(bounded.send(surface.surfaceRef, '', undefined as never)).rejects.toThrow();
  await expect(bounded.sendKey(surface.surfaceRef, null as never)).rejects.toThrow();
  for (const lines of [0, NaN, 1.5, 10001]) await expect(bounded.readScreen(surface.surfaceRef, lines)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled(); expect(sendKey).not.toHaveBeenCalled(); expect(readScreen).not.toHaveBeenCalled();
  for (const value of [{ connected: true, tabs: [null] }, { connected: true, tabs: [surface, surface] }, { connected: false, tabs: [surface] }, { connected: true, tabs: [{ ...surface, selected: undefined }] }]) expect(() => parseNativeTerminalTabsV1(value)).toThrow();
  await expect(boundedNativeTerminalProvider({ ...provider, async send() { return { ok: null } as never; } }).send(surface.surfaceRef, '', false)).rejects.toThrow();
  await expect(boundedNativeTerminalProvider({ ...provider, async readScreen() { return { ok: true, text: 'x'.repeat(1024 * 1024 + 1) }; } }).readScreen(surface.surfaceRef, 1)).rejects.toThrow();
});
it('requires native-only declarations and complete browser capability agreement', async () => {
  const pkg = descriptor();
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, provides: [...pkg.backend.provides, { id: 'helmsman/pricing', version: 1, localId: 'price' }] } })).toThrow('native-terminal-only');
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, nativeTerminals: { native: { access: ['storage'] } } } })).toThrow();
  expect(() => boundedNativeTerminalProvider({ ...provider, browser })).toThrow('metadata');
  expect(() => boundedNativeTerminalProvider({ ...provider, metadata: { ...metadata, browser: true } })).toThrow('metadata');
  expect(() => boundedNativeTerminalProvider({ ...provider, metadata: { ...metadata, browser: true }, browser: { ...browser, fill: undefined } as never })).toThrow('incomplete');
  const fill = vi.fn(browser.fill); const wait = vi.fn(browser.wait);
  const bounded = boundedNativeTerminalProvider({ ...provider, metadata: { ...metadata, browser: true }, browser: { ...browser, fill, wait } }).browser!;
  await expect(bounded.fill({ surface: surface.surfaceRef, selector: '', value: 'hello' })).rejects.toThrow();
  await expect(bounded.wait({ surface: surface.surfaceRef, selector: '#target', timeoutMs: 15001 })).rejects.toThrow();
  expect(fill).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  const malformed = boundedNativeTerminalProvider({ ...provider, metadata: { ...metadata, browser: true }, browser: { ...browser, async tree() { return []; }, async evaluate() { return { undefined }; } } }).browser!;
  await expect(malformed.tree()).rejects.toThrow(); await expect(malformed.evaluate({ surface: surface.surfaceRef, script: '1' })).rejects.toThrow();
});
it('bounds native operations and forwards request and activation cancellation', async () => {
  vi.useFakeTimers(); const activation = new AbortController(); let received: AbortSignal | undefined;
  const listTabs = vi.fn(async (signal?: AbortSignal) => { received = signal; return new Promise<never>(() => {}); });
  const bounded = boundedNativeTerminalProvider({ ...provider, listTabs }, activation.signal);
  const timed = expect(bounded.listTabs()).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(30_000); await timed; expect(received?.aborted).toBe(true);
  const request = new AbortController(); const cancelled = expect(bounded.listTabs(request.signal)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(0); request.abort(); await cancelled; expect(received?.aborted).toBe(true);
  activation.abort(); await expect(bounded.listTabs()).rejects.toThrow(); expect(() => bounded.sessionIdentity()).toThrow(); expect(listTabs).toHaveBeenCalledTimes(2);
});
it('gives ordinary and retained providers restricted services and captured settings', async () => {
  const f = await fixture(); writePluginSettings(f.root, f.archive.package, { socket: 'current' });
  const runtime = await activateBackendPlugins({ root: f.root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([['example.terminal', f.archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
  expect(runtime.errors).toEqual([]); expect(runtime.nativeTerminals.list()[0]?.provider.sessionIdentity()).toBe('current');
  const retained = await f.load(); expect(retained.provider.sessionIdentity()).toBe('retained'); await expect(retained.provider.readScreen(surface.surfaceRef, 1)).resolves.toEqual({ ok: true, text: 'retained' });
  await retained.dispose(); await retained.dispose(); await expect(retained.provider.send(surface.surfaceRef, 'hello', true)).rejects.toThrow(); expect(() => retained.provider.sessionIdentity()).toThrow();
  writePluginSettings(f.root, f.archive.package, { socket: 'changed' }); expect(runtime.nativeTerminals.list()).toEqual([]); expect(runtime.nativeTerminals.list('obligation')).toHaveLength(1);
});
it('shares retained module code while keeping concurrent activation settings and disposal independent', async () => {
  const evaluations = '__retainedTerminalEvaluations'; const cleanups = '__retainedTerminalCleanups';
  const sessions: Array<Awaited<ReturnType<typeof loadRetainedNativeTerminalProvider>>> = [];
  try {
    const body = `globalThis.${evaluations} = (globalThis.${evaluations} ?? 0) + 1;\n${source.replace('activate(context) {', `activate(context) { context.onDispose(() => { globalThis.${cleanups} = (globalThis.${cleanups} ?? 0) + 1; });`)}`;
    const f = await fixture(body);
    sessions.push(...await Promise.all(Array.from({ length: 8 }, (_, index) => loadRetainedNativeTerminalProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root,
      record: { ...f.record, settings: { socket: `session-${index}` } }, artifacts: f.artifacts }))));
    expect(Reflect.get(globalThis, evaluations)).toBe(1);
    for (const [index, session] of sessions.entries()) expect(session.provider.sessionIdentity()).toBe(`session-${index}`);
    await sessions[0]!.dispose();
    expect(() => sessions[0]!.provider.sessionIdentity()).toThrow();
    expect(sessions[1]!.provider.sessionIdentity()).toBe('session-1');
    await Promise.all(sessions.map(session => session.dispose()));
    expect(Reflect.get(globalThis, cleanups)).toBe(8);
    for (let index = 0; index < 16; index++) {
      const session = await f.load(); sessions.push(session);
      expect(session.provider.sessionIdentity()).toBe('retained'); await session.dispose();
    }
    expect(Reflect.get(globalThis, evaluations)).toBe(1);
    expect(Reflect.get(globalThis, cleanups)).toBe(24);
  } finally {
    await Promise.all(sessions.map(session => session.dispose()));
    Reflect.deleteProperty(globalThis, evaluations); Reflect.deleteProperty(globalThis, cleanups);
  }
});
it('blocks corrupted, incomplete and mismatched retained artifacts', async () => {
  const f = await fixture();
  await expect(loadRetainedNativeTerminalProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts: [{ ...f.artifacts[0]!, requires: ['example.missing'] }] })).rejects.toThrow('dependency is missing');
  for (const record of [{ ...f.record, metadata: { ...metadata, label: 'Changed' } }, { ...f.record, settings: { socket: 'retained', extra: 'undeclared' } }]) await expect(loadRetainedNativeTerminalProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record, artifacts: f.artifacts })).rejects.toThrow();
  const path = join(f.root, 'artifacts', `${f.archive.hash}.json`); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')])); await expect(f.load()).rejects.toThrow(); await rm(path); await expect(f.load()).rejects.toThrow();
});
it('fences independent selection revisions and disablement without obligation fallback', async () => {
  const root = await temporary(); let available = true;
  const registry = createNativeTerminalProviderRegistry({ eligible: (_binding, purpose) => available || purpose === 'obligation' });
  const registration = registry.stage({ binding: { providerId: 'example.terminal/native', pluginId: 'example.terminal', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider: { ...provider, metadata: { ...metadata, browser: true }, browser }, package: parsePluginPackage(descriptor()), settings: { socket: 'saved' }, origin: 'external' }); registry.publish([registration]);
  const options = { root, registry, defaultProviderId: 'example.terminal/native', kind: 'terminal' as const }; const initial = resolveNativeTerminalSelection(options);
  const browserOptions = { ...options, kind: 'browser' as const }; const initialBrowser = resolveNativeTerminalSelection(browserOptions);
  selectNativeTerminalProvider(root, 'terminal', 'example.terminal/native'); expect(() => assertNativeTerminalSelectionCurrent(options, initial)).toThrow('selection changed'); expect(() => assertNativeTerminalSelectionCurrent(browserOptions, initialBrowser)).not.toThrow();
  selectNativeTerminalProvider(root, 'browser', 'example.terminal/native'); expect(() => assertNativeTerminalSelectionCurrent(browserOptions, initialBrowser)).toThrow('selection changed');
  const selected = resolveNativeTerminalSelection(options); available = false; expect(() => assertNativeTerminalSelectionCurrent(options, selected)).toThrow();
  expect(registry.resolve(registration.record.binding, 'obligation')).toBe(registration); expect(() => registry.resolve({ ...registration.record.binding, artifactHash: 'b'.repeat(64) }, 'obligation')).toThrow();
  selectNativeTerminalProvider(root, 'terminal', 'example.missing/native'); expect(() => resolveNativeTerminalSelection(options)).toThrow('unavailable');
});
it('requires the selected browser provider to offer browser primitives', async () => {
  const root = await temporary(); const registry = createNativeTerminalProviderRegistry({ eligible: () => true });
  registry.publish([registry.stage({ binding: { providerId: 'example.terminal/native', pluginId: 'example.terminal', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: parsePluginPackage(descriptor()), settings: { socket: 'saved' }, origin: 'external' })]);
  expect(() => resolveNativeTerminalSelection({ root, registry, defaultProviderId: 'example.terminal/native', kind: 'browser' })).toThrow('does not support browser');
});
it('migrates separate selections and settings once while preserving explicit choices and resets', async () => {
  const root = await temporary(); const pkg = parsePluginPackage(descriptor()); expect(nativeTerminalProviderSelectionInitialized(root, 'terminal')).toBe(false);
  expect(() => initializeNativeTerminalProviderSelection(root, 'terminal', 'invalid')).toThrow(); expect(nativeTerminalProviderSelectionInitialized(root, 'terminal')).toBe(false);
  await pluginCommand(['--dir', root, 'select-native-terminal', 'example.explicit/native'], { coordinate: false });
  await pluginCommand(['--dir', root, 'select-browser-host', 'example.browser/native'], { coordinate: false });
  expect(nativeTerminalProviderSelectionInitialized(root, 'terminal')).toBe(true); initializeNativeTerminalProviderSelection(root, 'terminal', 'invalid stale value'); expect(readNativeTerminalProviderSelection(root, 'terminal').providerId).toBe('example.explicit/native'); expect(readNativeTerminalProviderSelection(root, 'browser').providerId).toBe('example.browser/native');
  await pluginCommand(['--dir', root, 'select-native-terminal', 'default'], { coordinate: false }); initializeNativeTerminalProviderSelection(root, 'terminal', 'example.legacy/native'); expect(readNativeTerminalProviderSelection(root, 'terminal').providerId).toBeNull();
  expect(() => initializeNativeTerminalSettings(root, pkg, { credential: 'unknown' })).toThrow('Unknown');
  writePluginSettings(root, pkg, { socket: 'explicit' }); initializeNativeTerminalSettings(root, pkg, { socket: 'legacy' }); expect(readPluginSettings(root, pkg).socket).toBe('explicit');
  clearPluginSettings(root, pkg.manifest.id); initializeNativeTerminalSettings(root, pkg, { socket: 'later' }); expect(readPluginSettings(root, pkg).socket).toBe('original');
  expect(() => initializeNativeTerminalSettings(root, pkg, { socket: 123, credential: 'stale invalid value' })).not.toThrow(); expect(readPluginSettings(root, pkg).socket).toBe('original');
});
it('loads builtin providers from verified retained runtime bytes after source deletion', async () => {
  const root = await temporary(); const original = join(root, 'original'); const runtimeArtifactsRoot = join(root, 'retained');
  await mkdir(join(original, 'server', 'helmsman', 'plugins'), { recursive: true });
  await writeFile(join(original, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', type: 'module' }));
  await writeFile(join(original, 'server', 'helmsman', 'main.js'), 'export {};'); const pkg = descriptor('helmsman.original-terminal');
  const catalog = `const plugin = ${source.replace('export default ', '').replace(/;$/, '')}; export const builtinNativeTerminals = [{ package: ${JSON.stringify(pkg)}, module: plugin }];`;
  await writeFile(join(original, 'server', 'helmsman', 'plugins', 'builtin-terminals.js'), catalog);
  const retained = await retainLegacyRuntime(original, runtimeArtifactsRoot); await rm(original, { recursive: true });
  const record = parseNativeTerminalRetainedProviderV1({ version: 1, binding: { providerId: 'helmsman.original-terminal/native', pluginId: 'helmsman.original-terminal', artifactHash: retained.artifact.artifactHash, contractVersion: 1 }, origin: 'builtin', settings: { socket: 'saved' }, metadata });
  const artifacts = [retained.artifact, { pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [retained.artifact.pluginId] }];
  const loaded = await loadRetainedNativeTerminalProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts }); expect(loaded.provider.sessionIdentity()).toBe('saved'); await loaded.dispose();
  await writeFile(join(retained.root, 'server', 'helmsman', 'plugins', 'builtin-terminals.js'), `${catalog}\n `);
  await expect(loadRetainedNativeTerminalProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts })).rejects.toThrow('unavailable');
});
