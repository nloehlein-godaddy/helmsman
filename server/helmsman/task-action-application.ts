import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { ClarificationServiceError } from './clarification-service-common';
import { createTaskActionService, type TaskActionServerOptions } from './task-action-service';

export function taskActionContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/task-action' && requirement.version === 1) === true;
}
export function createApplicationTaskActions(options: Omit<TaskActionServerOptions, 'authorize'> & { catalog(): PluginCatalog }) {
  return createTaskActionService({ ...options, authorize(caller) {
    if (!taskActionContributionEnabled(options.catalog(), caller)) throw new ClarificationServiceError(403, 'forbidden');
  } });
}
