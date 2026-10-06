import { term, isPirateMode, TERMINOLOGY, TERMINOLOGY_REFERENCE_KEYS } from './logic/terminology';
import { renderThemePreview } from './renderThemePreview';
import { routeHref, type PageView } from './logic/routes';
import { navigationSection, navigationChild } from './logic/navigation';
import { appPages, builtinPageSlots, SOURCE_SETTINGS_PAGE_SLOT } from './plugins/builtins';
import { escapeHtml as esc } from './logic/html';
import { PRE_PR_CONFIG_KEYS } from './logic/prePrSettings';

import type { UiConfig } from './data/config';
import { THEMES } from './data/themes';


export const CONFIG_HELP: Record<string, string> = {
  get AGENT_MAX_ATTEMPTS() { return `Total attempts for existing-PR ${term('runs').toLowerCase()}, including the initial attempt. New coding ${term('runs').toLowerCase()} use the separate pre-PR review rounds. Example: 1`; },
  get AGENT_MAX_COST_USD() { return `Per-${term('run').toLowerCase()} spend ceiling in USD; the ${term('run').toLowerCase()} stops once exceeded. Blank means no cap. Example: 5.00`; },
  get REPO_PROJECT_MAP() { return `Comma-separated ${term('repository').toLowerCase()}=jiraProject pairs, registering configured ${term('repositories').toLowerCase()} and initial Jira project defaults. Existing Jira sources use Source settings. Example: gdcorp-partners/airo-app-builder=AIROBUILD,gdcorp-enm/conversations-web=LEKA`; },
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
  { view: 'outcomes', get label() { return term('costsOutcomes'); } },
  { view: 'campaigns', get label() { return term('campaigns'); } },
  { view: 'clarifications', get label() { return term('clarifications'); } },
  { view: 'config', label: 'Config' },
];

export interface HelmHeadOpts {
  active: PageView;
  jiraEnabled?: boolean;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  pluginPage?: string;
  pluginSlot?: string;
  readout: { running: number | null; queued: number | null; review: number | null } | null;
}

function shippedPageTabs(opts: HelmHeadOpts) {
  const section = navigationSection(opts);
  return PAGE_TABS.map(tab => {
    const href = routeHref({ view: tab.view, repo: opts.selectedRepo });
    const slot = builtinPageSlots.find(value => value.alias === href.split('?')[0]);
    const selected = slot ? appPages.selected(slot.id) : null;
    const active = opts.pluginSlot ? opts.pluginSlot === slot?.id
      : opts.pluginPage ? opts.pluginPage === selected?.page?.contributionId : tab.view === opts.active;
    return { ...tab, id: `page-tab-${tab.view}`, contributionId: selected?.page?.contributionId ?? null,
      label: selected?.page && selected.contributionId !== slot?.defaultContributionId ? selected.page.title : tab.label,
      active: section ? tab.view === section.view : active, current: active && (!section || tab.view === section.view), href };
  });
}

function pageTabs(opts: HelmHeadOpts) {
  const tabs = shippedPageTabs(opts);
  if ((opts.active === 'plugin' || opts.active === 'outcomes') && !tabs.some(tab => tab.active)) {
    const page = opts.pluginPage ? appPages.getPage(opts.pluginPage) : null;
    const shipped = PAGE_TABS.find(tab => {
      const alias = routeHref({ view: tab.view }).split('?')[0];
      return builtinPageSlots.some(slot => slot.alias === alias && slot.defaultContributionId === page?.contributionId);
    });
    tabs.push({ id: 'page-tab-plugin', view: opts.active, active: true, current: true, contributionId: opts.pluginPage ?? null,
      label: shipped?.label ?? page?.title ?? term('unavailablePluginPage'),
      href: routeHref({ view: opts.active, repo: opts.selectedRepo, pluginPage: opts.pluginPage, pluginSlot: opts.pluginSlot }),
    });
  }
  return tabs;
}

export function renderPagesMenu(opts: HelmHeadOpts): string {
  const represented = new Set(shippedPageTabs(opts).map(tab => tab.contributionId).filter(Boolean));
  const pages = appPages.listPages().filter(page => page.navigation !== false && !represented.has(page.contributionId))
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || (a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0));
  const titles = new Map<string, number>();
  for (const page of pages) { const key = page.title.toLocaleLowerCase('en'); titles.set(key, (titles.get(key) ?? 0) + 1); }
  const links = pages.map(page => {
    const selectedSlot = [...builtinPageSlots].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .find(slot => appPages.selected(slot.id).page?.contributionId === page.contributionId);
    const href = routeHref({ view: 'plugin', repo: opts.selectedRepo, ...(selectedSlot ? { pluginSlot: selectedSlot.id } : { pluginPage: page.contributionId }) });
    const active = opts.pluginSlot ? opts.pluginSlot === selectedSlot?.id : opts.pluginPage === page.contributionId;
    const duplicate = (titles.get(page.title.toLocaleLowerCase('en')) ?? 0) > 1;
    return `<a class="app-link" data-page-link data-page-contribution="${esc(page.contributionId)}" href="${esc(href)}"${active ? ' aria-current="page"' : ''}><span>${esc(page.title)}</span>${duplicate ? `<small>${esc(page.contributionId)}</small>` : ''}</a>`;
  }).join('');
  return `<details class="pages-menu" data-pages-menu><summary data-pages-menu-summary>Pages</summary><nav data-pages-menu-items aria-label="Installed pages">${links || '<p>No additional pages are enabled.</p>'}</nav></details>`;
}

export function activePageTabId(opts: HelmHeadOpts): string {
  return pageTabs(opts).find(tab => tab.active)?.id ?? `page-tab-${opts.active}`;
}

export function renderSectionNavigation(opts: HelmHeadOpts): string {
  const section = navigationSection(opts);
  if (!section) return '<nav class="section-nav" hidden></nav>';
  const child = navigationChild(opts);
  const title = PAGE_TABS.find(tab => tab.view === section.view)?.label ?? section.view;
  const currentHref = routeHref({ view: opts.active, repo: opts.selectedRepo, pluginSlot: opts.pluginSlot, pluginPage: opts.pluginPage });
  const links = [{ id: 'overview', label: 'Overview', href: child ? routeHref({ view: section.view, repo: opts.selectedRepo }) : currentHref, active: !child },
    ...section.children.map(item => {
      const selected = appPages.selected(item.slot);
      const slot = builtinPageSlots.find(value => value.id === item.slot);
      const active = opts.pluginSlot ? opts.pluginSlot === item.slot : child?.slot === item.slot && opts.pluginPage === selected.page?.contributionId;
      return { id: item.slot, active,
        label: selected.page && selected.contributionId !== slot?.defaultContributionId ? selected.page.title : item.label,
        href: active && !opts.pluginSlot ? currentHref : routeHref({ view: 'plugin', pluginSlot: item.slot, repo: opts.selectedRepo }),
      };
    })];
  if (child && !links.some(link => link.active)) links.push({ id: 'current', active: true, href: currentHref,
    label: (opts.pluginPage ? appPages.getPage(opts.pluginPage)?.title : null) ?? term('unavailablePluginPage') });
  return `<nav class="section-nav" aria-label="${esc(title)} pages" data-section="${section.view}">${links.map(link =>
    `<a class="section-link app-link${link.active ? ' is-active' : ''}" data-section-link="${esc(link.id)}" href="${esc(link.href)}"${link.active ? ' aria-current="page"' : ''}>${esc(link.label)}</a>`,
  ).join('')}</nav>`;
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
      `<a class="page-tab view-toggle${t.active ? ' is-active' : ''}" href="${esc(t.href)}" data-view="${t.view}" role="tab" id="${t.id}" aria-selected="${t.active}" aria-controls="page-content" tabindex="${t.active ? 0 : -1}"${t.current ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`,
  ).join('');
  const readout = `<div class="helm-readout" aria-label="${term('systemStatus')}">
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
        <span class="nameplate-name">Helmsman <span class="nameplate-alpha">Alpha</span></span>
      </div>
      <div class="nameplate-scope">
        <select class="repo-select" aria-label="${term('scopeByRepository')}">${scopeOptions}</select>
      </div>
      ${readout}
      <div class="helm-controls">
        <span class="helm-greeting"><span data-greeting>${term('greeting')}</span><span data-profile-header></span>!</span>
        ${renderPagesMenu(opts)}
      </div>
    </header>
    <nav class="page-tabs" role="tablist" aria-label="Views" aria-orientation="vertical">${tabs}</nav>
    ${renderSectionNavigation(opts)}`;
}

export function renderAppShell(opts: HelmHeadOpts, content: string): string {
  const running = opts.readout?.running ?? '—';
  return `<div class="helm${opts.active === 'dashboard' ? '' : ` ${opts.active}-view`}" data-page="${opts.active}">
    ${renderHelmHead(opts)}
    <main class="page-content" id="page-content" role="tabpanel" aria-labelledby="${activePageTabId(opts)}" tabindex="0">${content}</main>
    <details class="plugin-auxiliary-slot" data-pane="tasks">
      <summary>${term('runLogs')}</summary>
      <div data-run-viewer-host></div>
    </details>
    <footer class="app-footer">
      <div class="footer-meta">
        <a data-recovery-link href="/recovery${opts.selectedRepo ? `?repo=${encodeURIComponent(opts.selectedRepo)}` : ''}">${term('recovery')}</a>
        <details class="footer-about">
          <summary>About</summary>
          <div class="footer-about-content">
            <span>Helmsman v${esc(__APP_VERSION__)}</span>
            <span>Updated ${esc(__BUILD_DATE__)}</span>
            <span class="footer-attr">nloehlein@godaddy.com</span>
            <span data-footer-repos>${opts.repos.length} ${term(opts.repos.length === 1 ? 'repository' : 'repositories').toLowerCase()} tracked</span>
            <span data-footer-running>${running} ${term('running').toLowerCase()}</span>
          </div>
        </details>
      </div>
      <div class="footer-controls"><span data-feedback-footer></span><button class="pirate-mode-toggle" type="button" data-pirate-mode aria-label="Pirate mode" aria-pressed="${isPirateMode()}" title="Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}">${ICON_PIRATE_FLAG}</button></div>
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
    .filter(([key]) => key !== 'AUTO_CLAIM_INTERVAL_MS' && key !== 'AGENT_ADAPTER' && key !== 'AGENT_CMD' && !key.startsWith('JIRA_') && !key.startsWith('GITHUB_') && !key.startsWith('SLACK_') && !PRE_PR_CONFIG_KEYS.some((reviewKey) => reviewKey === key));
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


function configCustomizationPanel(themeId: string): string {
  const themeOptions = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');
  return `      <section class="panel config-panel ui-customization-panel" aria-labelledby="ui-customization-title">
        <div class="panel-head"><span class="panel-title" id="ui-customization-title">UI customization</span></div>
        <div class="ui-customization-body">
          <div class="ui-theme-control">
            <label for="ui-theme">Theme</label>
            <select id="ui-theme" class="theme-select" aria-describedby="ui-theme-help">${themeOptions}</select>
            <p id="ui-theme-help">Applies immediately. Saved in this browser.</p>
          </div>
          ${renderThemePreview()}
          <div class="ui-terminology-settings">
            <div class="ui-terminology-copy">
              <h3>Pirate mode</h3>
              <p id="pirate-mode-help">Use the flag at the bottom-right to switch labels. Your content stays unchanged.</p>
            </div>
            <details class="terminology-reference"><summary>Terminology reference</summary><table><thead><tr><th scope="col">Plain</th><th scope="col">Pirate</th></tr></thead><tbody>${TERMINOLOGY_REFERENCE_KEYS.map(key => TERMINOLOGY[key]).map(({ plain, pirate }) => `<tr><td>${esc(plain)}</td><td>${esc(pirate)}</td></tr>`).join('')}</tbody></table></details>
          </div>
        </div>
      </section>`;
}

export function renderConfigView(uiConfig: UiConfig, opts: ConfigViewOpts): string {
  const customization = configCustomizationPanel(opts.themeId);
  const sources = `<section class="panel config-panel config-section"><h2>Task sources</h2><p><a class="app-link" href="${esc(routeHref({ view: 'plugin', pluginSlot: SOURCE_SETTINGS_PAGE_SLOT, repo: opts.selectedRepo }))}">Source settings</a></p></section>`;
  const integrations = `<section class="panel config-panel config-section"><h2>Integrations and workspace</h2><ul class="config-links">${[
    ['/feedback-settings', 'Product feedback settings'], ['/jira-settings', 'Jira connection'], ['/github-settings', 'GitHub settings'],
    ['/communication', 'Notifications and Slack settings'], ['/local-git', 'Local branches and worktrees'],
  ].map(([path, label]) => `<li><a class="app-link" href="${path}${opts.selectedRepo ? `?repo=${encodeURIComponent(opts.selectedRepo)}` : ''}">${label}</a></li>`).join('')}</ul></section>`;
  const intro = `<header class="page-intro"><h1>Config</h1><p>Configure work sources, integrations, and ${term('agent').toLowerCase()} defaults. Save each setting separately.</p><div class="operator-note">${ICON_LOCK}<span>${term('operatorNote')}</span></div></header>`;
  const status = `${opts.error ? `<div class="config-load-error degraded-banner" role="alert">${esc(opts.error)}${opts.unavailable ? '' : ' Showing the last loaded settings.'} <button type="button" data-config-retry${opts.loading ? ' disabled' : ''}>Try again</button></div>` : ''}${opts.loading ? '<p class="empty-note" role="status">Loading configuration…</p>' : ''}`;
  if (opts.unavailable) {
    return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `${intro}<section class="panel config-loading" aria-label="Configuration" aria-busy="${Boolean(opts.loading)}">${status || '<p class="empty-note">Configuration is unavailable. <button type="button" data-config-retry>Try again</button></p>'}</section>${sources}${integrations}${customization}`);
  }
  return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      ${intro}${status}
      ${sources}
      ${integrations}
      ${customization}
      <section class="panel config-panel">
        <div class="panel-head"><span class="panel-title">Runtime settings</span></div>
        <div class="config-warning">Configure agent providers in Plugins, then select one with <span class="mono">helmsman plugins select-agent</span>. Runtime limit changes apply on restart.</div>
        <div class="config-list">
          ${configRowsHtml(uiConfig)}
        </div>
      </section>
      <section class="panel config-panel config-section"><h2>Workflows and reviewers</h2><p>Configure workflow providers in Plugins and select them with <span class="mono">helmsman plugins select-workflow</span>. Select the ordered reviewers with <span class="mono">helmsman plugins select-agent-reviewers</span>. Active ${term('runs').toLowerCase()} keep their original workflow and reviewers.</p></section>
`);
}
