import { COSTS_PAGE_SLOT, HELM_PAGE_SLOT, builtinFrontendManifests } from './frontend-manifests';
import { isContributionId, PluginManifestError } from './manifest';
import { parsePluginPackage } from './package';
import type { PluginPackage } from './package';
import type { PluginPageModules } from './modules';
import type { PluginPageRegistry } from './registry';
import type { PluginPageInstance, PluginPageModule } from './sdk';
import type { PluginPanelModule } from './composition';
import { appPanels, type PluginPanelRegistry } from './panels';

export interface PluginCatalog {
  readonly version: 1;
  readonly safeMode: boolean;
  readonly plugins: readonly { readonly package: PluginPackage; readonly hash: string }[];
  readonly bindings: Readonly<Record<string, string>>;
  readonly builtins?: readonly BuiltinFrontendCatalogEntry[];
}

export interface BuiltinFrontendCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly enabled: boolean;
}

export interface PluginCatalogOptions {
  fetch?: typeof globalThis.fetch;
  importModule?: (href: string) => Promise<unknown>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  panels?: PluginPanelRegistry;
  applyBuiltins?: (entries: readonly BuiltinFrontendCatalogEntry[], safeMode: boolean) => void;
}

export interface PluginCatalogRuntime {
  readonly safeMode: boolean;
  readonly errors: readonly string[];
  dispose(): void;
}

function record(value: unknown, fields: readonly string[] | null, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new PluginManifestError(`${label} must be an object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || (fields && !fields.includes(key))
    || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))
    || fields?.some(field => !Object.hasOwn(value, field))) {
    throw new PluginManifestError(`${label} contains invalid fields.`);
  }
  return value as Record<string, unknown>;
}

export function parsePluginCatalog(value: unknown): PluginCatalog {
  const hasBuiltins = value !== null && typeof value === 'object' && Object.hasOwn(value, 'builtins');
  const catalog = record(value, ['version', 'safeMode', 'plugins', 'bindings', ...(hasBuiltins ? ['builtins'] : [])], 'Plugin catalog');
  if (catalog.version !== 1 || typeof catalog.safeMode !== 'boolean') {
    throw new PluginManifestError('Unsupported plugin catalog.');
  }
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length > 32) {
    throw new PluginManifestError('Plugin catalog must contain at most 32 packages.');
  }
  const rawPlugins = catalog.plugins;
  if (Reflect.ownKeys(rawPlugins).some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= rawPlugins.length))) {
    throw new PluginManifestError('Plugin catalog packages must be an array of data.');
  }
  const plugins = Array.from({ length: rawPlugins.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(rawPlugins, index);
    if (!descriptor || !('value' in descriptor)) throw new PluginManifestError('Plugin catalog packages must be dense data.');
    const value: unknown = descriptor.value;
    const entry = record(value, ['package', 'hash'], 'Catalog package');
    if (typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash)) {
      throw new PluginManifestError('Invalid plugin package hash.');
    }
    return Object.freeze({ package: parsePluginPackage(entry.package), hash: entry.hash });
  });
  if (new Set(plugins.map(entry => entry.package.manifest.id)).size !== plugins.length) {
    throw new PluginManifestError('Plugin catalog contains duplicate packages.');
  }
  const rawBindings = record(catalog.bindings, null, 'Plugin bindings');
  const bindings: Record<string, string> = {};
  for (const slot of Object.getOwnPropertyNames(rawBindings)) {
    const contribution = rawBindings[slot];
    if (slot !== COSTS_PAGE_SLOT && slot !== HELM_PAGE_SLOT || !isContributionId(contribution)) {
      throw new PluginManifestError('Invalid plugin page binding.');
    }
    bindings[slot] = contribution;
  }
  const builtins: BuiltinFrontendCatalogEntry[] = [];
  if (hasBuiltins) {
    if (!Array.isArray(catalog.builtins) || catalog.builtins.length > builtinFrontendManifests.length) throw new PluginManifestError('Invalid built-in catalog.');
    const entries = catalog.builtins;
    if (Reflect.ownKeys(entries).some(key => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= entries.length))) throw new PluginManifestError('Invalid built-in catalog data.');
    for (let index = 0; index < entries.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(entries, index);
      if (!descriptor || !('value' in descriptor)) throw new PluginManifestError('Built-in catalog must contain dense data.');
      const value: unknown = descriptor.value;
      const item = record(value, ['id', 'version', 'hash', 'enabled'], 'Built-in catalog entry');
      if (!builtinFrontendManifests.some(manifest => manifest.id === item.id) || builtins.some(entry => entry.id === item.id)
        || typeof item.id !== 'string' || typeof item.version !== 'string' || item.version.length > 128
        || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.enabled !== 'boolean') throw new PluginManifestError('Invalid built-in catalog entry.');
      builtins.push(Object.freeze({ id: item.id, version: item.version, hash: item.hash, enabled: item.enabled }));
    }
  }
  return Object.freeze({ version: 1, safeMode: catalog.safeMode,
    plugins: Object.freeze(plugins), bindings: Object.freeze(bindings), ...(hasBuiltins ? { builtins: Object.freeze(builtins) } : {}) });
}

const retiredInstance = (): PluginPageInstance => ({ update() {}, dispose() {} });

function lazyModule(href: string, importModule: (href: string) => Promise<unknown>, active: () => boolean): PluginPageModule {
  let pending: Promise<PluginPageModule> | null = null;
  return {
    async mount(container, context) {
      if (!active() || context.signal.aborted) return retiredInstance();
      pending ??= importModule(href).then(value => {
        const module = value && typeof value === 'object' ? (value as { default?: unknown }).default : null;
        if (!module || typeof module !== 'object' || typeof (module as Partial<PluginPageModule>).mount !== 'function') {
          throw new TypeError('Plugin page entry must default-export a page module.');
        }
        return module as PluginPageModule;
      });
      const module = await pending;
      if (!active() || context.signal.aborted) return retiredInstance();
      return module.mount(container, context);
    },
  };
}

function lazyPanelModule(href: string, importModule: (href: string) => Promise<unknown>, active: () => boolean): PluginPanelModule {
  let pending: Promise<PluginPanelModule> | null = null;
  return {
    async mount(container, context) {
      if (!active() || context.signal.aborted) return retiredInstance();
      pending ??= importModule(href).then(value => {
        const module = value && typeof value === 'object' ? (value as { default?: unknown }).default : null;
        if (!module || typeof module !== 'object' || typeof (module as Partial<PluginPanelModule>).mount !== 'function') {
          throw new TypeError('Plugin panel entry must default-export a panel module.');
        }
        return module as PluginPanelModule;
      });
      const module = await pending;
      if (!active() || context.signal.aborted) return retiredInstance();
      return module.mount(container, context);
    },
  };
}

async function fetchCatalog(fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<PluginCatalog> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Plugin catalog timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher('/api/plugins/catalog', {
        signal: controller.signal, credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      if (!response?.ok) throw new Error('Plugin catalog request failed.');
      return parsePluginCatalog(await response.json());
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadPluginCatalog(
  registry: PluginPageRegistry,
  modules: PluginPageModules,
  options: PluginCatalogOptions = {},
): Promise<PluginCatalogRuntime> {
  const errors: string[] = [];
  const disposers = new Map<string, { hash: string; dispose(): void }>();
  const selectedSlots = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    for (const entry of [...disposers.values()].reverse()) entry.dispose();
    disposers.clear();
  };
  let catalog: PluginCatalog;
  try {
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid catalog timeout.');
    catalog = await fetchCatalog(options.fetch ?? globalThis.fetch, timeoutMs);
  } catch {
    return { safeMode: true, errors: Object.freeze(['Plugin catalog unavailable; optional pages were not loaded.']), dispose };
  }
  const importModule = options.importModule ?? (href => import(/* @vite-ignore */ href));
  const panels = options.panels ?? appPanels;
  function apply(next: PluginCatalog): void {
    if (disposed) return;
    if (next.builtins || next.safeMode) options.applyBuiltins?.(next.builtins ?? [], next.safeMode);
    for (const slot of selectedSlots) if (!Object.hasOwn(next.bindings, slot)) {
      registry.select(slot, null); selectedSlots.delete(slot);
    }
    for (const [id, current] of disposers) {
      if (next.safeMode || !next.plugins.some(entry => entry.package.manifest.id === id && entry.hash === current.hash)) {
        current.dispose(); disposers.delete(id);
      }
    }
    for (const [slot, contribution] of Object.entries(next.bindings)) {
      try { registry.restoreSelection(slot, contribution); selectedSlots.add(slot); }
      catch { errors.push(`Plugin binding ${slot} could not be selected.`); }
    }
    if (next.safeMode) return;
    for (const entry of next.plugins) {
      if (disposers.has(entry.package.manifest.id)) continue;
      const packageDisposers: (() => void)[] = [];
      let active = true;
      const retire = () => {
        active = false;
        for (const cleanup of packageDisposers.reverse()) cleanup();
      };
      try {
        for (const [pageId, path] of Object.entries(entry.package.entries)) {
          const href = `/plugin-assets/${entry.package.manifest.id}/${entry.hash}/${path}`;
          packageDisposers.push(modules.register(`${entry.package.manifest.id}/${pageId}`,
            lazyModule(href, importModule, () => active && !disposed)));
        }
        for (const [panelId, path] of Object.entries(entry.package.panelEntries ?? {})) {
          const href = `/plugin-assets/${entry.package.manifest.id}/${entry.hash}/${path}`;
          packageDisposers.push(panels.registerModule(`${entry.package.manifest.id}/${panelId}`,
            lazyPanelModule(href, importModule, () => active && !disposed)));
        }
        if (entry.package.manifest.manifestVersion === 2) packageDisposers.push(panels.register(entry.package.manifest));
        packageDisposers.push(registry.register(entry.package.manifest));
        disposers.set(entry.package.manifest.id, { hash: entry.hash, dispose: retire });
      } catch {
        retire();
        errors.push(`Plugin ${entry.package.manifest.id} could not be registered.`);
      }
    }
  }
  apply(catalog);
  if (catalog.safeMode) return { safeMode: true, errors: Object.freeze([...errors]), dispose };
  if (options.pollIntervalMs !== undefined) {
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 100 || options.pollIntervalMs > 60_000) {
      dispose(); throw new Error('Invalid plugin catalog polling interval.');
    }
    timer = setInterval(() => {
      if (refreshing || disposed) return;
      refreshing = true;
      void fetchCatalog(options.fetch ?? globalThis.fetch, options.timeoutMs ?? 5_000)
        .then(next => { apply(next); catalog = next; })
        .catch(() => {}).finally(() => { refreshing = false; });
    }, options.pollIntervalMs);
  }
  return { safeMode: false, errors: Object.freeze([...errors]), dispose };
}
