import profileHeader from './profile/header';
import githubSettingsPage from './github-settings/page';
import githubSettingsPanel from './github-settings/panel';
import jiraSettingsPage from './jira-settings/page';
import jiraSettingsPanel from './jira-settings/panel';
import localGitPage from './local-git/page';
import localGitPanel from './local-git/panel';
import campaignsPage from './campaigns/page';
import campaignsPanel from './campaigns/panel';
import terminalPage from './terminal/page';
import terminalPanel from './terminal/panel';
import communicationPage from './communication/page';
import notificationHeader from './communication/header';
import notificationsPanel from './communication/notifications';
import communicationReviewPanel from './communication/review-request';
import communicationSettingsPanel from './communication/settings';
import compatibilityPrPage from './compat-pr/page';
import compatibilityPrPanel from './compat-pr/panel';
import compatibilityClarificationsPage from './compat-clarifications/page';
import clarificationsPage from './clarifications/page';
import clarificationsPanel from './clarifications/panel';
import suggestedContactsPanel from './suggested-contacts/panel';
import runViewerPage from './run-viewer/page';
import runViewerPanel from './run-viewer/panel';
import runHistoryPage from './run-history/page';
import runsPage from './runs/page';
import runHistoryPanel from './run-history/panel';
import { appPages, COSTS_PAGE_ID, builtinFrontendManifests, HELM_PAGE_ID, ensureBuiltinPageSlots } from './builtins';
import costsPage from './costs/page';
import todosPage from './todos-ui/page';
import todosPanel from './todos-ui/panel';
import triagePage from './triage/page';
import triagePanel from './triage/panel';
import bugsPage from './bugs/page';
import bugsPanel from './bugs/panel';
import sourceSettingsPage from './source-settings/page';
import sourceSettingsPanel from './source-settings/panel';
import automaticPanel from './source-settings/automatic';
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
    ensureBuiltinPageSlots(appPages);
  }
  for (const manifest of builtinFrontendManifests) {
    const entry = entries.find(entry => entry.id === manifest.id);
    const enabled = !safeMode && entry?.enabled === true && entry.version === manifest.version;
    const current = activeBuiltins.get(manifest.id);
    if (current && (!enabled || current.hash !== entry?.hash)) { current.dispose(); activeBuiltins.delete(manifest.id); }
    if (!enabled || !entry || activeBuiltins.has(manifest.id)) continue;
    const cleanups: (() => void)[] = [];
    if (manifest.id === 'helmsman.profile') cleanups.push(appPageModules.register('helmsman.profile/header', profileHeader));
    if (manifest.id === 'helmsman.costs') cleanups.push(appPageModules.register(COSTS_PAGE_ID, costsPage));
    if (manifest.id === 'helmsman.helm') cleanups.push(appPageModules.register(HELM_PAGE_ID, helmPage));
    const page = { 'helmsman.github-settings': githubSettingsPage, 'helmsman.jira-settings': jiraSettingsPage, 'helmsman.local-git': localGitPage, 'helmsman.campaigns': campaignsPage, 'helmsman.terminal': terminalPage, 'helmsman.communication': communicationPage, 'helmsman.runs': runsPage, 'helmsman.compat-pr': compatibilityPrPage, 'helmsman.clarifications': clarificationsPage, 'helmsman.compat-clarifications': compatibilityClarificationsPage, 'helmsman.run-viewer': runViewerPage, 'helmsman.run-history': runHistoryPage, 'helmsman.todos-ui': todosPage, 'helmsman.triage': triagePage, 'helmsman.bugs': bugsPage, 'helmsman.source-settings': sourceSettingsPage }[manifest.id];
    if (page) cleanups.push(appPageModules.register(`${manifest.id}/page`, page));
    const panel = { 'helmsman.github-settings': githubSettingsPanel, 'helmsman.jira-settings': jiraSettingsPanel, 'helmsman.local-git': localGitPanel, 'helmsman.campaigns': campaignsPanel, 'helmsman.terminal': terminalPanel, 'helmsman.compat-pr': compatibilityPrPanel, 'helmsman.clarifications': clarificationsPanel, 'helmsman.suggested-contacts': suggestedContactsPanel, 'helmsman.run-viewer': runViewerPanel, 'helmsman.run-history': runHistoryPanel, 'helmsman.todos-ui': todosPanel, 'helmsman.triage': triagePanel, 'helmsman.bugs': bugsPanel, 'helmsman.source-settings': sourceSettingsPanel, 'helmsman.backlog': backlogPanel, 'helmsman.running': runningPanel, 'helmsman.recent': recentPanel,
      'helmsman.underway': underwayPanel, 'helmsman.newrun': newRunPanel, 'helmsman.repoprs': repoPrsPanel,
      'helmsman.shipped': shippedPanel, 'helmsman.activity': activityPanel }[manifest.id];
    if (panel) {
      cleanups.push(appPanels.registerModule(`${manifest.id}/panel`, panel));
      cleanups.push(appPanels.register(manifest));
    }
    if (manifest.id === 'helmsman.communication') {
      cleanups.push(appPageModules.register('helmsman.communication/header', notificationHeader));
      cleanups.push(appPanels.registerModule('helmsman.communication/notifications', notificationsPanel));
      cleanups.push(appPanels.registerModule('helmsman.communication/review-request', communicationReviewPanel));
      cleanups.push(appPanels.registerModule('helmsman.communication/settings', communicationSettingsPanel));
      cleanups.push(appPanels.register(manifest));
    }
    if (manifest.id === 'helmsman.source-settings') cleanups.push(appPanels.registerModule('helmsman.source-settings/automatic', automaticPanel));
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
