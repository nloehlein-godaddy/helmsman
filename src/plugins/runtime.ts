import { COSTS_PAGE_SLOT } from './builtins';
import { isContributionId, PluginManifestError } from './manifest';
import { parsePluginPackage } from './package';
import type { PluginPackage } from './package';
import type { PluginPageModules } from './modules';
import type { PluginPageRegistry } from './registry';
import type { PluginPageInstance, PluginPageModule } from './sdk';

export interface PluginCatalog {
  readonly version: 1;
  readonly safeMode: boolean;
  readonly plugins: readonly { readonly package: PluginPackage; readonly hash: string }[];
  readonly bindings: Readonly<Record<string, string>>;
}

export interface PluginCatalogOptions {
  fetch?: typeof globalThis.fetch;
  importModule?: (href: string) => Promise<unknown>;
  timeoutMs?: number;
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
  const catalog = record(value, ['version', 'safeMode', 'plugins', 'bindings'], 'Plugin catalog');
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
    if (slot !== COSTS_PAGE_SLOT || !isContributionId(contribution)) {
      throw new PluginManifestError('Invalid plugin page binding.');
    }
    bindings[slot] = contribution;
  }
  return Object.freeze({ version: 1, safeMode: catalog.safeMode,
    plugins: Object.freeze(plugins), bindings: Object.freeze(bindings) });
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
  const disposers: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of disposers.reverse()) cleanup();
  };
  let catalog: PluginCatalog;
  try {
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid catalog timeout.');
    catalog = await fetchCatalog(options.fetch ?? globalThis.fetch, timeoutMs);
  } catch {
    return { safeMode: true, errors: Object.freeze(['Plugin catalog unavailable; optional pages were not loaded.']), dispose };
  }
  for (const [slot, contribution] of Object.entries(catalog.bindings)) {
    try { registry.select(slot, contribution); }
    catch { errors.push(`Plugin binding ${slot} could not be selected.`); }
  }
  if (catalog.safeMode) return { safeMode: true, errors: Object.freeze(errors), dispose };
  const importModule = options.importModule ?? (href => import(/* @vite-ignore */ href));
  for (const entry of catalog.plugins) {
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
      packageDisposers.push(registry.register(entry.package.manifest));
      disposers.push(retire);
    } catch {
      retire();
      errors.push(`Plugin ${entry.package.manifest.id} could not be registered.`);
    }
  }
  return { safeMode: false, errors: Object.freeze(errors), dispose };
}
