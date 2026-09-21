import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import type { AgentBackendContextV1, AgentProviderV1 } from '../../src/plugins/agent-provider';
import { isPluginId } from '../../src/plugins/manifest';
import { parsePluginPackage, validatePluginSetting, type PluginPackage } from '../../src/plugins/package';
import { boundedAgentProvider, parseAgentRetainedProviderV1, type AgentRetainedProviderV1 } from './agent-providers';
import type { ArtifactBinding } from './execution-store';
import { verifyLegacyRuntime, type RetainedLegacyRuntime } from './legacy-runtime-artifact';
import { persistenceHash } from './persistence';
import { readPluginArtifact, type PluginArchive } from './plugins/artifacts';
import { validatePluginImports } from './plugins/imports';
import { materializePluginBackend } from './plugins/materialize';
import { assertPluginNodeCompatibility } from './plugins/compatibility';

async function verifyClosure(input: { pluginsRoot: string; runtimeArtifactsRoot: string; artifacts: readonly ArtifactBinding[] }, record: AgentRetainedProviderV1) {
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 256) throw new Error('Retained agent artifact closure is invalid');
  const artifacts = new Map<string, ArtifactBinding>(); const archives = new Map<string, PluginArchive>(); const runtimes = new Map<string, RetainedLegacyRuntime>();
  for (const item of input.artifacts) {
    if (!item || !isPluginId(item.pluginId) || typeof item.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(item.artifactHash)
      || typeof item.packageVersion !== 'string' || !item.packageVersion || !Array.isArray(item.requires) || item.requires.length > 256
      || item.requires.some((id: unknown) => !isPluginId(id)) || new Set(item.requires).size !== item.requires.length || artifacts.has(item.pluginId)) throw new Error('Retained agent artifact closure is invalid');
    artifacts.set(item.pluginId, item);
  }
  const selected = artifacts.get(record.binding.pluginId);
  if (selected?.artifactHash !== record.binding.artifactHash) throw new Error('Agent provider is not in the retained artifact closure');
  const visited = new Set<string>(); const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error('Retained agent dependencies contain a cycle');
    if (visited.has(id)) return;
    const artifact = artifacts.get(id); if (!artifact) throw new Error('Retained agent dependency is missing');
    active.add(id); for (const required of artifact.requires) visit(required); active.delete(id); visited.add(id);
  }
  for (const id of artifacts.keys()) visit(id);
  for (const artifact of artifacts.values()) {
    if (artifact.pluginId.startsWith('helmsman.')) {
      let runtime = runtimes.get(artifact.artifactHash);
      if (!runtime) { runtime = await verifyLegacyRuntime(input.runtimeArtifactsRoot, artifact.artifactHash) ?? undefined; if (!runtime) throw new Error('Exact retained agent runtime is unavailable'); runtimes.set(artifact.artifactHash, runtime); }
      if (artifact.pluginId !== runtime.artifact.pluginId && (!artifact.requires.includes(runtime.artifact.pluginId)
        || artifacts.get(runtime.artifact.pluginId)?.artifactHash !== artifact.artifactHash)) throw new Error('Builtin agent requires its original retained runtime');
    } else {
      const archive = await readPluginArtifact(input.pluginsRoot, artifact.artifactHash);
      if (archive.package.manifest.id !== artifact.pluginId || archive.package.manifest.version !== artifact.packageVersion) throw new Error('Retained agent artifact identity differs');
      assertPluginNodeCompatibility(archive.package);
      await validatePluginImports(archive); archives.set(artifact.pluginId, archive);
    }
  }
  return { artifacts, archives, runtimes };
}

export async function loadRetainedAgentProvider(input: {
  pluginsRoot: string; runtimeArtifactsRoot: string; record: AgentRetainedProviderV1; artifacts: readonly ArtifactBinding[]; signal?: AbortSignal;
}): Promise<{ provider: AgentProviderV1; dispose(): Promise<void> }> {
  const record = parseAgentRetainedProviderV1(input.record);
  input.signal?.throwIfAborted(); const closure = await verifyClosure(input, record); input.signal?.throwIfAborted();
  let remove: (() => Promise<void>) | undefined; let pkg: PluginPackage; let imported: unknown;
  const cleanups: Array<() => void | Promise<void>> = []; const controller = new AbortController(); let disposed = false;
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  async function dispose(): Promise<void> {
    if (disposed) return; disposed = true; controller.abort();
    for (const cleanup of cleanups.reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(cleanup), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Agent cleanup timed out')), 1000); })]); } catch {} finally { clearTimeout(timer); }
    }
    await remove?.();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(new Error('Retained agent activation timed out')), 10_000);
    if (record.origin === 'builtin') {
      const runtime = closure.runtimes.get(record.binding.artifactHash);
      if (!runtime) throw new Error('Builtin agent runtime is unavailable');
      const catalog: unknown = await clarificationAbortable(import(pathToFileURL(join(runtime.root, 'server', 'helmsman', 'plugins', `builtin-agents.${runtime.mode === 'source' ? 'ts' : 'js'}`)).href), signal);
      const entries = catalog && typeof catalog === 'object' && 'builtinAgents' in catalog ? catalog.builtinAgents : null;
      if (!Array.isArray(entries)) throw new Error('Retained agent catalog is unavailable');
      const matches = entries.filter(entry => entry?.package?.manifest?.id === record.binding.pluginId);
      if (matches.length !== 1) throw new Error('Retained builtin agent identity is unavailable');
      pkg = parsePluginPackage(matches[0].package, { allowBuiltin: true }); imported = matches[0].module;
    } else {
      const archive = closure.archives.get(record.binding.pluginId);
      if (!archive) throw new Error('Retained agent archive is unavailable');
      pkg = archive.package; const materialized = await materializePluginBackend(input.pluginsRoot, archive); remove = materialized.dispose;
      imported = (await clarificationAbortable(import(materialized.href), signal)).default;
    }
    signal.throwIfAborted();
    if (pkg.manifest.id !== record.binding.pluginId || pkg.manifest.version !== closure.artifacts.get(record.binding.pluginId)?.packageVersion
      || !pkg.backend?.provides.length || pkg.backend.provides.some(value => String(value.id) !== 'helmsman/agent')
      || !pkg.backend.provides.some(value => `${pkg.manifest.id}/${value.localId}` === record.binding.providerId)) throw new Error('Retained agent declaration does not match');
    const schema = pkg.backend.settings;
    if (Object.keys(record.settings).length !== Object.keys(schema).length || Object.keys(record.settings).some(key => !Object.hasOwn(schema, key))) throw new Error('Retained agent settings differ from declaration');
    for (const [key, field] of Object.entries(schema)) validatePluginSetting(field, record.settings[key]);
    const providers = new Map<string, AgentProviderV1>(); let activating = true;
    const context = Object.freeze<AgentBackendContextV1>({ pluginId: pkg.manifest.id, settings: record.settings, signal,
      registerAgent(localId, provider) {
        signal.throwIfAborted();
        if (!activating || !pkg.backend!.provides.some(value => value.localId === localId) || providers.has(localId)) throw new Error('Undeclared or duplicate retained agent registration');
        providers.set(localId, boundedAgentProvider(provider));
      },
      onDispose(cleanup) {
        if (typeof cleanup !== 'function') throw new Error('Invalid agent cleanup');
        if (disposed) { void Promise.resolve().then(cleanup).catch(() => {}); return; }
        cleanups.push(cleanup);
      },
    });
    if (!imported || typeof imported !== 'object' || !('activate' in imported) || typeof imported.activate !== 'function') throw new Error('Retained agent module is invalid');
    const activate = imported.activate;
    try { await clarificationAbortable(Promise.resolve().then(() => { signal.throwIfAborted(); return activate.call(imported, context); }), signal); }
    finally { activating = false; clearTimeout(timer); }
    signal.throwIfAborted();
    if (providers.size !== pkg.backend.provides.length) throw new Error('Retained package did not register its declared agents');
    const provider = providers.get(record.binding.providerId.split('/')[1]!);
    if (!provider || persistenceHash(provider.metadata) !== persistenceHash(record.metadata)) throw new Error('Retained agent metadata differs from its snapshot');
    return { provider: Object.freeze<AgentProviderV1>({ metadata: provider.metadata,
      buildCommand(value) { signal.throwIfAborted(); const result = provider.buildCommand(value); signal.throwIfAborted(); return result; },
      parseLine(line) { signal.throwIfAborted(); const result = provider.parseLine(line); signal.throwIfAborted(); return result; },
    }), dispose };
  } catch (error) { await dispose(); throw error; } finally { clearTimeout(timer); }
}
