import { afterEach, describe, expect, it } from 'vitest';
import { activePageTabId, renderHelmHead, type HelmHeadOpts } from './render';
import { appPages, builtinPageSlots, COSTS_PAGE_ID, COSTS_PAGE_SLOT, SOURCE_SETTINGS_PAGE_SLOT } from './plugins/builtins';
import { setPirateMode, term } from './logic/terminology';
import { parseRoute } from './logic/routes';

const opts: HelmHeadOpts = { active: 'config', repos: ['org/a'], selectedRepo: 'org/a', themeId: 'dracula', readout: null };
const disposers: (() => void)[] = [];
const mount = (html: string) => { const root = document.createElement('div'); root.innerHTML = html; return root; };
function register(id: string, title: string, slots: string[] = [], navigation?: boolean) {
  const slot = builtinPageSlots.find(value => value.id === slots[0]);
  const composition = slot?.panelContract ? { id: slot.id, version: 1, accepts: [{ id: slot.panelContract, version: 1 }] } : undefined;
  disposers.push(appPages.register({ manifestVersion: 2, id, version: '1.0.0', sdkVersion: 1, panels: [],
    pages: [{ id: 'page', title, slots, panes: [], ...(composition ? { composition } : {}),
      ...(navigation === undefined ? {} : { navigation }) }] }));
}
afterEach(() => {
  for (const slot of builtinPageSlots) appPages.select(slot.id, null);
  for (const dispose of disposers.splice(0)) dispose();
  setPirateMode(true);
  window.history.replaceState(null, '', '/');
});

describe('plugin page navigation', () => {
  it('omits the redundant Pages menu while keeping external canonical pages active', () => {
    register('example.summary', 'Summary');
    const active = { ...opts, active: 'plugin' as const, pluginPage: 'example.summary/page' };
    const root = mount(renderHelmHead(active));
    expect(root.querySelector('[data-pages-menu]')).toBeNull();
    expect(root.querySelector('#page-tab-plugin')?.textContent).toBe('Summary');
    expect(root.querySelector('#page-tab-plugin')?.getAttribute('href')).toBe('/plugins/example.summary/page?repo=org%2Fa');
    expect(activePageTabId(active)).toBe('page-tab-plugin');
  });

  it('retains a named active tab for canonical Costs when another implementation owns its alias', () => {
    register('example.costs', 'Alternative costs', [COSTS_PAGE_SLOT]);
    appPages.select(COSTS_PAGE_SLOT, 'example.costs/page');
    const active = { ...opts, active: 'outcomes' as const, pluginPage: COSTS_PAGE_ID };
    const root = mount(renderHelmHead(active));
    expect(root.querySelectorAll('.page-tab.is-active')).toHaveLength(1);
    expect(activePageTabId(active)).toBe('page-tab-plugin');
    expect(root.querySelector('#page-tab-plugin')?.textContent).toBe(term('costsOutcomes'));
    expect(root.querySelector('#page-tab-outcomes')?.textContent).toBe('Alternative costs');
  });

  it('preserves the unavailable active tab after an external page is removed', () => {
    register('example.summary', 'Summary');
    disposers.pop()?.();
    const root = mount(renderHelmHead({ ...opts, active: 'plugin', pluginPage: 'example.summary/page' }));
    expect(root.querySelector('.page-tab.is-active')?.textContent).toBe(term('unavailablePluginPage'));
    expect(root.querySelector('.page-tab.is-active')?.getAttribute('href')).toBe('/plugins/example.summary/page?repo=org%2Fa');
  });
});

describe('section navigation', () => {
  const configPaths = ['/config', '/source-settings', '/execution-settings', '/agent-prompts', '/feedback-settings', '/jira-settings', '/github-settings', '/communication', '/local-git'];
  const configMenuPaths = ['/config', '/config', ...configPaths.slice(1)];
  const runPaths = ['/runs', '/run-history', '/run-viewer'];
  function head(path: string) {
    const route = parseRoute(new URL(path, window.location.origin));
    return mount(renderHelmHead({ ...opts, active: route.view, pane: route.pane, selectedRepo: route.repo, pluginPage: route.pluginPage, pluginSlot: route.pluginSlot }));
  }
  function paths(root: HTMLElement) {
    return [...root.querySelectorAll<HTMLAnchorElement>('.section-nav a')].map(anchor => new URL(anchor.href).pathname);
  }

  it.each([...configPaths, ...runPaths])('keeps the full section available on direct navigation to %s', path => {
    const expected = configPaths.includes(path) ? configMenuPaths : runPaths;
    const parent = configPaths.includes(path) ? 'config' : 'runs';
    const root = head(`${path}?repo=org/a&run=old&runRepo=org/b&prRepo=org/b&pr=17&pane=recent&panel=old&ticket=TASK-1`);
    const nav = root.querySelector<HTMLElement>('.section-nav');
    expect(nav?.hidden).toBe(false);
    expect(paths(root)).toEqual(expected);
    expect(root.querySelectorAll('.page-tab.is-active')).toHaveLength(1);
    expect(root.querySelector('.page-tab.is-active')?.id).toBe(`page-tab-${parent}`);
    expect(nav?.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(nav?.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe(`${path}?repo=org%2Fa`);
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('.section-nav a')) {
      expect([...new URL(anchor.href).searchParams]).toEqual(anchor.dataset.sectionLink === 'plugins'
        ? [['repo', 'org/a'], ['pane', 'plugins']] : [['repo', 'org/a']]);
    }
    if (path !== expected[0]) expect(root.querySelector('.page-tab.is-active')?.hasAttribute('aria-current')).toBe(false);
  });

  it('keeps a canonical alternative current without claiming its selected alias is open', () => {
    register('example.source', 'Source alternative', [SOURCE_SETTINGS_PAGE_SLOT]);
    register('example.selected', 'Selected source', [SOURCE_SETTINGS_PAGE_SLOT]);
    appPages.select(SOURCE_SETTINGS_PAGE_SLOT, 'example.selected/page');
    const root = head('/plugins/example.source/page?repo=org/a');
    const nav = root.querySelector('.section-nav');
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-config');
    expect(nav?.querySelector('a[href="/source-settings?repo=org%2Fa"]')?.textContent).toBe('Selected source');
    expect(nav?.querySelector('a[href="/source-settings?repo=org%2Fa"]')?.hasAttribute('aria-current')).toBe(false);
    expect(nav?.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(nav?.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/plugins/example.source/page?repo=org%2Fa');
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe('Source alternative');
    expect(appPages.selected(SOURCE_SETTINGS_PAGE_SLOT).contributionId).toBe('example.selected/page');
  });

  it('preserves canonical routes for selected child implementations', () => {
    register('example.source', 'Source alternative', [SOURCE_SETTINGS_PAGE_SLOT]);
    appPages.select(SOURCE_SETTINGS_PAGE_SLOT, 'example.source/page');
    const root = head('/plugins/example.source/page');
    expect(root.querySelector('.section-nav [aria-current="page"]')?.getAttribute('href')).toBe('/plugins/example.source/page');
    expect(root.querySelectorAll('.section-nav a')).toHaveLength(configMenuPaths.length);
  });

  it('retains the section and alias when a selected child implementation is unavailable', () => {
    appPages.select(SOURCE_SETTINGS_PAGE_SLOT, 'example.missing/page');
    const root = head('/source-settings?repo=org/a');
    expect(paths(root)).toEqual(configMenuPaths);
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-config');
    expect(root.querySelector('.section-nav [aria-current="page"]')?.getAttribute('href')).toBe('/source-settings?repo=org%2Fa');
    expect(appPages.selected(SOURCE_SETTINGS_PAGE_SLOT)).toMatchObject({ contributionId: 'example.missing/page', page: null });
  });

  it('keeps unrelated plugins independent even when selected incompatibly for a child slot', () => {
    register('example.source', 'External source');
    appPages.restoreSelection(SOURCE_SETTINGS_PAGE_SLOT, 'example.source/page');
    const root = head('/plugins/example.source/page');
    expect(root.querySelector<HTMLElement>('.section-nav')?.hidden).toBe(true);
    expect(root.querySelector('.section-nav a')).toBeNull();
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-plugin');
    expect(root.querySelector('.page-tab.is-active')?.textContent).toBe('External source');
  });

  it('keeps the core plugin manager discoverable with the current scope', () => {
    const root = head('/config?repo=org/a&pane=plugins');
    const nav = root.querySelector('.section-nav');
    expect(paths(root)).toEqual(configMenuPaths);
    expect(nav?.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe('Plugins');
    expect(nav?.querySelector('[data-section-link="overview"]')?.getAttribute('href')).toBe('/config?repo=org%2Fa');
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-config');
    expect(root.querySelector('.page-tab.is-active')?.hasAttribute('aria-current')).toBe(false);
  });
});
