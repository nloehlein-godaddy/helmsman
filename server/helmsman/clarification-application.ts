import { isContributionId } from '../../src/plugins/manifest';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { createClarificationReadService, type ClarificationServerOptions } from './clarification-read-service';
import { createClarificationCommandService } from './clarification-command-service';
import { createSuggestedContactAdminService } from './suggested-contact-admin-service';
import { openClarificationReceiptStore } from './clarification-receipt-store';
import { ClarificationServiceError, type ClarificationFacet } from './clarification-service-common';

export function clarificationContributionEnabled(catalog: PluginCatalog, caller: string, facet: ClarificationFacet): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === `helmsman/${facet}` && requirement.version === 1) === true;
}

export function createApplicationClarifications(options: Omit<ClarificationServerOptions, 'authorize'> & { catalog(): PluginCatalog }) {
  const receipts = openClarificationReceiptStore(options.persistence);
  const authorize = (caller: string, facet: ClarificationFacet) => {
    if (!clarificationContributionEnabled(options.catalog(), caller, facet)) throw new ClarificationServiceError(403, 'forbidden');
  };
  return {
    reads: createClarificationReadService({ ...options, authorize }),
    commands: createClarificationCommandService({ ...options, receipts, authorize }),
    contacts: createSuggestedContactAdminService({ persistence: options.persistence, receipts, authorize, now: options.now }),
  };
}
