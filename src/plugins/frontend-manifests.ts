import executionSettingsPackage from './execution-settings/plugin-package.json' with { type: 'json' };
import productFeedbackPackage from './product-feedback/plugin-package.json' with { type: 'json' };
import profilePackage from './profile/plugin-package.json' with { type: 'json' };
import githubSettingsPackage from './github-settings/plugin-package.json' with { type: 'json' };
import jiraSettingsPackage from './jira-settings/plugin-package.json' with { type: 'json' };
import localGitPackage from './local-git/plugin-package.json' with { type: 'json' };
import campaignsPackage from './campaigns/plugin-package.json' with { type: 'json' };
import terminalPackage from './terminal/plugin-package.json' with { type: 'json' };
import communicationPackage from './communication/plugin-package.json' with { type: 'json' };
import type { PluginManifest, PluginPageDefinition } from './sdk';
import { builtinPageSlots, COSTS_PAGE_SLOT, HELM_PAGE_SLOT, HELM_PANEL_CONTRACT } from './page-slots';
export * from './page-slots';
import todosPackage from './todos-ui/plugin-package.json' with { type: 'json' };
import triagePackage from './triage/plugin-package.json' with { type: 'json' };
import bugsPackage from './bugs/plugin-package.json' with { type: 'json' };
import sourceSettingsPackage from './source-settings/plugin-package.json' with { type: 'json' };
import runViewerPackage from './run-viewer/plugin-package.json' with { type: 'json' };
import runHistoryPackage from './run-history/plugin-package.json' with { type: 'json' };
import compatibilityPrPackage from './compat-pr/plugin-package.json' with { type: 'json' };
import runsPackage from './runs/plugin-package.json' with { type: 'json' };
import clarificationsPackage from './clarifications/plugin-package.json' with { type: 'json' };
import compatibilityClarificationsPackage from './compat-clarifications/plugin-package.json' with { type: 'json' };
import suggestedContactsPackage from './suggested-contacts/plugin-package.json' with { type: 'json' };

export function supportsPageSlot(page: PluginPageDefinition, slot: string): boolean {
  const definition = builtinPageSlots.find(value => value.id === slot);
  return page.slots.includes(slot) && (!definition?.panelContract || page.composition?.id === slot
    && page.composition.version === 1 && page.composition.accepts.some(contract => contract.id === definition.panelContract && contract.version === 1));
}

export const costsManifest: PluginManifest = {
  manifestVersion: 1, id: 'helmsman.costs', version: '0.1.0', sdkVersion: 1,
  pages: [{ id: 'page', title: 'Costs & Outcomes', slots: [COSTS_PAGE_SLOT], panes: ['summary', 'history'] }],
};

export const helmManifest: PluginManifest = {
  manifestVersion: 2, id: 'helmsman.helm', version: '0.1.0', sdkVersion: 1,
  pages: [{ id: 'page', title: 'Helm', slots: [HELM_PAGE_SLOT], panes: [],
    composition: { id: HELM_PAGE_SLOT, version: 1, accepts: [{ id: HELM_PANEL_CONTRACT, version: 1 }],
      initialLayout: {
        instances: ['underway', 'newrun', 'backlog', 'running', 'repoprs', 'recent', 'activity', 'shipped'].map(instanceId =>
          ({ instanceId, contributionId: `helmsman.${instanceId}/panel` })),
        columns: [['underway', 'newrun', 'backlog', 'running', 'repoprs'], ['recent', 'activity', 'shipped']].map(column =>
          column.map(instanceId => ({ instances: [instanceId], activeInstanceId: instanceId, collapsed: false }))),
      } },
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

export const todosManifest = todosPackage.manifest as PluginManifest;
export const triageManifest = triagePackage.manifest as PluginManifest;
export const bugsManifest = bugsPackage.manifest as PluginManifest;
export const sourceSettingsManifest = sourceSettingsPackage.manifest as PluginManifest;

export const runViewerManifest = runViewerPackage.manifest as PluginManifest;
export const runHistoryManifest = runHistoryPackage.manifest as PluginManifest;
export const runsManifest = runsPackage.manifest as PluginManifest;
export const clarificationsManifest = clarificationsPackage.manifest as PluginManifest;
export const suggestedContactsManifest = suggestedContactsPackage.manifest as PluginManifest;
export const compatibilityClarificationsManifest = compatibilityClarificationsPackage.manifest as PluginManifest;

export const compatibilityPrManifest = compatibilityPrPackage.manifest as PluginManifest;

export const jiraSettingsManifest = jiraSettingsPackage.manifest as PluginManifest;
export const profileManifest = profilePackage.manifest as PluginManifest;
export const executionSettingsManifest = executionSettingsPackage.manifest as PluginManifest;
export const githubSettingsManifest = githubSettingsPackage.manifest as PluginManifest;
export const localGitManifest = localGitPackage.manifest as PluginManifest;
export const campaignsManifest = campaignsPackage.manifest as PluginManifest;
export const terminalManifest = terminalPackage.manifest as PluginManifest;
export const communicationManifest = communicationPackage.manifest as PluginManifest;

export const builtinFrontendManifests: readonly PluginManifest[] = Object.freeze([productFeedbackPackage.manifest as PluginManifest, profileManifest, executionSettingsManifest, githubSettingsManifest, jiraSettingsManifest, localGitManifest, campaignsManifest, terminalManifest, communicationManifest, runsManifest, compatibilityPrManifest, runViewerManifest, runHistoryManifest, clarificationsManifest, suggestedContactsManifest, compatibilityClarificationsManifest, todosManifest, triageManifest, bugsManifest, sourceSettingsManifest, costsManifest, helmManifest, backlogManifest, runningManifest, recentManifest, underwayManifest, newRunManifest, repoPrsManifest, shippedManifest, activityManifest]);
