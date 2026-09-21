import { term } from './logic/terminology';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_HELP, renderCmuxView, renderConfigView, renderAppShell } from './render';
import { EDITABLE_KEYS } from '../server/helmsman/config-store';
import type { CmuxViewState } from './render';
import type { UiConfig } from './data/config';
import type { CmuxTabView } from './logic/cmuxPanel';
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
  });

  it('renders theme selection in its own Config customization panel', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'dracula' });
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.theme-select');
    expect(select).not.toBeNull();
    expect(el.querySelector('.ui-customization-panel .theme-select')).toBe(select);
    expect(el.querySelector('.ui-customization-panel .theme-preview')).not.toBeNull();
    expect(el.querySelector('.helm-head .theme-select')).toBeNull();
    expect(el.querySelector('label[for="ui-theme"]')?.textContent).toBe('Theme');
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
    const uiConfig: UiConfig = { config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] };
    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const hint: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"] .config-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('title')).toContain('claude-code');
    expect(hint?.getAttribute('aria-label')).toBe(hint?.getAttribute('title'));
  });

  it('has help text with an example for every editable config key', () => {
    for (const key of EDITABLE_KEYS) {
      expect(CONFIG_HELP[key]?.length ?? 0, `missing tooltip for ${key}`).toBeGreaterThan(0);
      expect(CONFIG_HELP[key] ?? '', `missing example for ${key}`).toContain('Example:');
    }
  });

  it('renders a config row per key, marks overridden keys, and never renders a secret value', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = {
      config: { AGENT_ADAPTER: 'claude-code', AGENT_MAX_ATTEMPTS: 1 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
      jiraTokenSet: true,
    };

    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });

    const rows: NodeListOf<HTMLElement> = el.querySelectorAll<HTMLElement>('.config-panel:not(.pre-pr-config-panel) .config-row:not(.config-secret-row)');
    expect(rows.length).toBe(10);
    const adapterRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(adapterRow).not.toBeNull();
    expect(adapterRow!.querySelector<HTMLInputElement>('.config-input')?.value).toBe('claude-code');
    const attemptsRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(attemptsRow).not.toBeNull();
    expect(attemptsRow!.textContent).toContain('saved override');
    expect(adapterRow!.textContent).not.toContain('saved override');
  });

  it('groups pre-PR settings in one panel with bounded numeric inputs and defaults', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const panel = el.querySelector('.pre-pr-config-panel');
    expect(panel?.textContent).toContain(`active ${term('runs').toLowerCase()} keep their settings`);
    expect(panel?.textContent).toContain('With only one installed, one reviewer runs');
    for (const [key, value, min, max] of [
      ['PRE_PR_REVIEWER_COUNT', '2', '1', '2'],
      ['PRE_PR_MAX_ROUNDS', '3', '1', '5'],
      ['PRE_PR_STAGE_TIMEOUT_MINUTES', '45', '5', '180'],
    ]) {
      const row = panel?.querySelector(`.config-row[data-key="${key}"]`);
      const input = row?.querySelector<HTMLInputElement>('.config-input');
      expect(input?.type).toBe('number');
      expect(input?.value).toBe(value);
      expect(input?.min).toBe(min);
      expect(input?.max).toBe(max);
      expect(input?.step).toBe('1');
      expect(input?.required).toBe(true);
      expect(row?.querySelector('label')?.getAttribute('for')).toBe(input?.id);
      const descriptions = input?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
      expect(descriptions.map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain(key);
      expect(descriptions).toContain(`error-${key}`);
      expect(row?.querySelector('.config-save')?.getAttribute('data-key')).toBe(key);
    }
  });

  it('shows persisted pre-PR settings only once and marks overrides', () => {
    const el = root();
    el.innerHTML = renderConfigView({
      config: { PRE_PR_REVIEWER_COUNT: 1, PRE_PR_MAX_ROUNDS: 5, PRE_PR_STAGE_TIMEOUT_MINUTES: 90 },
      overridden: ['PRE_PR_MAX_ROUNDS'],
    }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    for (const [key, value] of [
      ['PRE_PR_REVIEWER_COUNT', '1'], ['PRE_PR_MAX_ROUNDS', '5'], ['PRE_PR_STAGE_TIMEOUT_MINUTES', '90'],
    ]) {
      expect(el.querySelectorAll(`.config-row[data-key="${key}"]`)).toHaveLength(1);
      expect(el.querySelector<HTMLInputElement>(`.pre-pr-config-panel [data-key="${key}"] .config-input`)?.value).toBe(value);
    }
    expect(el.querySelector('.pre-pr-config-panel [data-key="PRE_PR_MAX_ROUNDS"] .config-overridden')).not.toBeNull();
    expect(el.querySelector('.pre-pr-config-panel [data-key="PRE_PR_REVIEWER_COUNT"] .config-overridden')).toBeNull();
  });

  it('renders a write-only JIRA_API_TOKEN update row that never carries a value', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = { config: { AGENT_ADAPTER: 'claude-code' }, overridden: [], jiraTokenSet: true };
    el.innerHTML = renderConfigView(uiConfig, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    const tokenRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-secret-row[data-key="JIRA_API_TOKEN"]');
    expect(tokenRow).not.toBeNull();
    const input: HTMLInputElement | null = tokenRow!.querySelector<HTMLInputElement>('.config-secret-input');
    expect(input!.type).toBe('password');
    expect(input!.value).toBe('');
    expect(tokenRow!.querySelector('.config-save')?.getAttribute('data-key')).toBe('JIRA_API_TOKEN');
    expect(tokenRow!.textContent).toContain('set ✓');
  });

  it('shows the Jira token as not set when absent', () => {
    const el: HTMLDivElement = root();
    el.innerHTML = renderConfigView({ config: {}, overridden: [], jiraTokenSet: false }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
    expect(el.querySelector('.config-secret-row .config-secret-status')?.textContent).toContain('not set');
  });
});

function cmuxTabFixture(over: Partial<CmuxTabView> = {}): CmuxTabView {
  return {
    windowRef: 'win-1',
    workspaceRef: 'ws-1',
    workspaceTitle: 'helmsman',
    surfaceRef: 'surface-1',
    surfaceTitle: 'main',
    type: 'shell',
    cwd: '/repo',
    selected: false,
    ...over,
  };
}

function cmuxStateFixture(over: Partial<CmuxViewState> = {}): CmuxViewState {
  return {
    connected: true,
    tabs: [cmuxTabFixture()],
    selectedSurface: null,
    screen: '',
    isCapturing: false,
    repos: [],
    selectedRepo: null,
    themeId: DEFAULT_THEME_ID,
    ...over,
  };
}

describe('renderCmuxView', () => {
  it('renders a not-connected note and no tab list when disconnected', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ connected: false, tabs: [cmuxTabFixture()] }));
    expect(html.toLowerCase()).toContain('not connected');
    expect(html).not.toContain('cmux-tab"');
  });

  it('renders the tab list with title and workspace/type meta', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('data-surface="surface-1"');
    expect(html).toContain('main');
    expect(html).toContain('helmsman');
    expect(html).toContain('shell');
  });

  it('marks the selected tab and shows a prompt to select one when nothing is selected', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('Select a tab');
    expect(html).not.toContain('is-selected');
  });

  it('shows the screen, send form, and only universal actions for a non-agent tab when selected', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({ selectedSurface: 'surface-1', screen: 'hello world' }),
    );
    expect(html).toContain('is-selected');
    expect(html).toContain('cmux-screen');
    expect(html).toContain('hello world');
    expect(html).toContain('cmux-send');
    expect(html).toContain('data-action="enter"');
    expect(html).toContain('data-action="escape"');
    expect(html).toContain('data-action="interrupt"');
    expect(html).not.toContain('data-action="continue"');
    expect(html).not.toContain('data-action="stop"');
    expect(html).not.toContain('data-action="approve"');
  });

  it('adds agent actions when the selected tab is an agent-session', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceRef: 'agent-1', type: 'agent-session' })],
        selectedSurface: 'agent-1',
        screen: '',
      }),
    );
    expect(html).toContain('data-action="continue"');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('data-action="approve"');
  });

  it('escapes malicious tab titles and screen content', () => {
    const payload: string = '<img src=x onerror=alert(1)>';
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceTitle: payload })],
        selectedSurface: 'surface-1',
        screen: payload,
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders a no-tabs note when the tab list is empty', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ tabs: [] }));
    expect(html.toLowerCase()).toContain('no terminal tabs');
  });

  it('gives the list and detail panels collapse buttons with stable ids', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1' }));
    expect(html).toContain('data-collapse-id="cmux:list"');
    expect(html).toContain('data-collapse-id="cmux:detail"');
  });

  it('marks a cmux panel collapsed when its id is in the set', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', collapsed: new Set(['cmux:list']) }));
    expect(el.querySelector('.cmux-list.is-collapsed')).not.toBeNull();
    expect(el.querySelector('.cmux-detail.is-collapsed')).toBeNull();
  });
});

it('groups every Slack setting in one panel with integration and watcher switches', () => {
  const keys = EDITABLE_KEYS.filter(key => key.startsWith('SLACK_'));
  const config = Object.fromEntries(keys.map(key => [key, key.endsWith('ENABLED') ? 'false' : 'configured']));
  const root = document.createElement('div');
  root.innerHTML = renderConfigView({ config, overridden: [] }, { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID });
  const panel = root.querySelector('.slack-review-config');
  expect(panel).not.toBeNull();
  for (const key of keys) {
    expect(root.querySelectorAll(`.config-row[data-key="${key}"]`)).toHaveLength(1);
    expect(panel?.querySelector(`.config-row[data-key="${key}"]`)).not.toBeNull();
  }
  expect(panel?.querySelector<HTMLSelectElement>('#config-SLACK_ENABLED')?.value).toBe('false');
  expect(panel?.querySelector<HTMLSelectElement>('#config-SLACK_WATCH_ENABLED')?.value).toBe('false');
});


describe('accessible configuration states', () => {
  const opts = { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID };

  it('connects every setting to its label and error, and makes Save names unambiguous', () => {
    const el = root();
    el.innerHTML = renderConfigView({ config: { AGENT_ADAPTER: 'codex', 'unknown key': 'value' }, overridden: [] }, opts);
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
    const adapter = el.querySelector<HTMLInputElement>('#config-AGENT_ADAPTER');
    const helpIds = adapter?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    expect(helpIds.map(id => document.getElementById(id)?.textContent).join(' ')).toContain(CONFIG_HELP.AGENT_ADAPTER);
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
    el.innerHTML = renderConfigView({ config: { AGENT_ADAPTER: 'codex' }, overridden: [] }, { ...opts, error: 'Network unavailable.', loading: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded settings');
    expect(el.querySelector<HTMLInputElement>('#config-AGENT_ADAPTER')?.value).toBe('codex');
    expect(el.querySelector<HTMLButtonElement>('[data-config-retry]')?.disabled).toBe(true);
  });
});

it('describes how keyboard users can release Terminal capture', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', isCapturing: true }));
  for (const control of el.querySelectorAll('.cmux-capture-toggle, .cmux-screen')) {
    expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Shift+Escape');
  }
});


it('provides a retry action for Terminal failure without hiding cached terminal tabs', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', screen: 'last output', error: 'Terminal tabs could not be refreshed.' }));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('Terminal tabs could not be refreshed.');
  expect(el.querySelector('[data-cmux-refresh]')?.textContent).toBe('Try again');
  expect(el.querySelector('.cmux-tab')).not.toBeNull();
  expect(el.querySelector('.cmux-screen')?.textContent).toBe('last output');
});

it('distinguishes Terminal disconnect from a failed connection check', () => {
  const el = root();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ connected: false }));
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Terminal not connected');
  expect(el.querySelector('[data-cmux-refresh]')).not.toBeNull();
  el.innerHTML = renderCmuxView(cmuxStateFixture({ connected: false, error: 'Could not check terminal connection.' }));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not check terminal connection');
  expect(el.textContent).not.toContain('Terminal not connected');
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
