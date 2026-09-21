// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentCommandV1, parseAgentEventV1, parseAgentProviderMetadataV1, type AgentProviderMetadataV1, type AgentProviderV1 } from '../../src/plugins/agent-provider';
import { parsePluginPackage } from '../../src/plugins/package';
import { boundedAgentProvider, createAgentProviderRegistry, parseAgentRetainedProviderV1, parseAgentSelectionV1 } from './agent-providers';
import { loadRetainedAgentProvider } from './agent-retained-loader';
import { retainLegacyRuntime } from './legacy-runtime-artifact';
import { assertAgentSelectionCurrent, resolveAgentSelection } from './agent-selection';
import { installPluginArtifact } from './plugins/artifacts';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { clearPluginSettings, initializeAgentProviderSelection, initializeCommandAgentSettings, readAgentProviderSelection, readPluginSettings, selectAgentProvider, selectAgentReviewers, writePluginSettings } from './plugins/data';
import { pluginCommand } from './plugins/cli';

const models = { model: null, effort: null };
const metadata: AgentProviderMetadataV1 = { version: 1, label: 'Example', defaults: models, review: { low: models, medium: models, high: models }, reviewSkills: [], reviewDelegation: 'none', supportsPrePr: true, docker: null, costReporting: 'delta' };
const input = { version: 1 as const, prompt: 'Rendered workflow prompt', model: null, effort: null, stage: 'direct' as const, summaryCorrection: false, task: { ticketId: 'T-1', repo: 'owner/project', title: 'Task' } };
const provider: AgentProviderV1 = { metadata, buildCommand: () => ({ cmd: 'echo', args: [] }), parseLine: () => null };
function descriptor(id = 'example.agent') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'agent' }], agents: { agent: { access: ['process-description'] } }, storageVersion: 1,
      settings: { commandTemplate: { type: 'string', default: 'original', maxLength: 4096 } } } };
}
const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(value => value.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-agents-')); roots.push(root); return root; }
async function fixture(body?: string) {
  const root = await temporary();
  const source = body ?? `export default { activate(context) {
    if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerAgent,settings,signal') throw new Error('Unexpected host services');
    context.registerAgent('agent', { metadata: ${JSON.stringify(metadata)}, buildCommand(input) { return { cmd: 'echo', args: [context.settings.commandTemplate, input.prompt] }; },
      parseLine(line) { return { kind: 'result', text: line, outcome: line === 'fail' ? 'failure' : 'success' }; } });
  } };`;
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor(), files: [{ path: 'backend.js', base64: Buffer.from(source).toString('base64') }] })));
  const record = parseAgentRetainedProviderV1({ version: 1, binding: { providerId: 'example.agent/agent', pluginId: 'example.agent', artifactHash: archive.hash, contractVersion: 1 }, origin: 'external', settings: { commandTemplate: 'retained' }, metadata });
  const artifacts = [{ pluginId: 'example.agent', artifactHash: archive.hash, packageVersion: '1.0.0', requires: [] }];
  return { root, archive, record, artifacts, load: () => loadRetainedAgentProvider({ pluginsRoot: root, runtimeArtifactsRoot: join(root, 'legacy'), record, artifacts }) };
}
it('bounds commands, rejects core completion events, and preserves explicit unsuccessful results', () => {
  expect(parseAgentEventV1({ kind: 'result', text: 'not successful', outcome: 'failure' })).toMatchObject({ outcome: 'failure' });
  for (const value of [{ kind: 'result', text: 'done' }, { kind: 'run-complete', text: 'done' }, { kind: 'usage', text: '', usage: { inputTokens: -1 } }, { kind: 'log', text: '', costUsd: Infinity }]) expect(() => parseAgentEventV1(value)).toThrow();
  for (const value of [{ cmd: '', args: [] }, { cmd: 'echo', args: ['bad\0argument'] }, { cmd: 'echo', args: Array(257).fill('arg') }]) expect(() => parseAgentCommandV1(value)).toThrow();
  expect(() => parseAgentProviderMetadataV1({ ...metadata, docker: 'unknown-provider' })).toThrow();
  const parse = vi.fn(() => null); const bounded = boundedAgentProvider({ ...provider, parseLine: parse });
  expect(() => bounded.parseLine('x'.repeat(1024 * 1024 + 1))).toThrow(); expect(parse).not.toHaveBeenCalled();
});
it('requires agent-only backend capabilities and exact process-description access', () => {
  const pkg = descriptor();
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, provides: [...pkg.backend.provides, { id: 'helmsman/pricing', version: 1, localId: 'price' }] } })).toThrow('agent-only');
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, agents: { agent: { access: ['storage'] } } } })).toThrow();
});
it('uses the same restricted context in ordinary and retained activation with exact saved settings', async () => {
  const f = await fixture(); writePluginSettings(f.root, f.archive.package, { commandTemplate: 'current' });
  const runtime = await activateBackendPlugins({ root: f.root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([['example.agent', f.archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
  expect(runtime.errors).toEqual([]); expect(runtime.agents.list()[0]?.provider.buildCommand(input).args[0]).toBe('current');
  const retained = await f.load();
  expect(retained.provider.buildCommand(input)).toEqual({ cmd: 'echo', args: ['retained', input.prompt] });
  expect(retained.provider.parseLine('fail')).toMatchObject({ kind: 'result', outcome: 'failure' });
  await retained.dispose(); await retained.dispose(); expect(() => retained.provider.buildCommand(input)).toThrow();
  writePluginSettings(f.root, f.archive.package, { commandTemplate: 'changed' }); expect(runtime.agents.list()).toEqual([]);
});
it('rejects missing and modified retained artifacts and incomplete dependency closures', async () => {
  const f = await fixture();
  await expect(loadRetainedAgentProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts: [{ ...f.artifacts[0]!, requires: ['example.missing'] }] })).rejects.toThrow('dependency is missing');
  const path = join(f.root, 'artifacts', `${f.archive.hash}.json`); const bytes = await readFile(path); await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
  await expect(f.load()).rejects.toThrow(); await rm(path); await expect(f.load()).rejects.toThrow();
});
it('rejects changed metadata and undeclared retained settings before a provider can run', async () => {
  const f = await fixture();
  expect(() => parseAgentSelectionV1({ version: 1, writer: f.record, reviewers: [{ ...f.record, settings: { commandTemplate: 'conflicting' } }] })).toThrow('Conflicting');
  expect(() => parseAgentSelectionV1({ version: 1, writer: f.record, reviewers: [{ ...f.record, binding: { ...f.record.binding, artifactHash: 'f'.repeat(64) } }] })).toThrow('Conflicting');
  for (const record of [{ ...f.record, metadata: { ...metadata, docker: 'openai-responses' as const } }, { ...f.record, settings: { commandTemplate: 'retained', extra: 'undeclared' } }]) {
    await expect(loadRetainedAgentProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record, artifacts: f.artifacts })).rejects.toThrow();
  }
});
it('cancels module loading that never completes without requiring a live parent', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; }); globals.helmsmanAgentImportTest = began;
  try {
    const f = await fixture('globalThis.helmsmanAgentImportTest(); await new Promise(() => {}); export default {};'); const controller = new AbortController();
    const pending = loadRetainedAgentProvider({ pluginsRoot: f.root, runtimeArtifactsRoot: f.root, record: f.record, artifacts: f.artifacts, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(); await started; controller.abort(); await rejected;
  } finally { delete globals.helmsmanAgentImportTest; }
});
it('captures ordered selections and rejects disabled providers, settings changes and selection revisions at admission', async () => {
  const root = await temporary(); let available = true;
  const registry = createAgentProviderRegistry({ eligible: (_binding, purpose) => available || purpose === 'obligation' });
  const registrations = ['first', 'second'].map(name => registry.stage({ binding: { providerId: `example.${name}/agent`, pluginId: `example.${name}`, artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: parsePluginPackage(descriptor(`example.${name}`)), settings: { commandTemplate: 'saved' }, origin: 'external' })); registry.publish(registrations);
  const options = { root, registry, reviewerCount: 2, defaults: { writer: 'example.first/agent', reviewers: ['example.first/agent', 'example.second/agent'] } };
  initializeAgentProviderSelection(root, options.defaults); const initial = resolveAgentSelection(options);
  expect(initial.selection.reviewers.map(value => value.binding.providerId)).toEqual(options.defaults.reviewers);
  selectAgentReviewers(root, ['example.second/agent', 'example.first/agent']);
  expect(() => assertAgentSelectionCurrent(options, initial)).toThrow('selection changed');
  expect(resolveAgentSelection(options).selection.reviewers[0]?.binding.providerId).toBe('example.second/agent');
  expect(() => resolveAgentSelection({ ...options, reviewerCount: 1 })).toThrow('must include the writer');
  expect(resolveAgentSelection({ ...options, reviewerCount: 1, writer: 'example.second/agent' }).selection.writer.binding.providerId).toBe('example.second/agent');
  const selected = resolveAgentSelection(options); available = false; expect(() => assertAgentSelectionCurrent(options, selected)).toThrow();
  expect(registry.resolve(registrations[0]!.record.binding, 'obligation')).toBe(registrations[0]);
  expect(() => registry.resolve({ ...registrations[0]!.record.binding, artifactHash: 'b'.repeat(64) }, 'obligation')).toThrow();
});
it('keeps legacy command contents private and migrates writer once while preserving explicit selections', async () => {
  const root = await temporary(); const pkg = parsePluginPackage(descriptor());
  expect(initializeCommandAgentSettings(root, pkg, 'legacy-secret')).toBe(true); expect(readPluginSettings(root, pkg).commandTemplate).toBe('original');
  writePluginSettings(root, pkg, { commandTemplate: 'explicit nonsecret command' }); expect(initializeCommandAgentSettings(root, pkg, 'legacy-secret')).toBe(false);
  expect(readPluginSettings(root, pkg).commandTemplate).toBe('explicit nonsecret command');
  clearPluginSettings(root, pkg.manifest.id, 'commandTemplate'); initializeCommandAgentSettings(root, pkg, 'other'); expect(readPluginSettings(root, pkg).commandTemplate).toBe('original');
  await pluginCommand(['--dir', root, 'select-agent', 'example.explicit/agent'], { coordinate: false });
  initializeAgentProviderSelection(root, { writer: 'example.legacy/agent', reviewers: [] }); expect(readAgentProviderSelection(root).writer).toBe('example.explicit/agent');
  selectAgentProvider(root, null); initializeAgentProviderSelection(root, { writer: 'example.legacy/agent', reviewers: [] }); expect(readAgentProviderSelection(root).writer).toBeNull();
});

it('loads builtin providers only from verified original runtime bytes with current source removed', async () => {
  const root = await temporary(); const source = join(root, 'source'); const runtimeArtifactsRoot = join(root, 'retained');
  await mkdir(join(source, 'server', 'helmsman', 'plugins'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', type: 'module' }));
  await writeFile(join(source, 'server', 'helmsman', 'main.js'), 'export {};');
  const pkg = descriptor('helmsman.original-agent');
  const catalog = `export const builtinAgents = [{ package: ${JSON.stringify(pkg)}, module: { activate(context) { context.registerAgent('agent', { metadata: ${JSON.stringify(metadata)}, buildCommand() { return { cmd: 'original-agent', args: [context.settings.commandTemplate] }; }, parseLine() { return null; } }); } } }];`;
  await writeFile(join(source, 'server', 'helmsman', 'plugins', 'builtin-agents.js'), catalog);
  const retained = await retainLegacyRuntime(source, runtimeArtifactsRoot); await rm(source, { recursive: true });
  const record = parseAgentRetainedProviderV1({ version: 1, binding: { providerId: 'helmsman.original-agent/agent', pluginId: 'helmsman.original-agent', artifactHash: retained.artifact.artifactHash, contractVersion: 1 }, origin: 'builtin', settings: { commandTemplate: 'saved' }, metadata });
  const artifacts = [retained.artifact, { pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [retained.artifact.pluginId] }];
  const loaded = await loadRetainedAgentProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts });
  expect(loaded.provider.buildCommand(input)).toEqual({ cmd: 'original-agent', args: ['saved'] }); await loaded.dispose();
  await writeFile(join(retained.root, 'server', 'helmsman', 'plugins', 'builtin-agents.js'), catalog.replace('original-agent', 'changed-agent'));
  await expect(loadRetainedAgentProvider({ pluginsRoot: root, runtimeArtifactsRoot, record, artifacts })).rejects.toThrow('unavailable');
});
