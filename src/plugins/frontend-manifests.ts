import costsPackage from './costs/plugin-package.json' with { type: 'json' };
import helmPackage from './helm/plugin-package.json' with { type: 'json' };
import backlogPackage from './backlog/plugin-package.json' with { type: 'json' };
import runningPackage from './running/plugin-package.json' with { type: 'json' };
import recentPackage from './recent/plugin-package.json' with { type: 'json' };
import underwayPackage from './underway/plugin-package.json' with { type: 'json' };
import newRunPackage from './newrun/plugin-package.json' with { type: 'json' };
import repoPrsPackage from './repoprs/plugin-package.json' with { type: 'json' };
import shippedPackage from './shipped/plugin-package.json' with { type: 'json' };
import activityPackage from './activity/plugin-package.json' with { type: 'json' };
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
import { builtinPageSlots } from './page-slots';
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

export const costsManifest = { ...costsPackage.manifest, id: 'helmsman.costs' } as PluginManifest;
export const helmManifest = helmPackage.manifest as PluginManifest;
export const backlogManifest = backlogPackage.manifest as PluginManifest;
export const runningManifest = runningPackage.manifest as PluginManifest;
export const recentManifest = recentPackage.manifest as PluginManifest;
export const underwayManifest = underwayPackage.manifest as PluginManifest;
export const newRunManifest = newRunPackage.manifest as PluginManifest;
export const repoPrsManifest = repoPrsPackage.manifest as PluginManifest;
export const shippedManifest = shippedPackage.manifest as PluginManifest;
export const activityManifest = activityPackage.manifest as PluginManifest;

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
