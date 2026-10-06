import { appPages, COSTS_PAGE_ID, builtinFrontendManifests, HELM_PAGE_ID, ensureBuiltinPageSlots } from './builtins';
import { PluginPageModules } from './modules';
import { appPanels } from './panels';
import type { BuiltinFrontendCatalogEntry } from './runtime';
import { lazyPageModule, lazyPanelModule } from './lazy-modules';
import { attention } from './clarifications/attention';

const executionSettingsPage = lazyPageModule(() => import('./execution-settings/page'));
const executionSettingsPanel = lazyPanelModule(() => import('./execution-settings/panel'));
const productFeedbackFooter = lazyPageModule(() => import('./product-feedback/footer'));
const productFeedbackPage = lazyPageModule(() => import('./product-feedback/page'));
const feedbackSettingsPage = lazyPageModule(() => import('./product-feedback/settings'));
const profileHeader = lazyPageModule(() => import('./profile/header'));
const githubSettingsPage = lazyPageModule(() => import('./github-settings/page'));
const githubSettingsPanel = lazyPanelModule(() => import('./github-settings/panel'));
const jiraSettingsPage = lazyPageModule(() => import('./jira-settings/page'));
const jiraSettingsPanel = lazyPanelModule(() => import('./jira-settings/panel'));
const localGitPage = lazyPageModule(() => import('./local-git/page'));
const localGitPanel = lazyPanelModule(() => import('./local-git/panel'));
const campaignsPage = lazyPageModule(() => import('./campaigns/page'));
const campaignsPanel = lazyPanelModule(() => import('./campaigns/panel'));
const terminalPage = lazyPageModule(() => import('./terminal/page'));
const terminalPanel = lazyPanelModule(() => import('./terminal/panel'));
const communicationPage = lazyPageModule(() => import('./communication/page'));
const notificationHeader = lazyPageModule(() => import('./communication/header'));
const notificationsPanel = lazyPanelModule(() => import('./communication/notifications'));
const communicationReviewPanel = lazyPanelModule(() => import('./communication/review-request'));
const communicationSettingsPanel = lazyPanelModule(() => import('./communication/settings'));
const compatibilityPrPage = lazyPageModule(() => import('./compat-pr/page'));
const compatibilityPrPanel = lazyPanelModule(() => import('./compat-pr/panel'));
const compatibilityClarificationsPage = lazyPageModule(() => import('./compat-clarifications/page'));
const clarificationsPage = lazyPageModule(() => import('./clarifications/page'), attention);
const clarificationsPanel = lazyPanelModule(() => import('./clarifications/panel'));
const suggestedContactsPanel = lazyPanelModule(() => import('./suggested-contacts/panel'));
const runViewerPage = lazyPageModule(() => import('./run-viewer/page'));
const runViewerPanel = lazyPanelModule(() => import('./run-viewer/panel'));
const runHistoryPage = lazyPageModule(() => import('./run-history/page'));
const runsPage = lazyPageModule(() => import('./runs/page'));
const runHistoryPanel = lazyPanelModule(() => import('./run-history/panel'));
const costsPage = lazyPageModule(() => import('./costs/page'));
const todosPage = lazyPageModule(() => import('./todos-ui/page'));
const todosPanel = lazyPanelModule(() => import('./todos-ui/panel'));
const triagePage = lazyPageModule(() => import('./triage/page'));
const triagePanel = lazyPanelModule(() => import('./triage/panel'));
const bugsPage = lazyPageModule(() => import('./bugs/page'));
const bugsPanel = lazyPanelModule(() => import('./bugs/panel'));
const sourceSettingsPage = lazyPageModule(() => import('./source-settings/page'));
const sourceSettingsPanel = lazyPanelModule(() => import('./source-settings/panel'));
const automaticPanel = lazyPanelModule(() => import('./source-settings/automatic'));
const helmPage = lazyPageModule(() => import('./helm/page'));
const backlogPanel = lazyPanelModule(() => import('./backlog/panel'));
const runningPanel = lazyPanelModule(() => import('./running/panel'));
const recentPanel = lazyPanelModule(() => import('./recent/panel'));
const underwayPanel = lazyPanelModule(() => import('./underway/panel'));
const newRunPanel = lazyPanelModule(() => import('./newrun/panel'));
const repoPrsPanel = lazyPanelModule(() => import('./repoprs/panel'));
const shippedPanel = lazyPanelModule(() => import('./shipped/panel'));
const activityPanel = lazyPanelModule(() => import('./activity/panel'));

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
    if (manifest.id === 'helmsman.product-feedback') { cleanups.push(appPageModules.register('helmsman.product-feedback/footer', productFeedbackFooter)); cleanups.push(appPageModules.register('helmsman.product-feedback/page', productFeedbackPage)); cleanups.push(appPageModules.register('helmsman.product-feedback/settings', feedbackSettingsPage)); }
    if (manifest.id === 'helmsman.profile') cleanups.push(appPageModules.register('helmsman.profile/header', profileHeader));
    if (manifest.id === 'helmsman.costs') cleanups.push(appPageModules.register(COSTS_PAGE_ID, costsPage));
    if (manifest.id === 'helmsman.helm') cleanups.push(appPageModules.register(HELM_PAGE_ID, helmPage));
    const page = { 'helmsman.execution-settings': executionSettingsPage, 'helmsman.github-settings': githubSettingsPage, 'helmsman.jira-settings': jiraSettingsPage, 'helmsman.local-git': localGitPage, 'helmsman.campaigns': campaignsPage, 'helmsman.terminal': terminalPage, 'helmsman.communication': communicationPage, 'helmsman.runs': runsPage, 'helmsman.compat-pr': compatibilityPrPage, 'helmsman.clarifications': clarificationsPage, 'helmsman.compat-clarifications': compatibilityClarificationsPage, 'helmsman.run-viewer': runViewerPage, 'helmsman.run-history': runHistoryPage, 'helmsman.todos-ui': todosPage, 'helmsman.triage': triagePage, 'helmsman.bugs': bugsPage, 'helmsman.source-settings': sourceSettingsPage }[manifest.id];
    if (page) cleanups.push(appPageModules.register(`${manifest.id}/page`, page));
    const panel = { 'helmsman.execution-settings': executionSettingsPanel, 'helmsman.github-settings': githubSettingsPanel, 'helmsman.jira-settings': jiraSettingsPanel, 'helmsman.local-git': localGitPanel, 'helmsman.campaigns': campaignsPanel, 'helmsman.terminal': terminalPanel, 'helmsman.compat-pr': compatibilityPrPanel, 'helmsman.clarifications': clarificationsPanel, 'helmsman.suggested-contacts': suggestedContactsPanel, 'helmsman.run-viewer': runViewerPanel, 'helmsman.run-history': runHistoryPanel, 'helmsman.todos-ui': todosPanel, 'helmsman.triage': triagePanel, 'helmsman.bugs': bugsPanel, 'helmsman.source-settings': sourceSettingsPanel, 'helmsman.backlog': backlogPanel, 'helmsman.running': runningPanel, 'helmsman.recent': recentPanel,
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
