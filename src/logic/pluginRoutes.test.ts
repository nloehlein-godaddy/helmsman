import { afterEach, describe, expect, it } from 'vitest';
import { appPages, COSTS_PAGE_ID, COSTS_PAGE_SLOT, TODOS_PAGE_SLOT, TRIAGE_PAGE_SLOT } from '../plugins/builtins';
import { isAppPagePath, parseRoute, routeHref } from './routes';

const parse = (path: string) => parseRoute(new URL(path, 'https://helmsman.example'));
const disposers: (() => void)[] = [];

afterEach(() => {
  appPages.select(COSTS_PAGE_SLOT, null);
  appPages.select(TODOS_PAGE_SLOT, null);
  appPages.select(TRIAGE_PAGE_SLOT, null);
  disposers.splice(0).forEach(dispose => dispose());
});

describe('registered page routes', () => {
  it.each([
    ['/todos', 'new', 'helmsman.todos-ui/panel'], ['/todos', 'list', 'helmsman.todos-ui/panel'],
    ['/triage', 'backlog', 'helmsman.triage/panel'], ['/triage', 'todo', 'helmsman.triage/panel'], ['/triage', 'mine', 'helmsman.triage/panel'],
  ])('preserves the legacy pane at %s?pane=%s without inventing an instance', (path, pane, contribution) => {
    const route = parse(`${path}?repo=org/a&pane=${pane}`);
    expect(route).toMatchObject({ view: 'plugin', pane, panelContribution: contribution });
    expect(route.panelInstance).toBeUndefined();
    expect(JSON.parse(route.panelState!)).toEqual({ [contribution]: { version: 1, value: { pane } } });
    expect(parse(routeHref({ ...route, repo: 'org/b' }))).toMatchObject({ ...route, repo: 'org/b' });
    const exact = parse(`${path}?pane=${pane}&panel=missing-instance`);
    expect(exact.panelInstance).toBe('missing-instance');
    expect(exact.panelContribution).toBeUndefined();
  });

  it('keeps replacement page panes free of builtin task locators', () => {
    disposers.push(appPages.register({ manifestVersion: 2, sdkVersion: 1, id: 'example.todos', version: '1.0.0',
      pages: [{ id: 'page', title: 'Alternative tasks', slots: [TODOS_PAGE_SLOT], panes: ['new'],
        composition: { id: TODOS_PAGE_SLOT, version: 1, accepts: [{ id: 'helmsman/todos-panel', version: 1 }] } }], panels: [],
    }));
    appPages.select(TODOS_PAGE_SLOT, 'example.todos/page');
    const route = parse('/todos?repo=org/a&pane=new');
    expect(route).toMatchObject({ view: 'plugin', pluginPage: 'example.todos/page', pane: 'new' });
    expect(route.panelContribution).toBeUndefined();
    expect(route.panelState).toBeUndefined();
    appPages.select(TODOS_PAGE_SLOT, 'example.unavailable/page');
    expect(parse('/todos')).toMatchObject({ pluginPage: 'example.unavailable/page', pluginSlot: TODOS_PAGE_SLOT });
  });

  it('does not broadcast generated task intent from a malformed explicit instance or exceed route-state bounds', () => {
    const malformed = parse('/todos?pane=new&panel=../missing');
    expect(malformed.panelInstance).toBeUndefined();
    expect(malformed.panelContribution).toBeUndefined();
    expect(malformed.panelState).toBeUndefined();
    expect(parse(routeHref(malformed)).panelState).toBeUndefined();
    const namespaces = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`example.panel${index}/panel`, { version: 1, value: {} }]));
    const saved = JSON.stringify(namespaces);
    const bounded = parse(`/todos?pane=new&panelState=${encodeURIComponent(saved)}`);
    expect(bounded.panelState).toBe(saved);
    expect(parse(routeHref(bounded)).panelState).toBe(saved);
  });

  it('retains the Costs alias and its canonical deep link independently', () => {
    expect(parse('/outcomes?repo=org/a&pane=history')).toMatchObject({ view: 'outcomes', pane: 'history', repo: 'org/a' });
    expect(routeHref(parse('/outcomes?repo=org/a&pane=history'))).toBe('/outcomes?repo=org%2Fa&pane=history');
    const canonical = `/plugins/${COSTS_PAGE_ID}?repo=org/a&pane=summary`;
    const route = parse(canonical);
    expect(route).toMatchObject({ view: 'outcomes', pluginPage: COSTS_PAGE_ID, pane: 'summary' });
    expect(routeHref(route)).toBe(`/plugins/${COSTS_PAGE_ID}?repo=org%2Fa&pane=summary`);
  });

  it('uses an explicit replacement while preserving the alias and its source-independent pane', () => {
    disposers.push(appPages.register({ manifestVersion: 1, sdkVersion: 1, id: 'example.costs', version: '1.0.0',
      pages: [{ id: 'summary', title: 'Alternative costs', slots: [COSTS_PAGE_SLOT], panes: ['totals'] }],
    }));
    appPages.select(COSTS_PAGE_SLOT, 'example.costs/summary');
    const route = parse('/outcomes?repo=org/a&pane=totals&ticket=abc-42');
    expect(route).toMatchObject({ view: 'plugin', pluginPage: 'example.costs/summary', pluginSlot: COSTS_PAGE_SLOT,
      pane: 'totals', ticket: null, repo: 'org/a' });
    expect(routeHref(route)).toBe('/outcomes?repo=org%2Fa&pane=totals');
    expect(parse(`/plugins/${COSTS_PAGE_ID}`).view).toBe('outcomes');
  });

  it('keeps missing selections unavailable without substituting the built-in', () => {
    appPages.select(COSTS_PAGE_SLOT, 'missing.costs/page');
    const route = parse('/outcomes?repo=org/a');
    expect(route).toMatchObject({ view: 'plugin', pluginPage: 'missing.costs/page', pluginSlot: COSTS_PAGE_SLOT });
    expect(routeHref(route)).toBe('/outcomes?repo=org%2Fa');
    expect(parse('/plugins/missing.costs/page').view).toBe('plugin');
  });

  it.each(['/helm', '/pr/', '/cmux', '/outcomes/', `/plugins/${COSTS_PAGE_ID}`, '/plugins/missing.costs/page'])
  ('recognizes the same page for production reload: %s', path => expect(isAppPagePath(path)).toBe(true));

  it.each(['/api/outcomes', '/assets/main.js', '/plugins/missing.costs/page.js', '/plugins/missing.costs/page/file',
    '/plugins/missing.costs/%2e%2e', '/plugins/missing/page', '/unregistered'])
  ('does not serve SPA HTML for assets or malformed paths: %s', path => expect(isAppPagePath(path)).toBe(false));

  it('does not serialize unchecked contribution identifiers as paths', () => {
    expect(routeHref({ view: 'plugin', pluginPage: '../../api/config' })).toBe('/helm');
    expect(parse('/plugins/missing.costs/page?repo=../bad').repo).toBeNull();
  });
});
