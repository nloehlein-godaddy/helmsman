import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginBackendContext, PluginBackendModule, PluginJson, PricingProvider } from '../../../src/plugins/backend';
import { parsePluginPackage, type PluginPackage } from '../../../src/plugins/package';
import type { PricingEstimate, UsageQueryService, UsageSnapshot } from '../../../src/plugins/usage';
import { isContributionId } from '../../../src/plugins/manifest';
import type { PluginArchive } from './artifacts';
import { builtinPluginEnabled, initializePricingDefault, openPluginData, pluginJson, readPricingBinding } from './data';
import type { PluginSnapshot } from './store';

export class CapabilityResolutionError extends Error {
  readonly code: 'missing' | 'ambiguous' | 'invalid-selection' | 'inactive' | 'invalid-result';
  constructor(code: CapabilityResolutionError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'CapabilityResolutionError';
  }
}

export interface PricingSelections { explicit?: string; workflow?: string; galleon?: string; }
export interface BuiltinBackendPlugin { package: PluginPackage; module: PluginBackendModule; }
export interface BackendRuntime {
  readonly errors: readonly string[];
  activePluginIds(): readonly string[];
  providers(): readonly string[];
  pricing(input: UsageSnapshot, selections?: PricingSelections): Promise<{ providerId: string; estimate: PricingEstimate | null }>;
  dispose(): Promise<void>;
}

function pricingEstimate(input: unknown, snapshot: UsageSnapshot): PricingEstimate | null {
  if (input === null) return null;
  const value = pluginJson(input, { maxNodes: Math.min(2_000_000, Math.max(4096, snapshot.records.length * 8 + 64)), maxBytes: 16 * 1024 * 1024 }) as unknown as PricingEstimate;
  const count = snapshot.records.filter(record => record.costUsd === null).length;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.currency !== 'USD'
    || Object.keys(value).some(key => !['version', 'currency', 'estimatedUnreportedCostUsd', 'estimatedUsageEvents', 'unreportedUsageEvents', 'provenance', 'records'].includes(key))
    || value.estimatedUnreportedCostUsd !== null && (typeof value.estimatedUnreportedCostUsd !== 'number' || !Number.isFinite(value.estimatedUnreportedCostUsd) || value.estimatedUnreportedCostUsd < 0)
    || !Number.isSafeInteger(value.estimatedUsageEvents) || value.estimatedUsageEvents < 0 || value.estimatedUsageEvents > count
    || value.unreportedUsageEvents !== count || (value.estimatedUsageEvents === 0) !== (value.estimatedUnreportedCostUsd === null)
    || !value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)
    || Object.keys(value.provenance).length !== 3
    || ['source', 'rateVersion', 'asOf'].some(key => typeof value.provenance[key as keyof typeof value.provenance] !== 'string'
      || !value.provenance[key as keyof typeof value.provenance].trim() || value.provenance[key as keyof typeof value.provenance].length > 2048)
    || !Number.isFinite(Date.parse(value.provenance.asOf))) throw new Error('Invalid pricing result or provenance.');
  if (value.records !== undefined) {
    if (!Array.isArray(value.records) || value.records.length !== count) throw new Error('Pricing details must cover every unreported usage event.');
    const records = new Map(snapshot.records.filter(record => record.costUsd === null).map(record => [JSON.stringify([record.runId, record.attempt, record.eventId]), record]));
    const seen = new Set<string>();
    let sum = 0;
    let priced = 0;
    for (const record of value.records) {
      const key = JSON.stringify([record?.runId, record?.attempt, record?.eventId]);
      if (!record || Object.keys(record).length !== 4 || !records.has(key) || seen.has(key)
        || record.estimatedCostUsd !== null && (typeof record.estimatedCostUsd !== 'number' || !Number.isFinite(record.estimatedCostUsd) || record.estimatedCostUsd < 0)) throw new Error('Pricing details reference invalid usage.');
      seen.add(key);
      if (record.estimatedCostUsd !== null) { priced++; sum += record.estimatedCostUsd; }
    }
    if (!Number.isFinite(sum) || priced !== value.estimatedUsageEvents || priced > 0 && Math.abs(sum - (value.estimatedUnreportedCostUsd ?? 0)) > Math.max(1e-9, sum * 1e-9)) throw new Error('Pricing details do not match aggregate estimates.');
  }
  return value;
}

async function materialize(root: string, archive: PluginArchive): Promise<{ href: string; dispose(): Promise<void> }> {
  const parent = join(root, 'runtime');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, `${archive.hash}-`));
  try {
    for (const [path, bytes] of archive.files) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!archive.files.has('package.json')) await writeFile(join(directory, 'package.json'), '{"type":"module"}', { flag: 'wx' });
    return { href: pathToFileURL(join(directory, archive.package.backend!.entry)).href, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function activateBackendPlugins(options: {
  root: string; snapshot: PluginSnapshot; usage: UsageQueryService; builtins?: readonly BuiltinBackendPlugin[]; activationTimeoutMs?: number; defaultPricingProvider?: string;
}): Promise<BackendRuntime> {
  const timeoutMs = options.activationTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid backend activation timeout.');
  const errors: string[] = [];
  const providers = new Map<string, PricingProvider>();
  const activeIds = new Set<string>();
  const owners: (() => Promise<void>)[] = [];
  const ids = new Set<string>();
  let disposed = false;
  let bindingInitializationFailed = false;
  async function bounded<T>(work: () => Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  if (options.defaultPricingProvider) {
    try { initializePricingDefault(options.root, options.defaultPricingProvider); }
    catch { bindingInitializationFailed = true; errors.push('Backend defaults could not be initialized; configured pricing remains unavailable.'); }
  }
  async function activate(pkg: PluginPackage, load: (signal: AbortSignal) => Promise<unknown>, remove: () => Promise<void>): Promise<void> {
    const id = pkg.manifest.id;
    let data: ReturnType<typeof openPluginData> | undefined;
    const abort = new AbortController();
    const cleanups: (() => void | Promise<void>)[] = [];
    const staged = new Map<string, PluginJson | undefined>();
    const pending = new Map<string, PricingProvider>();
    let phase: 'activating' | 'active' | 'disposed' = 'activating';
    const live = () => { if (phase === 'disposed') throw new CapabilityResolutionError('inactive', 'Plugin has been disposed.'); };
    const cleanup = async () => {
      if (phase === 'disposed') return;
      if (phase === 'active') activeIds.delete(id);
      phase = 'disposed'; abort.abort();
      for (const provider of pending.keys()) providers.delete(provider);
      for (const dispose of cleanups.reverse()) {
        try { await bounded(async () => { await dispose(); }, 'Plugin cleanup'); } catch { errors.push(`Plugin ${id} cleanup failed.`); }
      }
      data?.close();
      await remove().catch(() => { errors.push(`Plugin ${id} runtime cleanup failed.`); });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (ids.has(id)) throw new Error('Duplicate backend plugin identity.');
      ids.add(id);
      const node = Number(process.versions.node.split('.')[0]);
      if (node < pkg.node.minMajor || node >= pkg.node.maxMajorExclusive) throw new Error('Backend Node version is incompatible.');
      data = openPluginData(options.root, pkg);
      const context: PluginBackendContext = Object.freeze({
        pluginId: id, signal: abort.signal, settings: data.settings,
        usage: Object.freeze({ query: async (input: Parameters<UsageQueryService['query']>[0]) => {
          live(); const result = await options.usage.query(input); live(); return structuredClone(result);
        } }),
        storage: Object.freeze({
          get: async (key: string) => { live(); return staged.has(key) ? staged.get(key) : data!.read(key); },
          set: async (key: string, value: PluginJson) => { live(); const copied = pluginJson(value); data!.read(key); if (phase === 'activating') staged.set(key, copied); else data!.commit(new Map([[key, copied]])); },
          delete: async (key: string) => { live(); data!.read(key); if (phase === 'activating') staged.set(key, undefined); else data!.commit(new Map([[key, undefined]])); },
        }),
        onDispose: (fn: () => void | Promise<void>) => {
          if (typeof fn !== 'function') throw new Error('Plugin cleanup must be a function.');
          if (phase === 'disposed') { void Promise.resolve().then(fn).catch(() => { errors.push(`Plugin ${id} late cleanup failed.`); }); }
          else cleanups.push(fn);
        },
        registerPricing: (localId: string, provider: PricingProvider) => {
          if (phase !== 'activating' || !pkg.backend?.provides.some(item => item.localId === localId) || !provider || typeof provider.estimate !== 'function') throw new Error('Undeclared or invalid pricing provider registration.');
          const providerId = `${id}/${localId}`;
          if (pending.has(providerId) || providers.has(providerId)) throw new Error('Duplicate pricing provider registration.');
          pending.set(providerId, provider);
        },
      });
      const work = (async () => {
        const imported = await load(abort.signal);
        live();
        const module = imported && typeof imported === 'object' && 'default' in imported ? imported.default : null;
        if (!module || typeof module !== 'object' || !('activate' in module) || typeof module.activate !== 'function') throw new Error('Backend entry must default-export an activate module.');
        await module.activate(context);
      })();
      await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Backend activation timed out.')), timeoutMs); })]);
      if (pending.size !== pkg.backend?.provides.length) throw new Error('Backend did not register all declared providers.');
      data.commit(staged); staged.clear();
      for (const [providerId, provider] of pending) providers.set(providerId, provider);
      phase = 'active'; activeIds.add(id); owners.push(cleanup);
    } catch (error) {
      errors.push(`Plugin ${id} activation failed: ${error instanceof Error ? error.message : String(error)}`);
      await cleanup();
    } finally { clearTimeout(timer); }
  }
  for (const builtin of options.builtins ?? []) {
    try {
      const pkg = parsePluginPackage(builtin.package, { allowBuiltin: true });
      if (pkg.backend && builtinPluginEnabled(options.root, pkg)) await activate(pkg, async () => ({ default: builtin.module }), async () => {});
    } catch (error) { errors.push(`Builtin backend could not activate: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const archive of [...options.snapshot.artifacts.values()].sort((a, b) => a.package.manifest.id.localeCompare(b.package.manifest.id))) {
    if (!archive.package.backend) continue;
    let extracted: Awaited<ReturnType<typeof materialize>> | undefined;
    await activate(archive.package, async signal => {
      extracted = await materialize(options.root, archive);
      if (signal.aborted) { await extracted.dispose(); throw new Error('Backend activation was cancelled.'); }
      return import(extracted.href);
    }, async () => { await extracted?.dispose(); });
  }
  return {
    errors,
    activePluginIds: () => Object.freeze([...activeIds].sort()),
    providers: () => Object.freeze([...providers.keys()].sort()),
    async pricing(snapshot, selections = {}) {
      if (disposed) throw new CapabilityResolutionError('inactive', 'Backend runtime is disposed.');
      let selected: string | undefined;
      for (const key of ['explicit', 'workflow', 'galleon'] as const) {
        const value = selections?.[key];
        if (value === undefined) continue;
        if (!isContributionId(value)) throw new CapabilityResolutionError('invalid-selection', `Invalid ${key} pricing provider selection.`);
        selected = value; break;
      }
      if (selected === undefined) {
        if (bindingInitializationFailed) throw new CapabilityResolutionError('invalid-selection', 'Configured pricing defaults are unavailable.');
        try { selected = readPricingBinding(options.root); }
        catch { throw new CapabilityResolutionError('invalid-selection', 'Stored pricing provider selection is invalid.'); }
      }
      const candidates = [...providers.keys()].sort();
      if (selected !== undefined && !providers.has(selected)) throw new CapabilityResolutionError('invalid-selection', `Selected pricing provider is unavailable: ${selected}`);
      if (selected === undefined && candidates.length !== 1) throw new CapabilityResolutionError(candidates.length ? 'ambiguous' : 'missing', candidates.length ? `Select a pricing provider: ${candidates.join(', ')}` : 'No pricing provider is available.');
      const providerId = selected ?? candidates[0]!;
      try {
        if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw new Error('Invalid usage snapshot.');
        const result = await bounded(async () => providers.get(providerId)!.estimate(structuredClone(snapshot)), 'Pricing provider');
        if (disposed) throw new CapabilityResolutionError('inactive', 'Backend runtime is disposed.');
        return { providerId, estimate: pricingEstimate(result, snapshot) };
      } catch (error) {
        if (error instanceof CapabilityResolutionError) throw error;
        throw new CapabilityResolutionError('invalid-result', `Pricing provider ${providerId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true; providers.clear(); activeIds.clear();
      for (const cleanup of owners.reverse()) await cleanup();
    },
  };
}
