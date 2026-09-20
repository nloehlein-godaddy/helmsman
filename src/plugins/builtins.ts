import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from '../logic/pagePaths';
import { PluginPageRegistry } from './registry';
import type { PluginManifest } from './sdk';

export const COSTS_PAGE_SLOT = 'helmsman/costs-page';
export const COSTS_PAGE_ID = 'helmsman.costs/page';
export const COSTS_PAGE_ALIAS = '/outcomes';

export const costsManifest: PluginManifest = {
  manifestVersion: 1,
  id: 'helmsman.costs',
  version: '0.1.0',
  sdkVersion: 1,
  pages: [{ id: 'page', title: 'Costs & Outcomes', slots: [COSTS_PAGE_SLOT], panes: ['summary', 'history'] }],
};

export function createAppPageRegistry(): PluginPageRegistry {
  const registry = new PluginPageRegistry([
    { id: COSTS_PAGE_SLOT, alias: COSTS_PAGE_ALIAS, defaultContributionId: COSTS_PAGE_ID },
  ], [...Object.values(LEGACY_PAGE_PATHS), ...Object.keys(LEGACY_PAGE_ALIASES)]);
  registry.register(costsManifest);
  return registry;
}

export const appPages = createAppPageRegistry();
