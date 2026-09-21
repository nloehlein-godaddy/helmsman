import { ensureBuiltinPageSlots } from '../../../src/plugins/builtins';
import { builtinFrontendManifests, builtinPageSlots } from '../../../src/plugins/frontend-manifests';
import { isContributionId, parsePluginManifest, PluginManifestError } from '../../../src/plugins/manifest';
import { parsePluginPackage } from '../../../src/plugins/package';
import type { PluginPageRegistry } from '../../../src/plugins/registry';
import type { PluginCatalog } from '../../../src/plugins/runtime';
import type { PluginManifest } from '../../../src/plugins/sdk';

const slots: readonly string[] = builtinPageSlots.map(slot => slot.id);
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {})))) throw new PluginManifestError('Invalid server page catalog data');
  return input as Record<string, unknown>;
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum || Reflect.ownKeys(input).some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) throw new PluginManifestError('Invalid server page catalog collection');
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !('value' in descriptor)) throw new PluginManifestError('Server page catalog collections must be dense data');
    return descriptor.value as unknown;
  });
}
function hash(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f\d]{64}$/.test(input)) throw new PluginManifestError('Invalid server page artifact hash');
  return input;
}

function projection(input: PluginCatalog) {
  const catalog = record(input);
  if (catalog.version !== 1 || typeof catalog.safeMode !== 'boolean') throw new PluginManifestError('Unsupported server page catalog');
  const bindings = record(catalog.bindings);
  for (const [slot, contribution] of Object.entries(bindings)) if (!slots.includes(slot) || !isContributionId(contribution)) throw new PluginManifestError('Invalid persisted page selection');
  const desired = new Map<string, { manifest: PluginManifest; fingerprint: string }>();
  const identities = new Set<string>();
  function add(manifest: PluginManifest, artifactHash: string, enabled: boolean) {
    if (identities.has(manifest.id)) throw new PluginManifestError('Duplicate server page catalog package');
    identities.add(manifest.id);
    if (!catalog.safeMode && enabled && manifest.pages.length) desired.set(manifest.id, { manifest, fingerprint: JSON.stringify([artifactHash, manifest]) });
  }
  for (const value of array(catalog.plugins, 32)) {
    const entry = record(value);
    const pkg = parsePluginPackage(entry.package);
    add(pkg.manifest, hash(entry.hash), true);
  }
  for (const value of array(catalog.builtins === undefined ? [] : catalog.builtins, builtinFrontendManifests.length)) {
    const entry = record(value);
    const trusted = builtinFrontendManifests.find(manifest => manifest.id === entry.id);
    if (!trusted || typeof entry.enabled !== 'boolean' || typeof entry.version !== 'string' || !entry.version || entry.version.length > 128) throw new PluginManifestError('Invalid trusted frontend catalog entry');
    add(parsePluginManifest(trusted), hash(entry.hash), entry.enabled && entry.version === trusted.version);
  }
  return { desired, bindings: new Map(Object.entries(bindings) as [string, string][]) };
}

export function createServerPageCatalog(registry: PluginPageRegistry): { apply(catalog: PluginCatalog): void; dispose(): void } {
  ensureBuiltinPageSlots(registry);
  registry.unregister('helmsman.costs');
  const registrations = new Map<string, { fingerprint: string; dispose(): void }>();
  let disposed = false;
  return {
    apply(catalog) {
      if (disposed) return;
      const next = projection(catalog);
      for (const [id, current] of registrations) if (next.desired.get(id)?.fingerprint !== current.fingerprint) {
        current.dispose(); registrations.delete(id);
      }
      for (const [id, desired] of next.desired) if (!registrations.has(id)) registrations.set(id, { fingerprint: desired.fingerprint, dispose: registry.register(desired.manifest) });
      for (const slot of slots) registry.restoreSelection(slot, next.bindings.get(slot) ?? null);
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const current of registrations.values()) current.dispose();
      registrations.clear();
    },
  };
}
