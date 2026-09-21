import { appPages, COSTS_PAGE_ID, builtinFrontendManifests, HELM_PAGE_ID, ensureHelmPageSlot } from './builtins';
import costsPage from './costs/page';
import helmPage from './helm/page';
import backlogPanel from './backlog/panel';
import runningPanel from './running/panel';
import recentPanel from './recent/panel';
import underwayPanel from './underway/panel';
import newRunPanel from './newrun/panel';
import repoPrsPanel from './repoprs/panel';
import shippedPanel from './shipped/panel';
import activityPanel from './activity/panel';
import { PluginPageModules } from './modules';
import { appPanels } from './panels';
import type { BuiltinFrontendCatalogEntry } from './runtime';

export const appPageModules = new PluginPageModules();

const removeCostsModule = appPageModules.register(COSTS_PAGE_ID, costsPage);
const activeBuiltins = new Map<string, { hash: string; dispose(): void }>();
let controlled = false;

export function syncBuiltinFrontend(entries: readonly BuiltinFrontendCatalogEntry[], safeMode: boolean): void {
  if (!controlled) {
    controlled = true;
    removeCostsModule();
    appPages.unregister('helmsman.costs');
    ensureHelmPageSlot(appPages);
  }
  for (const manifest of builtinFrontendManifests) {
    const entry = entries.find(entry => entry.id === manifest.id);
    const enabled = !safeMode && entry?.enabled === true && entry.version === manifest.version;
    const current = activeBuiltins.get(manifest.id);
    if (current && (!enabled || current.hash !== entry?.hash)) { current.dispose(); activeBuiltins.delete(manifest.id); }
    if (!enabled || !entry || activeBuiltins.has(manifest.id)) continue;
    const cleanups: (() => void)[] = [];
    if (manifest.id === 'helmsman.costs') cleanups.push(appPageModules.register(COSTS_PAGE_ID, costsPage));
    if (manifest.id === 'helmsman.helm') cleanups.push(appPageModules.register(HELM_PAGE_ID, helmPage));
    const panel = { 'helmsman.backlog': backlogPanel, 'helmsman.running': runningPanel, 'helmsman.recent': recentPanel,
      'helmsman.underway': underwayPanel, 'helmsman.newrun': newRunPanel, 'helmsman.repoprs': repoPrsPanel,
      'helmsman.shipped': shippedPanel, 'helmsman.activity': activityPanel }[manifest.id];
    if (panel) {
      cleanups.push(appPanels.registerModule(`${manifest.id}/panel`, panel));
      cleanups.push(appPanels.register(manifest));
    }
    cleanups.push(appPages.register(manifest));
    activeBuiltins.set(manifest.id, { hash: entry.hash, dispose: () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    } });
  }
}

export function disableBuiltinPageModules(): void {
  removeCostsModule();
  syncBuiltinFrontend([], true);
}
