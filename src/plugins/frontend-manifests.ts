import type { PluginManifest, PluginPageDefinition } from './sdk';

export const COSTS_PAGE_SLOT = 'helmsman/costs-page';
export const COSTS_PAGE_ID = 'helmsman.costs/page';
export const COSTS_PAGE_ALIAS = '/outcomes';
export const HELM_PAGE_SLOT = 'helmsman/helm-page';
export const HELM_PAGE_ID = 'helmsman.helm/page';
export const HELM_PAGE_ALIAS = '/helm';
export const HELM_PANEL_CONTRACT = 'helmsman/helm-panel';

export function supportsPageSlot(page: PluginPageDefinition, slot: string): boolean {
  return page.slots.includes(slot) && (slot !== HELM_PAGE_SLOT || page.composition?.id === HELM_PAGE_SLOT
    && page.composition.version === 1 && page.composition.accepts.some(contract => contract.id === HELM_PANEL_CONTRACT && contract.version === 1));
}

export const costsManifest: PluginManifest = {
  manifestVersion: 1, id: 'helmsman.costs', version: '0.1.0', sdkVersion: 1,
  pages: [{ id: 'page', title: 'Costs & Outcomes', slots: [COSTS_PAGE_SLOT], panes: ['summary', 'history'] }],
};

export const helmManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.helm', version: '0.1.0', sdkVersion: 1,
  pages: [{ id: 'page', title: 'Helm', slots: [HELM_PAGE_SLOT], panes: [],
    composition: { id: HELM_PAGE_SLOT, version: 1, accepts: [{ id: HELM_PANEL_CONTRACT, version: 1 }] },
    requires: [{ id: 'helmsman/composition', version: 1 }] }], panels: [],
};

export const backlogManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.backlog', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Backlog', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/task-read', version: 1 }, { id: 'helmsman/run-command', version: 1 }] }],
};

export const runningManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.running', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Running', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/run-read', version: 1 }, { id: 'helmsman/run-command', version: 1 }] }],
};
export const recentManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.recent', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Recent', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/run-read', version: 1 }, { id: 'helmsman/run-command', version: 1 }] }],
};

export const underwayManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.underway', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Underway', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/task-read', version: 1 }, { id: 'helmsman/run-command', version: 1 }] }],
};
export const newRunManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.newrun', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'New run', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/task-read', version: 1 }, { id: 'helmsman/run-command', version: 1 }] }],
};

export const repoPrsManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.repoprs', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Pull requests', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/pull-request-read', version: 1 }] }],
};
export const shippedManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.shipped', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Shipped', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/pull-request-read', version: 1 }] }],
};

export const activityManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.activity', version: '0.1.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Activity log', contract: { id: HELM_PANEL_CONTRACT, version: 1 },
    requires: [{ id: 'helmsman/task-read', version: 1 }, { id: 'helmsman/activity-read', version: 1 },
      { id: 'helmsman/pull-request-read', version: 1 }] }],
};

export const builtinFrontendManifests: readonly PluginManifest[] = Object.freeze([costsManifest, helmManifest, backlogManifest, runningManifest, recentManifest, underwayManifest, newRunManifest, repoPrsManifest, shippedManifest, activityManifest]);
