import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_HELP, renderConfigView, renderAppShell } from './render';
import { EDITABLE_KEYS } from '../server/helmsman/config-store';
import type { UiConfig } from './data/config';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';
import { appPages, TODOS_PAGE_SLOT, TODOS_PAGE_ID, TRIAGE_PAGE_SLOT, TRIAGE_PAGE_ID, BUGS_PAGE_SLOT, BUGS_PAGE_ID } from './plugins/builtins';


function root(): HTMLDivElement {
  document.body.innerHTML = '<div id="app"></div>';
  const el: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!el) throw new Error('missing #app');
  return el;
}

describe('application views', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['todos', TODOS_PAGE_SLOT, TODOS_PAGE_ID], ['triage', TRIAGE_PAGE_SLOT, TRIAGE_PAGE_ID], ['bugs', BUGS_PAGE_SLOT, BUGS_PAGE_ID],
  ])('highlights the original %s tab for plugin aliases and unavailable replacements', (view, slot, id) => {
    const el = root();
    for (const selected of [id, 'example.unavailable/page']) {
      appPages.select(slot, selected);
      try {
        el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: slot, pluginPage: selected, repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID, readout: null }, '');
        expect(el.querySelectorAll('.page-tab.is-active')).toHaveLength(1);
        expect(el.querySelector('.page-tab.is-active')?.id).toBe(`page-tab-${view}`);
        expect(el.querySelector('#page-tab-plugin')).toBeNull();
      } finally { appPages.select(slot, null); }
    }
  });

  it.each([false, true])('keeps a scoped Source settings link when core config unavailable is %s', unavailable => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID, unavailable });
    expect(el.querySelector('a[href="/source-settings?repo=org%2Fa"]')?.textContent).toBe('Source settings');
    expect(el.querySelector('[data-task-source-settings]')).toBeNull();
    expect(el.querySelector('.ui-customization-panel')).not.toBeNull();
    expect(el.querySelectorAll('.operator-note')).toHaveLength(1);
    expect(el.querySelector('.page-intro .operator-note')).not.toBeNull();
    expect(el.querySelector('.app-footer .operator-note')).toBeNull();
    expect(el.querySelector('.app-footer [data-recovery-link]')?.getAttribute('href')).toBe('/recovery?repo=org%2Fa');
    expect(el.querySelector('.app-footer [data-pirate-mode]')).not.toBeNull();
  });

  it('renders theme selection in its own Config customization panel', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'dracula' });
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.theme-select');
    expect(select).not.toBeNull();
    expect(el.querySelector('.ui-customization-panel .theme-select')).toBe(select);
    expect(el.querySelector('.ui-customization-panel .theme-preview')).not.toBeNull();
    expect(el.querySelector('.helm-head .theme-select')).toBeNull();
    expect(el.querySelector('.ui-theme-control label[for="ui-theme"]')?.textContent).toBe('Theme');
    expect(el.querySelector('.ui-theme-control #ui-theme-help')?.id).toBe(select?.getAttribute('aria-describedby'));
    expect(el.querySelector('.ui-terminology-settings .terminology-reference')?.hasAttribute('open')).toBe(false);
    expect(el.querySelector('.ui-theme-control')?.nextElementSibling?.classList.contains('theme-preview')).toBe(true);
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('dracula');
  });

  it('omits theme selection from the dashboard', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID, readout: null }, '<h1 class="sr-only">Helm</h1>');
    expect(el.querySelector('.theme-select')).toBeNull();
  });

  it('adds a help tooltip to each config key', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = { config: { AGENT_MAX_ATTEMPTS: 2 }, overridden: [] };
    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const hint: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"] .config-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('title')).toContain('Total attempts');
    expect(hint?.getAttribute('aria-label')).toBe(hint?.getAttribute('title'));
  });

  it('has help text with an example for every editable config key', () => {
    for (const key of EDITABLE_KEYS.filter(key => !/^(?:JIRA_|GITHUB_|SLACK_|PRE_PR_)/.test(key))) {
      expect(CONFIG_HELP[key]?.length ?? 0, `missing tooltip for ${key}`).toBeGreaterThan(0);
      expect(CONFIG_HELP[key] ?? '', `missing example for ${key}`).toContain('Example:');
    }
  });

  it('renders a config row per key, marks overridden keys, and never renders a secret value', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = {
      config: { AGENT_MAX_ATTEMPTS: 1, AGENT_MAX_COST_USD: 5 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
      jiraTokenSet: true,
    };

    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });

    const rows: NodeListOf<HTMLElement> = el.querySelectorAll<HTMLElement>('.config-panel:not(.pre-pr-config-panel) .config-row:not(.config-secret-row)');
    expect(rows.length).toBe(2);
    const attemptsRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(attemptsRow).not.toBeNull();
    expect(attemptsRow!.textContent).toContain('saved override');
    expect(el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_COST_USD"]')?.textContent).not.toContain('saved override');
  });

  it('hides retired agent fields from stale configuration payloads', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_ADAPTER: 'codex', AGENT_CMD: 'legacy', AGENT_MAX_ATTEMPTS: 1 }, overridden: ['AGENT_ADAPTER'] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    expect(el.querySelector('[data-key="AGENT_ADAPTER"], [data-key="AGENT_CMD"]')).toBeNull();
    expect(el.querySelector('[data-key="AGENT_MAX_ATTEMPTS"]')).not.toBeNull();
    expect(el.textContent).toContain('plugins select-agent');
  });

  it('routes workflow configuration to plugins and hides retired settings from stale payloads', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { PRE_PR_REVIEWER_COUNT: 1, PRE_PR_MAX_ROUNDS: 5, PRE_PR_STAGE_TIMEOUT_MINUTES: 90 }, overridden: ['PRE_PR_MAX_ROUNDS'] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    expect(el.querySelector('[data-key^="PRE_PR_"]')).toBeNull();
    expect(el.textContent).toContain('plugins select-workflow');
    expect(el.textContent).toContain('plugins select-agent-reviewers');
  });

  it.each([false, true])('links independently available integration settings without legacy fields; unavailable=%s', unavailable => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { JIRA_API_TOKEN: 'do-not-render', JIRA_JQL: 'old bootstrap', GITHUB_REPO: 'org/a' }, overridden: [], jiraTokenSet: true },
      { repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID, unavailable });
    expect(el.textContent).not.toContain('do-not-render');
    expect(el.querySelector('[data-key^="JIRA_"], [data-key^="GITHUB_"]')).toBeNull();
    for (const path of ['jira-settings', 'github-settings', 'communication', 'local-git']) expect(el.querySelector(`a[href="/${path}?repo=org%2Fa"]`)).not.toBeNull();
  });

});

it('links to authored communication settings with the header scope', () => {
  const root = document.createElement('div');
  root.innerHTML = renderConfigView({ config: { SLACK_ENABLED: 'false' }, overridden: [] }, { repos: ['org/repo'], selectedRepo: 'org/repo', themeId: DEFAULT_THEME_ID });
  expect(root.querySelector('a[href="/communication?repo=org%2Frepo"]')).not.toBeNull();
  expect(root.querySelector('[data-key^="SLACK_"]')).toBeNull();
});


describe('accessible configuration states', () => {
  const opts = { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID };

  it('connects every setting to its label and error, and makes Save names unambiguous', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_MAX_ATTEMPTS: 1, 'unknown key': 'value' }, overridden: [] }, opts);
    for (const row of el.querySelectorAll('.config-row')) {
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      expect(input?.labels?.length).toBe(1);
      const ids = input?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain(row.querySelector('.config-error')?.id);
      for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
      expect(row.querySelector('.config-save')?.getAttribute('aria-label')).toMatch(/^(Save|Update) .+/);
    }
    const ids = Array.from(el.querySelectorAll('[id]')).map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    const attempts = el.querySelector<HTMLInputElement>('#config-AGENT_MAX_ATTEMPTS');
    const helpIds = attempts?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    expect(helpIds.map(id => document.getElementById(id)?.textContent).join(' ')).toContain(CONFIG_HELP.AGENT_MAX_ATTEMPTS);
  });

  it('announces first-load progress without exposing default server settings as loaded values', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { ...opts, loading: true, unavailable: true });
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Loading configuration');
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.querySelector('.config-input, .config-save')).toBeNull();
    expect(el.querySelector<HTMLSelectElement>('.theme-select')?.value).toBe(DEFAULT_THEME_ID);
    expect(el.querySelector('[data-pirate-mode]')).not.toBeNull();
  });

  it('offers retry for unavailable settings and safely renders the failure', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { ...opts, error: '<img src=x> Invalid configuration response.', unavailable: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Invalid configuration response');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-config-retry]')?.disabled).toBe(false);
    expect(el.querySelector('.config-input')).toBeNull();
  });

  it('keeps previously loaded settings available after a failed refresh and disables duplicate retry', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_MAX_ATTEMPTS: 1 }, overridden: [] }, { ...opts, error: 'Network unavailable.', loading: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded settings');
    expect(el.querySelector<HTMLInputElement>('#config-AGENT_MAX_ATTEMPTS')?.value).toBe('1');
    expect(el.querySelector<HTMLButtonElement>('[data-config-retry]')?.disabled).toBe(true);
  });
});

describe('plugin page shell', () => {
  it('keeps the scoped header, active Helm tab and Recovery link available without a page implementation', () => {
    const el = root();
    el.innerHTML = renderAppShell({ active: 'plugin', pluginSlot: 'helmsman/helm-page', repos: ['org/zeta', 'org/alpha'], selectedRepo: 'org/alpha', themeId: DEFAULT_THEME_ID, readout: null }, '<p role="status">Page unavailable</p>');
    const select = el.querySelector<HTMLSelectElement>('.repo-select');
    expect(select).toBe(el.querySelector('.helm-head .nameplate-scope .repo-select'));
    expect(Array.from(select?.options ?? []).map(option => option.value)).toEqual(['', 'org/alpha', 'org/zeta']);
    expect(select?.value).toBe('org/alpha');
    expect(el.querySelector('[data-recovery-link]')?.getAttribute('href')).toBe('/recovery?repo=org%2Falpha');
    const tabs = el.querySelector('.page-tabs');
    const selected = tabs?.querySelector('[aria-selected="true"]');
    const panel = el.querySelector('#page-content');
    expect(tabs?.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(selected?.getAttribute('href')).toBe('/helm?repo=org%2Falpha');
    expect(selected?.id).toBe('page-tab-dashboard');
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected?.id);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(el.querySelector('.helm-head')?.nextElementSibling).toBe(tabs);
    expect(tabs?.nextElementSibling).toBe(panel);
    for (const tab of tabs?.querySelectorAll('[role="tab"]') ?? []) expect(tab.getAttribute('aria-controls')).toBe(panel?.id);
  });
});
