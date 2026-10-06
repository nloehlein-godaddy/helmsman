import { afterEach, describe, expect, it } from 'vitest';
import { activePageTabId, renderHelmHead, renderPagesMenu, type HelmHeadOpts } from './render';
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
function link(root: HTMLElement, id: string) {
  return [...root.querySelectorAll<HTMLAnchorElement>('[data-page-link]')].find(item => item.dataset.pageContribution === id);
}
afterEach(() => {
  for (const slot of builtinPageSlots) appPages.select(slot.id, null);
  for (const dispose of disposers.splice(0)) dispose();
  setPirateMode(true);
  window.history.replaceState(null, '', '/');
});

describe('installed page discovery', () => {
  it('exposes enabled external pages from Config with only the header scope', () => {
    register('example.summary', 'Summary');
    window.history.replaceState(null, '', '/config?repo=org/a&run=old&ticket=TASK-1&pane=history&panel=old');
    const root = mount(renderHelmHead(opts));
    expect(root.querySelector('.helm-controls > details > summary')?.textContent).toBe('Pages');
    expect(link(root, 'example.summary/page')?.getAttribute('href')).toBe('/plugins/example.summary/page?repo=org%2Fa');
    expect(link(root, 'example.summary/page')?.hasAttribute('aria-current')).toBe(false);
    expect(link(mount(renderPagesMenu({ ...opts, selectedRepo: null })), 'example.summary/page')?.getAttribute('href')).toBe('/plugins/example.summary/page');
  });

  it('uses an alias for a selected supplemental page and canonical URLs for unselected alternatives', () => {
    register('example.source', 'Source alternative', [SOURCE_SETTINGS_PAGE_SLOT]);
    let root = mount(renderPagesMenu(opts));
    expect(link(root, 'example.source/page')?.getAttribute('href')).toBe('/plugins/example.source/page?repo=org%2Fa');
    appPages.select(SOURCE_SETTINGS_PAGE_SLOT, 'example.source/page');
    root = mount(renderPagesMenu({ ...opts, active: 'plugin', pluginSlot: SOURCE_SETTINGS_PAGE_SLOT, pluginPage: 'example.source/page' }));
    expect(link(root, 'example.source/page')?.getAttribute('href')).toBe('/source-settings?repo=org%2Fa');
    expect(link(root, 'example.source/page')?.getAttribute('aria-current')).toBe('page');
    expect(appPages.selected(SOURCE_SETTINGS_PAGE_SLOT).contributionId).toBe('example.source/page');
  });

  it('excludes selected shipped tabs and hidden contributions without removing their canonical routes', () => {
    register('example.hidden', 'Header only', [], false);
    register('example.costs', 'Alternative costs', [COSTS_PAGE_SLOT]);
    appPages.select(COSTS_PAGE_SLOT, 'example.costs/page');
    const root = mount(renderPagesMenu(opts));
    expect(link(root, 'example.costs/page')).toBeUndefined();
    expect(link(root, 'example.hidden/page')).toBeUndefined();
    expect(link(root, COSTS_PAGE_ID)?.getAttribute('href')).toBe('/plugins/helmsman.costs/page?repo=org%2Fa');
    expect(appPages.resolvePath('/plugins/example.hidden/page')?.page?.title).toBe('Header only');
  });

  it('keeps a missing selected alias unavailable while offering the default canonical page explicitly', () => {
    appPages.select(COSTS_PAGE_SLOT, 'example.missing/page');
    const active = { ...opts, active: 'plugin' as const, pluginSlot: COSTS_PAGE_SLOT, pluginPage: 'example.missing/page' };
    const root = mount(renderHelmHead(active));
    expect(root.querySelector('.page-tab.is-active')?.id).toBe('page-tab-outcomes');
    expect(root.querySelector('.page-tab.is-active')?.getAttribute('href')).toBe('/outcomes?repo=org%2Fa');
    expect(link(root, COSTS_PAGE_ID)?.getAttribute('href')).toBe('/plugins/helmsman.costs/page?repo=org%2Fa');
    expect(appPages.selected(COSTS_PAGE_SLOT).page).toBeNull();
    expect(appPages.selected(COSTS_PAGE_SLOT).contributionId).toBe('example.missing/page');
  });

  it('keeps an incompatible selected contribution discoverable at its canonical route', () => {
    register('example.source', 'Source alternative');
    appPages.restoreSelection(SOURCE_SETTINGS_PAGE_SLOT, 'example.source/page');
    const root = mount(renderPagesMenu(opts));
    expect(link(root, 'example.source/page')?.getAttribute('href')).toBe('/plugins/example.source/page?repo=org%2Fa');
    expect(appPages.selected(SOURCE_SETTINGS_PAGE_SLOT).page).toBeNull();
    register('example.costs', 'Costs alternative');
    appPages.restoreSelection(COSTS_PAGE_SLOT, 'example.costs/page');
    const head = mount(renderHelmHead({ ...opts, active: 'plugin', pluginPage: 'example.costs/page' }));
    expect(link(head, 'example.costs/page')?.getAttribute('href')).toBe('/plugins/example.costs/page?repo=org%2Fa');
    expect(head.querySelector('.page-tab.is-active')?.id).toBe('page-tab-plugin');
  });

  it('sorts titles and disambiguates duplicate user content safely', () => {
    register('example.z', '<img src=x>');
    register('example.a', '<IMG SRC=X>');
    register('example.b', 'Zulu');
    const root = mount(renderPagesMenu(opts));
    const links = [...root.querySelectorAll('[data-page-link]')];
    expect(links.map(item => item.getAttribute('data-page-contribution'))).toEqual(['example.a/page', 'example.z/page', 'example.b/page']);
    expect(links.slice(0, 2).map(item => item.querySelector('small')?.textContent)).toEqual(['example.a/page', 'example.z/page']);
    expect(links[2]?.querySelector('small')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
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
    expect(root.querySelector('#page-tab-outcomes')?.previousElementSibling?.id).toBe('page-tab-runs');
    expect(root.querySelector('#page-tab-outcomes')?.nextElementSibling?.id).toBe('page-tab-campaigns');
    expect(link(root, COSTS_PAGE_ID)?.getAttribute('aria-current')).toBe('page');
  });

  it('preserves the unavailable active tab after an external page is removed', () => {
    register('example.summary', 'Summary');
    disposers.pop()?.();
    const root = mount(renderHelmHead({ ...opts, active: 'plugin', pluginPage: 'example.summary/page' }));
    expect(root.querySelector('.page-tab.is-active')?.textContent).toBe(term('unavailablePluginPage'));
    expect(root.querySelector('.page-tab.is-active')?.getAttribute('href')).toBe('/plugins/example.summary/page?repo=org%2Fa');
    expect(link(root, 'example.summary/page')).toBeUndefined();
  });

  it('keeps the menu discoverable when no additional pages are enabled', () => {
    const root = mount(renderPagesMenu(opts));
    expect(root.querySelector('summary')?.textContent).toBe('Pages');
    expect(root.querySelector('nav')?.textContent).toBe('No additional pages are enabled.');
    expect(root.querySelector('[data-page-link]')).toBeNull();
  });
});

describe('section navigation', () => {
  const configPaths = ['/config', '/source-settings', '/execution-settings', '/feedback-settings', '/jira-settings', '/github-settings', '/communication', '/local-git'];
  const runPaths = ['/runs', '/run-history', '/run-viewer'];
  function head(path: string) {
    const route = parseRoute(new URL(path, window.location.origin));
    return mount(renderHelmHead({ ...opts, active: route.view, selectedRepo: route.repo, pluginPage: route.pluginPage, pluginSlot: route.pluginSlot }));
  }
  function paths(root: HTMLElement) {
    return [...root.querySelectorAll<HTMLAnchorElement>('.section-nav a')].map(anchor => new URL(anchor.href).pathname);
  }

  it.each([...configPaths, ...runPaths])('keeps the full section available on direct navigation to %s', path => {
    const expected = configPaths.includes(path) ? configPaths : runPaths;
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
      expect([...new URL(anchor.href).searchParams]).toEqual([['repo', 'org/a']]);
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
    expect(root.querySelectorAll('.section-nav a')).toHaveLength(configPaths.length);
  });

  it('retains the section and alias when a selected child implementation is unavailable', () => {
    appPages.select(SOURCE_SETTINGS_PAGE_SLOT, 'example.missing/page');
    const root = head('/source-settings?repo=org/a');
    expect(paths(root)).toEqual(configPaths);
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
});
