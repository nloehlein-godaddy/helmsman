import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import type { FeedbackTrackerBackendContextV1, FeedbackTrackerProviderV1 } from '../../src/plugins/feedback-tracker';
import { isPluginId } from '../../src/plugins/manifest';
import { parsePluginPackage, validatePluginSetting, type PluginPackage } from '../../src/plugins/package';
import { validateFeedbackTrackerProvider, parseFeedbackTrackerRetainedProviderV1, type FeedbackTrackerRetainedProviderV1 } from './feedback-tracker-providers';
import type { ArtifactBinding } from './execution-store';
import { verifyLegacyRuntime, type RetainedLegacyRuntime } from './legacy-runtime-artifact';
import { readPluginArtifact, type PluginArchive } from './plugins/artifacts';
import { validatePluginImports } from './plugins/imports';
import { materializePluginBackend } from './plugins/materialize';
import { createPluginCleanup } from './plugins/cleanup';
import { assertPluginNodeCompatibility } from './plugins/compatibility';

async function verifyClosure(input: { pluginsRoot: string; runtimeArtifactsRoot: string; artifacts: readonly ArtifactBinding[] }, record: FeedbackTrackerRetainedProviderV1) {
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 256) throw new Error('Retained feedback tracker artifact closure is invalid');
  const artifacts = new Map<string, ArtifactBinding>(); const archives = new Map<string, PluginArchive>(); const runtimes = new Map<string, RetainedLegacyRuntime>();
  for (const item of input.artifacts) {
    if (!item || !isPluginId(item.pluginId) || typeof item.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(item.artifactHash)
      || typeof item.packageVersion !== 'string' || !item.packageVersion || !Array.isArray(item.requires) || item.requires.length > 256
      || item.requires.some((id: unknown) => !isPluginId(id)) || new Set(item.requires).size !== item.requires.length || artifacts.has(item.pluginId)) throw new Error('Retained feedback tracker artifact closure is invalid');
    artifacts.set(item.pluginId, item);
  }
  const selected = artifacts.get(record.binding.pluginId);
  if (selected?.artifactHash !== record.binding.artifactHash) throw new Error('Feedback tracker provider is not in the retained artifact closure');
  const visited = new Set<string>(); const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error('Retained feedback tracker dependencies contain a cycle');
    if (visited.has(id)) return;
    const artifact = artifacts.get(id); if (!artifact) throw new Error('Retained feedback tracker dependency is missing');
    active.add(id); for (const required of artifact.requires) visit(required); active.delete(id); visited.add(id);
  }
  for (const id of artifacts.keys()) visit(id);
  for (const artifact of artifacts.values()) {
    if (artifact.pluginId.startsWith('helmsman.')) {
      let runtime = runtimes.get(artifact.artifactHash);
      if (!runtime) { runtime = await verifyLegacyRuntime(input.runtimeArtifactsRoot, artifact.artifactHash) ?? undefined; if (!runtime) throw new Error('Exact retained feedback tracker runtime is unavailable'); runtimes.set(artifact.artifactHash, runtime); }
      if (artifact.pluginId !== runtime.artifact.pluginId && (!artifact.requires.includes(runtime.artifact.pluginId)
        || artifacts.get(runtime.artifact.pluginId)?.artifactHash !== artifact.artifactHash)) throw new Error('Builtin feedback tracker requires its original retained runtime');
    } else {
      const archive = await readPluginArtifact(input.pluginsRoot, artifact.artifactHash);
      if (archive.package.manifest.id !== artifact.pluginId || archive.package.manifest.version !== artifact.packageVersion) throw new Error('Retained feedback tracker artifact identity differs');
      assertPluginNodeCompatibility(archive.package);
      await validatePluginImports(archive); archives.set(artifact.pluginId, archive);
    }
  }
  return { artifacts, archives, runtimes };
}

export async function loadRetainedFeedbackTrackerProvider(input: {
  pluginsRoot: string; runtimeArtifactsRoot: string; record: FeedbackTrackerRetainedProviderV1; artifacts: readonly ArtifactBinding[]; signal?: AbortSignal;
}): Promise<{ provider: FeedbackTrackerProviderV1; dispose(): Promise<void> }> {
  const record = parseFeedbackTrackerRetainedProviderV1(input.record);
  input.signal?.throwIfAborted(); const closure = await verifyClosure(input, record); input.signal?.throwIfAborted();
  let remove: (() => Promise<void>) | undefined; let pkg: PluginPackage; let imported: unknown;
  const cleanups = createPluginCleanup({ timeoutMs: 1000 }); const controller = new AbortController(); let disposal: Promise<void> | undefined;
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposal = Promise.resolve().then(async () => { await cleanups.dispose(); await remove?.(); });
    controller.abort();
    return disposal;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(new Error('Retained feedback tracker activation timed out')), 10_000);
    if (record.origin === 'builtin') {
      const runtime = closure.runtimes.get(record.binding.artifactHash);
      if (!runtime) throw new Error('Builtin feedback tracker runtime is unavailable');
      const catalog: unknown = await clarificationAbortable(import(pathToFileURL(join(runtime.root, 'server', 'helmsman', 'plugins', `builtin-feedback-trackers.${runtime.mode === 'source' ? 'ts' : 'js'}`)).href), signal);
      const entries = catalog && typeof catalog === 'object' && 'builtinFeedbackTrackers' in catalog ? catalog.builtinFeedbackTrackers : null;
      if (!Array.isArray(entries)) throw new Error('Retained feedback tracker catalog is unavailable');
      const matches = entries.filter(entry => entry?.package?.manifest?.id === record.binding.pluginId);
      if (matches.length !== 1) throw new Error('Retained builtin feedback tracker identity is unavailable');
      pkg = parsePluginPackage(matches[0].package, { allowBuiltin: true }); imported = matches[0].module;
    } else {
      const archive = closure.archives.get(record.binding.pluginId);
      if (!archive) throw new Error('Retained feedback tracker archive is unavailable');
      pkg = archive.package; const materialized = await materializePluginBackend(input.pluginsRoot, archive); remove = materialized.dispose;
      imported = (await clarificationAbortable(import(materialized.href), signal)).default;
    }
    signal.throwIfAborted();
    if (pkg.manifest.id !== record.binding.pluginId || pkg.manifest.version !== closure.artifacts.get(record.binding.pluginId)?.packageVersion
      || !pkg.backend?.provides.length || pkg.backend.provides.some(value => String(value.id) !== 'helmsman/feedback-tracker')
      || !pkg.backend.provides.some(value => `${pkg.manifest.id}/${value.localId}` === record.binding.providerId)) throw new Error('Retained feedback tracker declaration does not match');
    const schema = pkg.backend.settings;
    if (Object.keys(record.settings).length !== Object.keys(schema).length || Object.keys(record.settings).some(key => !Object.hasOwn(schema, key))) throw new Error('Retained feedback tracker settings differ from declaration');
    for (const [key, field] of Object.entries(schema)) validatePluginSetting(field, record.settings[key]);
    const providers = new Map<string, FeedbackTrackerProviderV1>(); let activating = true;
    const context = Object.freeze<FeedbackTrackerBackendContextV1>({ pluginId: pkg.manifest.id, settings: record.settings, signal,
      registerFeedbackTracker(localId, provider) {
        signal.throwIfAborted();
        if (!activating || !pkg.backend!.provides.some(value => value.localId === localId) || providers.has(localId)) throw new Error('Undeclared or duplicate retained feedback tracker registration');
        validateFeedbackTrackerProvider(provider); providers.set(localId, provider);
      },
      onDispose: cleanups.register,
    });
    if (!imported || typeof imported !== 'object' || !('activate' in imported) || typeof imported.activate !== 'function') throw new Error('Retained feedback tracker module is invalid');
    const activate = imported.activate;
    try { await clarificationAbortable(Promise.resolve().then(() => { signal.throwIfAborted(); return activate.call(imported, context); }), signal); }
    finally { activating = false; clearTimeout(timer); }
    signal.throwIfAborted();
    if (providers.size !== pkg.backend.provides.length) throw new Error('Retained package did not register its declared feedback trackers');
    const provider = providers.get(record.binding.providerId.split('/')[1]!);
    if (!provider) throw new Error('Retained feedback tracker is unavailable');
    return { provider, dispose };
  } catch (error) { await dispose(); throw error; } finally { clearTimeout(timer); }
}
