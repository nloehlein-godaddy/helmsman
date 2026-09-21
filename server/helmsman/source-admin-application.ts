import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { createSourceAdminService, SourceAdminAccessError, type SourceAdminServerOptions, type SourceAdminServerService } from './source-admin-service';

export function sourceAdminContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/source-admin' && requirement.version === 1) === true;
}
export function createApplicationSourceAdmin(options: Omit<SourceAdminServerOptions, 'authorize'> & { catalog(): PluginCatalog }): SourceAdminServerService {
  return createSourceAdminService({ ...options, authorize(caller) { if (!sourceAdminContributionEnabled(options.catalog(), caller)) throw new SourceAdminAccessError('Source administration contribution is unavailable'); } });
}
