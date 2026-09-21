import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import { isContributionId } from '../../src/plugins/manifest';
import type { PluginCatalog } from '../../src/plugins/runtime';

export function campaignContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/campaigns' && requirement.version === 1) === true;
}
