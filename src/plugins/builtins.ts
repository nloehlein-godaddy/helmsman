import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from '../logic/pagePaths';
import { PluginPageRegistry } from './registry';
import { builtinPageSlots, costsManifest, HELM_PAGE_SLOT } from './frontend-manifests';
export * from './frontend-manifests';

export function createAppPageRegistry(): PluginPageRegistry {
  const paths = new Set(builtinPageSlots.flatMap(slot => [slot.alias, ...(slot.aliases ?? [])]));
  const registry = new PluginPageRegistry(builtinPageSlots,
    [...Object.values(LEGACY_PAGE_PATHS), ...Object.keys(LEGACY_PAGE_ALIASES)].filter(path => !paths.has(path)));
  registry.register(costsManifest);
  return registry;
}

export const appPages = createAppPageRegistry();

export function ensureHelmPageSlot(registry: PluginPageRegistry): void {
  const slot = builtinPageSlots.find(slot => slot.id === HELM_PAGE_SLOT);
  if (slot && !registry.getSlot(slot.id)) registry.registerSlot(slot);
}

export function ensureBuiltinPageSlots(registry: PluginPageRegistry): void {
  for (const slot of builtinPageSlots) if (!registry.getSlot(slot.id)) registry.registerSlot(slot);
}
