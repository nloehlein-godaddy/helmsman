import { term, isPirateMode, TERMINOLOGY, TERMINOLOGY_REFERENCE_KEYS } from './logic/terminology';
import { renderThemePreview } from './renderThemePreview';
import { routeHref, type PageView } from './logic/routes';
import { appPages, COSTS_PAGE_ID, COSTS_PAGE_SLOT, builtinPageSlots, SOURCE_SETTINGS_PAGE_SLOT } from './plugins/builtins';
import { escapeHtml as esc } from './logic/html';
import { PRE_PR_CONFIG_KEYS, PRE_PR_SETTING_DEFINITIONS } from './logic/prePrSettings';

import type { UiConfig } from './data/config';
import { THEMES } from './data/themes';


export const CONFIG_HELP: Record<string, string> = {
  get JIRA_ENABLED() { return 'Initial Jira source enablement. Example: true. Manage existing sources in Task sources.'; },
  GITHUB_REVIEW_WATCH_ENABLED: 'Automatically review GitHub PRs requesting your review every five minutes: true or false. Changes apply immediately. Example: true',
  AGENT_ADAPTER: "Which agent runs tasks: 'codex' (default), 'claude-code', or 'command' (runs your custom AGENT_CMD). Example: codex",
  AGENT_CMD: 'Shell command for the "command" adapter, run no-shell (argv only). Placeholders {ticket} {repo} {title} are substituted, then it receives the task prompt. Example: my-agent --repo {repo} --ticket {ticket}',
  get AGENT_MAX_ATTEMPTS() { return `Total attempts for existing-PR ${term('runs').toLowerCase()}, including the initial attempt. New coding ${term('runs').toLowerCase()} use the separate pre-PR review rounds. Example: 1`; },
  get AGENT_MAX_COST_USD() { return `Per-${term('run').toLowerCase()} spend ceiling in USD; the ${term('run').toLowerCase()} stops once exceeded. Blank means no cap. Example: 5.00`; },
  PRE_PR_REVIEWER_COUNT: 'Independent reviewer sessions per round: 1 uses the writer\'s CLI; 2 also uses the other supported CLI when installed. An installed reviewer that fails blocks publication. Example: 2',
  PRE_PR_MAX_ROUNDS: 'Maximum review rounds, including the initial review. Each additional round allows fixes followed by every reviewer reviewing again. Unresolved findings block the PR. Example: 3',
  PRE_PR_STAGE_TIMEOUT_MINUTES: 'Time limit in minutes for each implementation, fix, or reviewer session. A timed-out session blocks publication and retains the worktree. Example: 45',
  AUTO_CLAIM_INTERVAL_MS: 'How often (milliseconds) the auto-claim scheduler polls for backlog tickets. Interval changes apply on restart. Example: 60000',
  get REPO_PROJECT_MAP() { return `Comma-separated ${term('repository').toLowerCase()}=jiraProject pairs, mapping each ${term('repository').toLowerCase()} to the Jira project its tickets live in. Example: gdcorp-partners/airo-app-builder=AIROBUILD,gdcorp-enm/conversations-web=LEKA`; },
  get JIRA_PROJECT() { return `Default Jira project for All ${term('repositories').toLowerCase()}. Map individual ${term('repositories').toLowerCase()} with REPO_PROJECT_MAP. Example: AIROBUILD`; },
  JIRA_ASSIGNEE: 'Jira account that claimed tickets are assigned to — currentUser() or an accountId. Example: currentUser()',
  JIRA_JQL: 'Optional JQL filter that narrows which tickets appear in the backlog queue. Example: labels = agent-ready AND priority >= High',
  get GITHUB_REPO() { return `Default ${term('repository').toLowerCase()} (owner/name) used for GitHub PR lookups when none is otherwise provided. Example: gdcorp-partners/airo-app-builder`; },
  get GITHUB_PR_AUTHOR() { return `GitHub username whose authored PRs populate the ${term('shipped')} and ${term('activity')} panels. Example: nloehlein-godaddy`; },
};

const ICON_LOCK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V5.1a2.5 2.5 0 0 1 5 0V7"/></svg>'

const ICON_PIRATE_FLAG = '<svg viewBox="0 0 36 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 4v32M5 8c9-7 17 7 26 0v21c-9 7-17-7-26 0"/><path d="M17 11.5c-3 0-4.5 1.8-4.5 4.2 0 1.5.8 2.8 2.1 3.4v2h4.8v-2c1.3-.6 2.1-1.9 2.1-3.4 0-2.4-1.5-4.2-4.5-4.2Z"/><circle cx="15.1" cy="16" r=".7" fill="currentColor" stroke="none"/><circle cx="18.9" cy="16" r=".7" fill="currentColor" stroke="none"/><path d="m16.2 18.5.8-1 .8 1M17 19.8v1.3m-5 2.1 10 4m0-4-10 4m-1-4.7 1 .7-.3 1.1m10.3 2.2 1 .7-.3 1.1m-.7-5.8-1 .7.3 1.1m-10.3 2.2-1 .7.3 1.1"/></svg>';

const ICON_INFO: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.5" fill="currentColor" stroke="none"/></svg>'

const HELM_EMBLEM: string =
  '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><use href="/helm-emblem.svg#helm-emblem" /></svg>';

function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo
}

export type { PageView } from './logic/routes';

const PAGE_TABS: { view: PageView; label: string }[] = [
  { view: 'dashboard', get label() { return term('dashboard'); } },
  { view: 'prs', get label() { return term('prs'); } },
  { view: 'triage', label: 'Triage' },
  { view: 'todos', label: 'Todos' },
  { view: 'cmux', label: 'Terminal' },
  { view: 'bugs', label: 'Bugs' },
  { view: 'runs', get label() { return term('runs'); } },
  { view: 'campaigns', get label() { return term('campaigns'); } },
  { view: 'clarifications', get label() { return term('clarifications'); } },
  { view: 'config', label: 'Config' },
];

export interface HelmHeadOpts {
  greetingName?: string | null;
  active: PageView;
  jiraEnabled?: boolean;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  pluginPage?: string;
  pluginSlot?: string;
  readout: { running: number | null; queued: number | null; review: number | null } | null;
}

function pageTabs(opts: HelmHeadOpts) {
  const tabs = PAGE_TABS.map(t => {
    const href = routeHref({ view: t.view, repo: opts.selectedRepo });
    const slot = builtinPageSlots.find(value => value.alias === href.split('?')[0]);
    const selected = slot ? appPages.selected(slot.id) : null;
    return { ...t, id: `page-tab-${t.view}`,
      label: selected?.page && selected.contributionId !== slot?.defaultContributionId ? selected.page.title : t.label,
      active: t.view === opts.active || !!slot && (opts.pluginSlot === slot.id || !!opts.pluginPage && opts.pluginPage === selected?.contributionId), href };
  });
  const costs = appPages.selected(COSTS_PAGE_SLOT);
  const costsActive = opts.pluginSlot === COSTS_PAGE_SLOT || opts.pluginPage === costs.contributionId
    || opts.active === 'outcomes' && !opts.pluginPage && costs.page?.contributionId === COSTS_PAGE_ID;
  const costsTab = {
    id: 'page-tab-outcomes', view: costs.page?.contributionId === COSTS_PAGE_ID ? 'outcomes' as const : 'plugin' as const,
    label: costs.page?.contributionId === COSTS_PAGE_ID ? term('costsOutcomes') : costs.page?.title ?? term('costsOutcomes'),
    active: costsActive, href: routeHref({ view: 'outcomes', repo: opts.selectedRepo }),
  };
  const campaignsIndex = tabs.findIndex(tab => tab.view === 'campaigns');
  tabs.splice(campaignsIndex < 0 ? tabs.length : campaignsIndex, 0, costsTab);
  if ((opts.active === 'plugin' || opts.active === 'outcomes') && !costsActive && !tabs.some(tab => tab.active)) {
    const page = opts.pluginPage ? appPages.getPage(opts.pluginPage) : null;
    tabs.push({ id: 'page-tab-plugin', view: opts.active, active: true,
      label: page?.contributionId === COSTS_PAGE_ID ? term('costsOutcomes') : page?.title ?? term('unavailablePluginPage'),
      href: routeHref({ view: opts.active, repo: opts.selectedRepo, pluginPage: opts.pluginPage }),
    });
  }
  return tabs;
}

export function activePageTabId(opts: HelmHeadOpts): string {
  return pageTabs(opts).find(tab => tab.active)?.id ?? `page-tab-${opts.active}`;
}

export function renderHelmHead(opts: HelmHeadOpts): string {
  const sorted: string[] = [...new Set([...opts.repos, ...(opts.selectedRepo ? [opts.selectedRepo] : [])])]
    .sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));
  const scopeOptions: string = [`<option value="">${term('allRepositories')}</option>`]
    .concat(
      sorted.map(
        (repo) => `<option value="${esc(repo)}"${repo === opts.selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');
  const tabs: string = pageTabs(opts).map(
    (t) =>
      `<a class="page-tab view-toggle${t.active ? ' is-active' : ''}" href="${esc(t.href)}" data-view="${t.view}" role="tab" id="${t.id}" aria-selected="${t.active}" aria-controls="page-content" tabindex="${t.active ? 0 : -1}"${t.active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`,
  ).join('');
  const readout = `<div class="helm-readout mono" aria-label="${term('systemStatus')}">
    ${(['running', 'queued', 'review'] as const).map((key) => {
      const value = opts.readout?.[key];
      const known = typeof value === 'number' && Number.isFinite(value);
      const label = key === 'running' ? term('running').toLowerCase() : key === 'queued' ? 'queue' : term('review').toLowerCase();
      return `<span class="seg"><b class="seg7" data-fleet-count="${key}"${known ? '' : ` title="Not loaded for this ${term('repository').toLowerCase()}"`}>${known ? value : '—'}</b> <span data-readout-label="${key}">${label}</span></span>`;
    }).join('')}
  </div>`;
  return `
    <header class="helm-head">
      <div class="nameplate">
        <span class="nameplate-mark" aria-hidden="true">${HELM_EMBLEM}</span>
        <div class="nameplate-scope">
          <span class="nameplate-name">Helmsman <span class="nameplate-alpha">Alpha</span></span>
          <select class="repo-select" aria-label="${term('scopeByRepository')}">${scopeOptions}</select>
          <span class="helm-greeting" data-greeting>${term('greeting')}${typeof opts.greetingName === 'string' && opts.greetingName.trim() ? `, ${esc(opts.greetingName.trim())}` : ''}!</span>
        </div>
      </div>
      ${readout}
      <div class="helm-controls">
        <span class="lamp lamp-live is-pulsing" role="img" aria-label="Live">LIVE</span>
      </div>
    </header>
    <nav class="page-tabs" role="tablist" aria-label="Views">${tabs}</nav>`;
}

export function renderAppShell(opts: HelmHeadOpts, content: string): string {
  const running = opts.readout?.running ?? '—';
  return `<div class="helm${opts.active === 'dashboard' ? '' : ` ${opts.active}-view`}" data-page="${opts.active}">
    ${renderHelmHead(opts)}
    <main class="page-content" id="page-content" role="tabpanel" aria-labelledby="${activePageTabId(opts)}" tabindex="0">${content}</main>
    <footer class="app-footer mono">
      <div class="operator-note">${ICON_LOCK}<span>${term('operatorNote')}</span></div>
      <div class="footer-meta">
        <a data-recovery-link href="/recovery${opts.selectedRepo ? `?repo=${encodeURIComponent(opts.selectedRepo)}` : ''}">${term('recovery')}</a>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span class="footer-attr">nloehlein@godaddy.com</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>Helmsman v${esc(__APP_VERSION__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>updated ${esc(__BUILD_DATE__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-repos>${opts.repos.length} ${term(opts.repos.length === 1 ? 'repository' : 'repositories').toLowerCase()} tracked</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-running>${running} ${term('running').toLowerCase()}</span>
      </div>
      <button class="pirate-mode-toggle" type="button" data-pirate-mode aria-label="Pirate mode" aria-pressed="${isPirateMode()}" title="Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}">${ICON_PIRATE_FLAG}</button>
    </footer>
  </div>`;
}

export interface ConfigViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  loading?: boolean;
  error?: string | null;
  unavailable?: boolean;
}

function configRowsHtml(uiConfig: UiConfig): string {
  const entries: [string, unknown][] = Object.entries(uiConfig.config ?? {})
    .filter(([key]) => key !== 'JIRA_ENABLED' && !key.startsWith('SLACK_') && !PRE_PR_CONFIG_KEYS.some((reviewKey) => reviewKey === key));
  if (entries.length === 0) return '<div class="empty-note">No configuration keys.</div>';
  return entries
    .map(([key, value]) => {
      const isOverridden: boolean = (uiConfig.overridden ?? []).includes(key);
      const help: string = CONFIG_HELP[key] ?? '';
      const hint: string = help
        ? ` <span class="config-hint" tabindex="0" role="img" aria-label="${esc(help)}" title="${esc(help)}">${ICON_INFO}</span>`
        : '';
      return `
      <div class="config-row" data-key="${esc(key)}"${help ? ` title="${esc(help)}"` : ''}>
        <label class="config-key mono" for="config-${esc(encodeURIComponent(key))}">${esc(key)}${isOverridden ? ' <span class="config-overridden">(saved override)</span>' : ''}${hint}</label>
        <input id="config-${esc(encodeURIComponent(key))}" class="config-input" type="text" value="${esc(String(value ?? ''))}" aria-describedby="${help ? `help-${esc(encodeURIComponent(key))} ` : ''}error-${esc(encodeURIComponent(key))}">
        <button type="button" class="config-save" data-key="${esc(key)}" aria-label="Save ${esc(key)}">Save</button>
        <span class="config-error" id="error-${esc(encodeURIComponent(key))}" role="alert"></span>
        ${help ? `<span class="sr-only" id="help-${esc(encodeURIComponent(key))}">${esc(help)}</span>` : ''}
      </div>`;
    })
    .join('');
}

function prePrConfigPanel(uiConfig: UiConfig): string {
  const labels = {
    reviewerCount: 'Reviewers per round',
    maxRounds: 'Maximum review rounds',
    stageTimeoutMinutes: 'Session timeout (minutes)',
  };
  const rows = PRE_PR_SETTING_DEFINITIONS.map(({ key, envKey, defaultValue, min, max }) => {
    const value = uiConfig.config?.[envKey] ?? defaultValue;
    const isOverridden = uiConfig.overridden?.includes(envKey) ?? false;
    return `
      <div class="config-row" data-key="${envKey}">
        <label class="config-key" for="config-${envKey}">${labels[key]}${isOverridden ? ' <span class="config-overridden">(overridden)</span>' : ''}</label>
        <input id="config-${envKey}" class="config-input" type="number" min="${min}" max="${max}" step="1" required value="${esc(String(value))}" aria-describedby="help-${envKey} error-${envKey}">
        <button type="button" class="config-save" data-key="${envKey}" aria-label="Save ${labels[key]}">Save</button>
        <span class="config-error" id="error-${envKey}" role="alert"></span>
      </div>
      <div class="config-warning" id="help-${envKey}">${esc(CONFIG_HELP[envKey] ?? '')} Range: ${min}–${max}; default: ${defaultValue}. <span class="mono">${envKey}</span></div>`;
  }).join('');
  return `
      <section class="panel config-panel pre-pr-config-panel" aria-labelledby="pre-pr-config-title">
        <div class="panel-head"><span class="panel-title" id="pre-pr-config-title">Pre-${term('pr')} ${term('review').toLowerCase()}</span></div>
        <div class="config-warning">Adversarial ${term('reviews').toLowerCase()} run before a new coding ${term('run').toLowerCase()} publishes its ${term('pr')}. Every reviewer must approve the final commit. Changes apply to newly launched ${term('runs').toLowerCase()}; active ${term('runs').toLowerCase()} keep their settings. Supported CLIs: Codex and Claude Code. With only one installed, one reviewer runs.</div>
        <div class="config-list">${rows}</div>
      </section>`;
}

function jiraTokenRowHtml(tokenSet: boolean): string {
  const status: string = tokenSet
    ? '<span class="config-secret-status is-set">set ✓</span>'
    : '<span class="config-secret-status is-unset">not set</span>';
  return `
      <div class="config-row config-secret-row" data-key="JIRA_API_TOKEN">
        <label class="config-key mono" for="config-JIRA_API_TOKEN">JIRA_API_TOKEN ${status}<span class="config-hint" tabindex="0" role="img" aria-label="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed." title="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed.">${ICON_INFO}</span></label>
        <input id="config-JIRA_API_TOKEN" class="config-input config-secret-input" type="password" autocomplete="off" placeholder="Paste new token to update" aria-describedby="help-JIRA_API_TOKEN error-JIRA_API_TOKEN">
        <button type="button" class="config-save" data-key="JIRA_API_TOKEN" aria-label="Update Jira API token">Update</button>
        <span class="config-error" id="error-JIRA_API_TOKEN" role="alert"></span>
        <span class="sr-only" id="help-JIRA_API_TOKEN">Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed.</span>
      </div>`;
}

function configCustomizationPanel(themeId: string): string {
  const themeOptions = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');
  return `      <section class="panel config-panel ui-customization-panel" aria-labelledby="ui-customization-title">
        <div class="panel-head"><span class="panel-title" id="ui-customization-title">UI customization</span></div>
        <div class="ui-customization-body">
          <p id="pirate-mode-help">Toggle Pirate mode with the flag at the bottom-right of every page. The preference is saved in this browser; your content stays unchanged.</p>
          <details class="terminology-reference"><summary>Terminology reference</summary><table><thead><tr><th scope="col">Plain</th><th scope="col">Pirate</th></tr></thead><tbody>${TERMINOLOGY_REFERENCE_KEYS.map(key => TERMINOLOGY[key]).map(({ plain, pirate }) => `<tr><td>${esc(plain)}</td><td>${esc(pirate)}</td></tr>`).join('')}</tbody></table></details>
          <label for="ui-theme">Theme</label>
          <select id="ui-theme" class="theme-select" aria-describedby="ui-theme-help">${themeOptions}</select>
          <p id="ui-theme-help">Applies immediately and is saved in this browser.</p>
          ${renderThemePreview()}
        </div>
      </section>`;
}

export function renderConfigView(uiConfig: UiConfig, opts: ConfigViewOpts): string {
  const customization = configCustomizationPanel(opts.themeId);
  const sources = `<section class="panel config-panel"><h2>Task sources</h2><p><a href="${esc(routeHref({ view: 'plugin', pluginSlot: SOURCE_SETTINGS_PAGE_SLOT, repo: opts.selectedRepo }))}">Source settings</a></p></section>`;
  const intro = `<header class="page-intro"><h1>Config</h1><p>Configure work sources, integrations, and ${term('agent').toLowerCase()} defaults. Save each setting separately.</p></header>`;
  const status = `${opts.error ? `<div class="config-load-error degraded-banner" role="alert">${esc(opts.error)}${opts.unavailable ? '' : ' Showing the last loaded settings.'} <button type="button" data-config-retry${opts.loading ? ' disabled' : ''}>Try again</button></div>` : ''}${opts.loading ? '<p class="empty-note" role="status">Loading configuration…</p>' : ''}`;
  if (opts.unavailable) {
    return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `${intro}<section class="panel config-loading" aria-label="Configuration" aria-busy="${Boolean(opts.loading)}">${status || '<p class="empty-note">Configuration is unavailable. <button type="button" data-config-retry>Try again</button></p>'}</section>${sources}${customization}`);
  }
  return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      ${intro}${status}
      ${sources}
      ${customization}
      <section class="panel config-panel"><h2>Communication</h2><p><a class="app-link" href="/communication${opts.selectedRepo ? `?repo=${encodeURIComponent(opts.selectedRepo)}` : ''}">Notifications and Slack settings</a></p></section>
      <section class="panel config-panel"><h2>Local Git</h2><p><a class="app-link" href="/local-git${opts.selectedRepo ? `?repo=${encodeURIComponent(opts.selectedRepo)}` : ''}">Local branches and worktrees</a></p></section>
      <section class="panel config-panel">
        <div class="panel-head"><span class="panel-title">Runtime settings</span></div>
        <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
        <div class="config-list">
          ${jiraTokenRowHtml(uiConfig.jiraTokenSet === true)}
          ${configRowsHtml(uiConfig)}
        </div>
      </section>
      ${prePrConfigPanel(uiConfig)}
`);
}
