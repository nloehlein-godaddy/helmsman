import type { PageSlot } from './sdk';

export const COSTS_PAGE_SLOT = 'helmsman/costs-page';
export const COSTS_PAGE_ID = 'helmsman.costs/page';
export const COSTS_PAGE_ALIAS = '/outcomes';
export const HELM_PAGE_SLOT = 'helmsman/helm-page';
export const HELM_PAGE_ID = 'helmsman.helm/page';
export const HELM_PAGE_ALIAS = '/helm';
export const HELM_PANEL_CONTRACT = 'helmsman/helm-panel';

export const TODOS_PAGE_SLOT = 'helmsman/todos-page';
export const TODOS_PAGE_ID = 'helmsman.todos-ui/page';
export const TODOS_PAGE_ALIAS = '/todos';
export const TODOS_PANEL_CONTRACT = 'helmsman/todos-panel';
export const TRIAGE_PAGE_SLOT = 'helmsman/triage-page';
export const TRIAGE_PAGE_ID = 'helmsman.triage/page';
export const TRIAGE_PAGE_ALIAS = '/triage';
export const TRIAGE_PANEL_CONTRACT = 'helmsman/triage-panel';
export const BUGS_PAGE_SLOT = 'helmsman/bugs-page';
export const BUGS_PAGE_ID = 'helmsman.bugs/page';
export const BUGS_PAGE_ALIAS = '/bugs';
export const BUGS_PANEL_CONTRACT = 'helmsman/bugs-panel';
export const SOURCE_SETTINGS_PAGE_SLOT = 'helmsman/source-settings-page';
export const SOURCE_SETTINGS_PAGE_ID = 'helmsman.source-settings/page';
export const SOURCE_SETTINGS_PAGE_ALIAS = '/source-settings';
export const SOURCE_SETTINGS_PANEL_CONTRACT = 'helmsman/source-settings-panel';
export const AGENTS_OVERVIEW_PAGE_SLOT = 'helmsman/agents-overview-page';
export const AGENTS_OVERVIEW_PAGE_ID = 'helmsman.agents-overview/page';

export const CLARIFICATIONS_PAGE_SLOT = 'helmsman/clarifications-page';
export const CLARIFICATIONS_PAGE_ID = 'helmsman.clarifications/page';
export const CLARIFICATIONS_PAGE_ALIAS = '/clarifications';
export const CLARIFICATIONS_PANEL_CONTRACT = 'helmsman/clarifications-panel';

export const RUN_VIEWER_PAGE_SLOT = 'helmsman/run-viewer-page';
export const RUN_VIEWER_PAGE_ID = 'helmsman.run-viewer/page';
export const RUN_HISTORY_PAGE_SLOT = 'helmsman/run-history-page';
export const RUN_HISTORY_PAGE_ID = 'helmsman.run-history/page';
export const RUNS_PAGE_SLOT = 'helmsman/runs-page';
export const RUNS_PAGE_ID = 'helmsman.runs/page';
export const PR_PAGE_SLOT = 'helmsman/pr-compatibility-page';
export const PR_PAGE_ID = 'helmsman.compat-pr/page';

export const JIRA_SETTINGS_PAGE_SLOT = 'helmsman/jira-settings-page';
export const JIRA_SETTINGS_PAGE_ID = 'helmsman.jira-settings/page';

export const GITHUB_SETTINGS_PAGE_SLOT = 'helmsman/github-settings-page';
export const GITHUB_SETTINGS_PAGE_ID = 'helmsman.github-settings/page';

export const LOCAL_GIT_PAGE_SLOT = 'helmsman/local-git-page';
export const LOCAL_GIT_PAGE_ID = 'helmsman.local-git/page';

export const CAMPAIGNS_PAGE_SLOT = 'helmsman/campaigns-page';
export const CAMPAIGNS_PAGE_ID = 'helmsman.campaigns/page';

export const TERMINAL_PAGE_SLOT = 'helmsman/terminal-page';
export const TERMINAL_PAGE_ID = 'helmsman.terminal/page';

export const COMMUNICATION_PAGE_SLOT = 'helmsman/communication-page';
export const COMMUNICATION_PAGE_ID = 'helmsman.communication/page';
export const PROFILE_HEADER_SLOT = 'helmsman/profile-header';

export const NOTIFICATION_HEADER_SLOT = 'helmsman/notification-header';

export const PRODUCT_FEEDBACK_FOOTER_SLOT = 'helmsman/product-feedback-footer';

interface BuiltinPageSlot extends PageSlot {
  readonly panelContract?: string;
}

export const builtinPageSlots: readonly BuiltinPageSlot[] = Object.freeze([
  Object.freeze({ id: PRODUCT_FEEDBACK_FOOTER_SLOT, alias: '/feedback-entry', defaultContributionId: 'helmsman.product-feedback/footer' }),
  Object.freeze({ id: 'helmsman/product-feedback-page', alias: '/product-feedback', defaultContributionId: 'helmsman.product-feedback/page' }),
  Object.freeze({ id: 'helmsman/feedback-settings-page', alias: '/feedback-settings', defaultContributionId: 'helmsman.product-feedback/settings' }),
  Object.freeze({ id: PROFILE_HEADER_SLOT, alias: '/profile', defaultContributionId: 'helmsman.profile/header' }),
  Object.freeze({ id: 'helmsman/agent-prompts-page', alias: '/agent-prompts', defaultContributionId: 'helmsman.agent-prompts/page', panelContract: 'helmsman/agent-prompts-panel' }),
  Object.freeze({ id: AGENTS_OVERVIEW_PAGE_SLOT, alias: '/agents-overview', defaultContributionId: AGENTS_OVERVIEW_PAGE_ID }),
  Object.freeze({ id: 'helmsman/execution-settings-page', alias: '/execution-settings', defaultContributionId: 'helmsman.execution-settings/page', panelContract: 'helmsman/execution-settings-panel' }),
  Object.freeze({ id: GITHUB_SETTINGS_PAGE_SLOT, alias: '/github-settings', defaultContributionId: GITHUB_SETTINGS_PAGE_ID, panelContract: 'helmsman/github-settings-panel' }),
  Object.freeze({ id: JIRA_SETTINGS_PAGE_SLOT, alias: '/jira-settings', defaultContributionId: JIRA_SETTINGS_PAGE_ID, panelContract: 'helmsman/jira-settings-panel' }),
  Object.freeze({ id: LOCAL_GIT_PAGE_SLOT, alias: '/local-git', defaultContributionId: LOCAL_GIT_PAGE_ID, panelContract: 'helmsman/local-git-panel' }),
  Object.freeze({ id: CAMPAIGNS_PAGE_SLOT, alias: '/campaigns', defaultContributionId: CAMPAIGNS_PAGE_ID, panelContract: 'helmsman/campaigns-panel' }),
  Object.freeze({ id: TERMINAL_PAGE_SLOT, alias: '/terminal', aliases: Object.freeze(['/cmux']), defaultContributionId: TERMINAL_PAGE_ID, panelContract: 'helmsman/terminal-panel' }),
  Object.freeze({ id: COMMUNICATION_PAGE_SLOT, alias: '/communication', defaultContributionId: COMMUNICATION_PAGE_ID, panelContract: 'helmsman/communication-panel' }),
  Object.freeze({ id: NOTIFICATION_HEADER_SLOT, alias: '/notifications', defaultContributionId: 'helmsman.communication/header' }),
  Object.freeze({ id: PR_PAGE_SLOT, alias: '/prs', aliases: Object.freeze(['/pr']), defaultContributionId: PR_PAGE_ID, panelContract: 'helmsman/pull-request-panel' }),
  Object.freeze({ id: RUNS_PAGE_SLOT, alias: '/runs', defaultContributionId: RUNS_PAGE_ID, panelContract: 'helmsman/run-history-panel' }),
  Object.freeze({ id: CLARIFICATIONS_PAGE_SLOT, alias: CLARIFICATIONS_PAGE_ALIAS, defaultContributionId: CLARIFICATIONS_PAGE_ID, panelContract: CLARIFICATIONS_PANEL_CONTRACT }),
  Object.freeze({ id: RUN_VIEWER_PAGE_SLOT, alias: '/run-viewer', defaultContributionId: RUN_VIEWER_PAGE_ID, panelContract: 'helmsman/run-viewer-panel' }),
  Object.freeze({ id: RUN_HISTORY_PAGE_SLOT, alias: '/run-history', defaultContributionId: RUN_HISTORY_PAGE_ID, panelContract: 'helmsman/run-history-panel' }),
  Object.freeze({ id: TODOS_PAGE_SLOT, alias: TODOS_PAGE_ALIAS, defaultContributionId: TODOS_PAGE_ID, panelContract: TODOS_PANEL_CONTRACT }),
  Object.freeze({ id: TRIAGE_PAGE_SLOT, alias: TRIAGE_PAGE_ALIAS, defaultContributionId: TRIAGE_PAGE_ID, panelContract: TRIAGE_PANEL_CONTRACT }),
  Object.freeze({ id: BUGS_PAGE_SLOT, alias: BUGS_PAGE_ALIAS, defaultContributionId: BUGS_PAGE_ID, panelContract: BUGS_PANEL_CONTRACT }),
  Object.freeze({ id: SOURCE_SETTINGS_PAGE_SLOT, alias: SOURCE_SETTINGS_PAGE_ALIAS, defaultContributionId: SOURCE_SETTINGS_PAGE_ID, panelContract: SOURCE_SETTINGS_PANEL_CONTRACT }),
  Object.freeze({ id: COSTS_PAGE_SLOT, alias: COSTS_PAGE_ALIAS, defaultContributionId: COSTS_PAGE_ID }),
  Object.freeze({ id: HELM_PAGE_SLOT, alias: HELM_PAGE_ALIAS, aliases: Object.freeze(['/']),
    defaultContributionId: HELM_PAGE_ID, panelContract: HELM_PANEL_CONTRACT }),
]);

export function isBuiltinPageSlot(id: string): boolean {
  return builtinPageSlots.some(slot => slot.id === id);
}
