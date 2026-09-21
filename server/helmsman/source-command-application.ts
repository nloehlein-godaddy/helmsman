import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { createSourceCommandCoordinator, SourceCommandAccessError, type SourceCommandServerService } from './source-command-coordinator';
import type { TaskEditorServerOptions } from './task-edit-service';
import type { LocalSourceAdapter } from './task-sources/local-records';
import type { SourceCommandStore } from './source-command-store';

export function sourceCommandContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/source-command' && requirement.version === 1) === true;
}
export function createApplicationSourceCommands(options: TaskEditorServerOptions & {
  commands: SourceCommandStore; local: LocalSourceAdapter; catalog(): PluginCatalog;
}): SourceCommandServerService {
  return createSourceCommandCoordinator({ ...options,
    authorize(caller) { if (!sourceCommandContributionEnabled(options.catalog(), caller)) throw new SourceCommandAccessError('Source command contribution is unavailable'); },
  });
}
