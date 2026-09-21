import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from '../logic/pagePaths';
import { PluginPageRegistry } from './registry';
import { COSTS_PAGE_SLOT, COSTS_PAGE_ID, COSTS_PAGE_ALIAS, costsManifest, HELM_PAGE_SLOT, HELM_PAGE_ALIAS, HELM_PAGE_ID } from './frontend-manifests';
export * from './frontend-manifests';

export function createAppPageRegistry(): PluginPageRegistry {
  const registry = new PluginPageRegistry([
    { id: COSTS_PAGE_SLOT, alias: COSTS_PAGE_ALIAS, defaultContributionId: COSTS_PAGE_ID },
    { id: HELM_PAGE_SLOT, alias: HELM_PAGE_ALIAS, aliases: ['/'], defaultContributionId: HELM_PAGE_ID },
  ], [...Object.values(LEGACY_PAGE_PATHS), ...Object.keys(LEGACY_PAGE_ALIASES)].filter(path => path !== '/helm' && path !== '/'));
  registry.register(costsManifest);
  return registry;
}

export const appPages = createAppPageRegistry();

export function ensureHelmPageSlot(registry: PluginPageRegistry): void {
  if (!registry.getSlot(HELM_PAGE_SLOT)) registry.registerSlot({ id: HELM_PAGE_SLOT, alias: HELM_PAGE_ALIAS,
    aliases: ['/'], defaultContributionId: HELM_PAGE_ID });
}
