// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExecutionHostLaunchSpecV1, parseExecutionHostStageInputV1, type ExecutionHostLaunchSpecV1, type ExecutionHostMetadataV1, type ExecutionHostProviderV1, type ExecutionHostStagePathsV1 } from '../../src/plugins/execution-host';
import { parsePluginPackage } from '../../src/plugins/package';
import { boundedExecutionHostProvider, createExecutionHostProviderRegistry, parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { loadRetainedExecutionHostProvider } from './execution-host-retained-loader';
import { assertExecutionHostSelectionCurrent, resolveExecutionHostSelection } from './execution-host-selection';
import { retainLegacyRuntime } from './legacy-runtime-artifact';
import { installPluginArtifact } from './plugins/artifacts';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { clearPluginSettings, executionHostProviderSelectionInitialized, initializeExecutionHostProviderSelection, initializeExecutionHostSettings, readExecutionHostProviderSelection, readPluginSettings, selectExecutionHostProvider, writePluginSettings } from './plugins/data';
import { pluginCommand } from './plugins/cli';

const metadata: ExecutionHostMetadataV1 = { version: 1, label: 'Example host', workspace: 'worktree', stageExecution: 'local' };
const prepareInput = { version: 1 as const, runId: 'run-1', repo: 'owner/project', mode: 'coding' as const };
const identity = { runId: 'run-1', launchId: 'launch-1', attempt: 1, receiptPath: '/tmp/receipt.json' };
const spec: ExecutionHostLaunchSpecV1 = { version: 1, ...identity, cmd: 'node', args: ['worker.js'], cwd: '/tmp/work', logPath: '/tmp/log', exitPath: '/tmp/exit', specPath: '/tmp/spec', wrapperPath: '/tmp/wrapper.mjs', coordinator: false, configuration: null };
const reference = { version: 1 as const, identity, state: { pid: 123 } };
const provider: ExecutionHostProviderV1 = { metadata, async prepareRun() { return null; }, async launch() { return reference; }, async discover() { return { status: 'found', ref: reference, evidence: { ...identity, state: 'running' } }; }, async isAlive() { return true; }, async stop() {} };
function descriptor(id = 'example.host') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/execution-host', version: 1, localId: 'host' }], executionHosts: { host: { access: ['execution'] } }, storageVersion: 1,
      settings: { image: { type: 'string', default: 'original', maxLength: 4096 } } } };
}
const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(value => value.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-hosts-')); roots.push(root); return root; }
const source = `export default { activate(context) {
 if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerExecutionHost,settings,signal') throw new Error('Unexpected host services');
 context.registerExecutionHost('host', { metadata: ${JSON.stringify(metadata)}, async prepareRun() { return { image: context.settings.image }; },
 async launch(spec) { return { version: 1, identity: {runId:spec.runId,launchId:spec.launchId,attempt:spec.attempt,receiptPath:spec.receiptPath}, state: {image:context.settings.image} }; },
 async discover() { return {status:'unknown',reason:'Native evidence unavailable'}; }, async isAlive() { throw new Error('Unknown ownership'); }, async stop() { throw new Error('Unknown ownership'); } });
} };`;
async function fixture(body = source, pkg = descriptor()) {
  const root = await temporary();
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: pkg, files: [{ path: 'backend.js', base64: Buffer.from(body).toString('base64') }] })));
  const record = parseExecutionHostRetainedProviderV1({ version: 1, binding: { providerId: 'example.host/host', pluginId: 'example.host', artifactHash: archive.hash, contractVersion: 1 }, origin: 'external', settings: { image: 'retained' }, metadata });
  const artifacts = [{ pluginId: 'example.host', artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }];
  return { root, archive, record, artifacts, load: () => loadRetainedExecutionHostProvider({ pluginsRoot: root, runtimeArtifactsRoot: join(root, 'legacy'), record, artifacts }) };
}
it('checks the entire retained closure before evaluating the selected compatible provider', async () => {
  const marker = '__retainedClosureexecution_host';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    const f = await fixture(`globalThis.${marker} = true; export default { activate() {} };`);
    const dependency = await installPluginArtifact(f.root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
      package: { ...f.archive.package, manifest: { ...f.archive.package.manifest, id: 'example.incompatible' }, node: { minMajor: major + 1, maxMajorExclusive: major + 2 } },
      files: [...f.archive.files].map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') })),
    })));
    const artifacts = [{ ...f.artifacts[0]!, requires: ['example.incompatible'] },
      { pluginId: 'example.incompatible', artifactHash: dependency.hash, packageVersion: '1.0.0', requires: [] }];
    await expect(loadRetainedExecutionHostProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts })).rejects.toThrow('does not support Node');
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('blocks retained external code outside its Node range before top-level evaluation', async () => {
  const marker = '__retainedCompatibilityexecution_host';
  const major = Number(process.versions.node.split('.')[0]);
  try {
    for (const node of [{ minMajor: major - 1, maxMajorExclusive: major }, { minMajor: major + 1, maxMajorExclusive: major + 2 }]) {
      const f = await fixture(`globalThis.${marker} = true;\n${source}`, { ...descriptor(), node });
      await expect(f.load()).rejects.toThrow('does not support Node');
      expect(Reflect.get(globalThis, marker)).toBeUndefined();
    }
  } finally { Reflect.deleteProperty(globalThis, marker); }
});
it('requires explicit launch identity, bounded JSON and exactly declared host-only capabilities', async () => {
  for (const invalid of [{ ...spec, launchId: '' }, { ...spec, receiptPath: 'relative' }, { ...spec, attempt: 0 }, { ...spec, args: ['bad\0arg'] }, { ...spec, configuration: { image: 'x'.repeat(65536) } }]) expect(() => parseExecutionHostLaunchSpecV1(invalid)).toThrow();
  const pkg = descriptor();
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, provides: [...pkg.backend.provides, { id: 'helmsman/pricing', version: 1, localId: 'price' }] } })).toThrow('host-only');
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, executionHosts: { host: { access: ['storage'] } } } })).toThrow();
  const bounded = boundedExecutionHostProvider({ ...provider, async launch() { return { ...reference, identity: { ...identity, runId: 'other' } }; } });
  await expect(bounded.launch(spec)).rejects.toThrow('different launch identity');
  await expect(boundedExecutionHostProvider({ ...provider, async prepareRun() { return { secret: undefined } as never; } }).prepareRun(prepareInput)).rejects.toThrow();
});
it('preserves unknown discovery and rejects contradictory evidence or ambiguous liveness', async () => {
  const unknown = boundedExecutionHostProvider({ ...provider, async discover() { return { status: 'unknown', reason: 'Unavailable receipt' }; }, async isAlive() { throw new Error('Unknown ownership'); } });
  await expect(unknown.discover(spec)).resolves.toEqual({ status: 'unknown', reason: 'Unavailable receipt' }); await expect(unknown.isAlive(reference)).rejects.toThrow('Unknown ownership');
  await expect(boundedExecutionHostProvider({ ...provider, async isAlive() { return undefined as never; } }).isAlive(reference)).rejects.toThrow('explicit');
  await expect(boundedExecutionHostProvider({ ...provider, async discover() { return { status: 'found', ref: reference, evidence: { runId: 'other', launchId: identity.launchId, attempt: 1, state: 'running' } }; } }).discover(spec)).rejects.toThrow();
  const stop = vi.fn(async () => {}); const wrapped = boundedExecutionHostProvider({ ...provider, stop });
  await expect(wrapped.stop({ ...reference, identity: { ...identity, receiptPath: '' } })).rejects.toThrow(); expect(stop).not.toHaveBeenCalled();
});
it('bounds and cancels async operations while preserving stop cleanup after cancellation', async () => {
  vi.useFakeTimers(); const stop = vi.fn(async () => {}); const signal = new AbortController();
  const bounded = boundedExecutionHostProvider({ ...provider, stop, async prepareRun() { return new Promise(() => {}); } }, signal.signal);
  const timed = expect(bounded.prepareRun(prepareInput)).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(30_000); await timed;
  const cancelled = expect(bounded.prepareRun(prepareInput)).rejects.toThrow(); signal.abort(); await cancelled;
  await bounded.stop(reference); expect(stop).toHaveBeenCalledOnce();
});
it('validates isolated stage input, mapped paths and returned commands', async () => {
  const stagePaths: ExecutionHostStagePathsV1 = { skillsPath: null, reportPath: '/tmp/report', priorReportPath: null, reviewOutputPaths: null, clarification: null };
  const stageInput = { version: 1 as const, runId: 'run-1', repo: 'owner/project', cwd: '/tmp/work', runtimeRoot: '/tmp/runtime', gateway: { url: 'http://127.0.0.1:1234', capability: 'ephemeral' }, configuration: null, transport: 'openai-responses' as const, stage: 'review' as const, ...stagePaths };
  expect(() => parseExecutionHostStageInputV1({ ...stageInput, transport: 'unknown' })).toThrow();
  expect(() => boundedExecutionHostProvider({ ...provider, metadata: { ...metadata, stageExecution: 'isolated' } })).toThrow('require stage');
  const stop = vi.fn(async () => {}); const cleanup = vi.fn(async (_success: boolean) => {}); const render = vi.fn(() => ({ cmd: 'node', args: [] }));
  const isolated = boundedExecutionHostProvider({ ...provider, metadata: { ...metadata, stageExecution: 'isolated' }, async stopStages() {}, async prepareStage(_input, command) { return { command: command(stagePaths), stop, cleanup }; } });
  const stage = await isolated.prepareStage!(stageInput, render); expect(stage.command.cmd).toBe('node'); await stage.stop(); await stage.cleanup(false); expect(cleanup).toHaveBeenCalledWith(false);
  await expect(isolated.prepareStage!(stageInput, () => ({ cmd: '', args: [] }))).rejects.toThrow();
  const invalid = boundedExecutionHostProvider({ ...provider, async prepareStage(_input, command) { return { command: command({ ...stagePaths, reportPath: 'relative' }), stop, cleanup }; } });
  render.mockClear(); await expect(invalid.prepareStage!(stageInput, render)).rejects.toThrow(); expect(render).not.toHaveBeenCalled();
  cleanup.mockClear(); stop.mockClear();
  const invalidResult = boundedExecutionHostProvider({ ...provider, async prepareStage() { return { command: { cmd: '', args: [] }, stop, cleanup }; } });
  await expect(invalidResult.prepareStage!(stageInput, render)).rejects.toThrow(); expect(stop).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledWith(false);
  vi.useFakeTimers(); cleanup.mockClear(); stop.mockClear();
  let resolveStage!: (value: { command: { cmd: string; args: string[] }; stop: typeof stop; cleanup: typeof cleanup }) => void;
  const late = boundedExecutionHostProvider({ ...provider, async prepareStage() { return new Promise(resolve => { resolveStage = resolve; }); } });
  const timed = expect(late.prepareStage!(stageInput, render)).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(30_000); await timed;
  resolveStage({ command: { cmd: 'node', args: [] }, stop, cleanup }); await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledWith(false);
});
it('gives ordinary and retained hosts the same restricted services with original captured settings', async () => {
  const f = await fixture(); writePluginSettings(f.root, f.archive.package, { image: 'current' });
  const runtime = await activateBackendPlugins({ root: f.root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([['example.host', f.archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
  expect(runtime.errors).toEqual([]); await expect(runtime.executionHosts.list()[0]?.provider.prepareRun(prepareInput)).resolves.toEqual({ image: 'current' });
  const retained = await f.load(); await expect(retained.provider.prepareRun(prepareInput)).resolves.toEqual({ image: 'retained' }); await expect(retained.provider.launch(spec)).resolves.toMatchObject({ state: { image: 'retained' } });
  await expect(retained.provider.stop(reference)).rejects.toThrow('Unknown ownership');
  await retained.dispose(); await retained.dispose(); await expect(retained.provider.launch(spec)).rejects.toThrow();
  writePluginSettings(f.root, f.archive.package, { image: 'changed' }); expect(runtime.executionHosts.list()).toEqual([]);
});
it('rejects corrupted, incomplete or mismatched retained artifacts before any launch', async () => {
  const f = await fixture();
  await expect(loadRetainedExecutionHostProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts: [{ ...f.artifacts[0]!, requires: ['example.missing'] }] })).rejects.toThrow('dependency is missing');
  for (const record of [{ ...f.record, metadata: { ...metadata, workspace: 'clone' as const } }, { ...f.record, settings: { image: 'retained', extra: 'undeclared' } }]) await expect(loadRetainedExecutionHostProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record, artifacts: f.artifacts })).rejects.toThrow();
  const path = join(f.root, 'artifacts', `${f.archive.hash}.json`); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')])); await expect(f.load()).rejects.toThrow(); await rm(path); await expect(f.load()).rejects.toThrow();
});
it('fences selected revisions and disablement without changing retained obligation identity', async () => {
  const root = await temporary(); let available = true;
  const registry = createExecutionHostProviderRegistry({ eligible: (_binding, purpose) => available || purpose === 'obligation' });
  const registration = registry.stage({ binding: { providerId: 'example.host/host', pluginId: 'example.host', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: parsePluginPackage(descriptor()), settings: { image: 'saved' }, origin: 'external' }); registry.publish([registration]);
  const options = { root, registry, defaultProviderId: 'example.host/host' }; const initial = resolveExecutionHostSelection(options);
  selectExecutionHostProvider(root, 'example.host/host'); expect(() => assertExecutionHostSelectionCurrent(options, initial)).toThrow('selection changed');
  const selected = resolveExecutionHostSelection(options); available = false; expect(() => assertExecutionHostSelectionCurrent(options, selected)).toThrow();
  expect(registry.resolve(registration.record.binding, 'obligation')).toBe(registration);
  expect(() => registry.resolve({ ...registration.record.binding, artifactHash: 'b'.repeat(64) }, 'obligation')).toThrow();
  selectExecutionHostProvider(root, 'example.missing/host'); expect(() => resolveExecutionHostSelection(options)).toThrow('unavailable');
});
it('migrates host selections and nonsecret settings once without replacing explicit choices or resets', async () => {
  const root = await temporary(); const pkg = parsePluginPackage(descriptor()); expect(executionHostProviderSelectionInitialized(root)).toBe(false);
  await pluginCommand(['--dir', root, 'select-execution-host', 'example.explicit/host'], { coordinate: false });
  expect(executionHostProviderSelectionInitialized(root)).toBe(true); initializeExecutionHostProviderSelection(root, 'example.legacy/host'); expect(readExecutionHostProviderSelection(root).providerId).toBe('example.explicit/host');
  selectExecutionHostProvider(root, null); initializeExecutionHostProviderSelection(root, 'example.legacy/host'); expect(readExecutionHostProviderSelection(root).providerId).toBeNull();
  expect(() => initializeExecutionHostSettings(root, pkg, { credential: 'unknown' })).toThrow('Unknown');
  writePluginSettings(root, pkg, { image: 'explicit' }); initializeExecutionHostSettings(root, pkg, { image: 'legacy' }); expect(readPluginSettings(root, pkg).image).toBe('explicit');
  clearPluginSettings(root, pkg.manifest.id); initializeExecutionHostSettings(root, pkg, { image: 'later' }); expect(readPluginSettings(root, pkg).image).toBe('original');
  expect(() => initializeExecutionHostSettings(root, pkg, { image: 123, credential: 'stale invalid value' })).not.toThrow();
  expect(readPluginSettings(root, pkg).image).toBe('original');
});
it('loads builtin hosts from verified original runtime bytes with the source removed', async () => {
  const root = await temporary(); const original = join(root, 'original'); const runtimeArtifactsRoot = join(root, 'retained');
  await mkdir(join(original, 'server', 'helmsman', 'plugins'), { recursive: true });
  await writeFile(join(original, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', type: 'module' }));
  await writeFile(join(original, 'server', 'helmsman', 'main.js'), 'export {};'); const pkg = descriptor('helmsman.original-host');
  const catalog = `const plugin = ${source.replace('export default ', '').replace(/;$/, '')}; export const builtinExecutionHosts = [{ package: ${JSON.stringify(pkg)}, module: plugin }];`;
  await writeFile(join(original, 'server', 'helmsman', 'plugins', 'builtin-hosts.js'), catalog);
  const retained = await retainLegacyRuntime(original, runtimeArtifactsRoot); await rm(original, { recursive: true });
  const record = parseExecutionHostRetainedProviderV1({ version: 1, binding: { providerId: 'helmsman.original-host/host', pluginId: 'helmsman.original-host', artifactHash: retained.artifact.artifactHash, contractVersion: 1 }, origin: 'builtin', settings: { image: 'saved' }, metadata });
  const artifacts = [retained.artifact, { pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [retained.artifact.pluginId] }];
  const loaded = await loadRetainedExecutionHostProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts });
  await expect(loaded.provider.prepareRun(prepareInput)).resolves.toEqual({ image: 'saved' }); await loaded.dispose();
  await writeFile(join(retained.root, 'server', 'helmsman', 'plugins', 'builtin-hosts.js'), `${catalog}\n `);
  await expect(loadRetainedExecutionHostProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts })).rejects.toThrow('unavailable');
});
