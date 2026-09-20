import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from './pagePaths';
import { appPages, COSTS_PAGE_ALIAS, COSTS_PAGE_ID, COSTS_PAGE_SLOT } from '../plugins/builtins';

export type PageView = keyof typeof LEGACY_PAGE_PATHS | 'outcomes' | 'plugin';

export interface AppRoute {
  view: PageView;
  repo: string | null;
  prRepo: string | null;
  pane: string | null;
  pr: number | null;
  run: string | null;
  mode: 'review' | 'rerun' | null;
  ticket: string | null;
  surface: string | null;
  pluginPage?: string;
  pluginSlot?: string;
}

const panes: Record<keyof typeof LEGACY_PAGE_PATHS, readonly string[]> = {
  dashboard: ['newrun', 'backlog', 'underway', 'running', 'recent', 'repoprs', 'shipped', 'activity'],
  triage: ['backlog', 'todo', 'mine'],
  cmux: ['tabs', 'screen'],
  bugs: [],
  prs: ['review-requests', 'authored', 'lookup', 'diff'],
  config: ['local-git'],
  runs: ['recent', 'newrun', 'tasks'],
  todos: ['list', 'new'],
  campaigns: [],
  clarifications: [],
};

function validRepo(value: string | null): string | null {
  if (!value) return null;
  const [owner, name, extra] = value.split('/');
  if (extra !== undefined || !owner || !name) return null;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) return null;
  return /^[a-z\d_.-]{1,100}$/i.test(name) && name !== '.' && name !== '..' ? value : null;
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * A surface ref reaches us from the URL, so it is validated before it can be
 * put back on the wire. Two terminal bridges produce two shapes:
 *   - cmux: `surface:<n>`, 1-based
 *   - wezterm: a bare pane id, 0-based
 */
function isSurfaceRef(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith('surface:')) return positiveInteger(value.slice(8)) !== null;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
}

export function parseRoute(url: URL): AppRoute {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const plugin = appPages.resolvePath(pathname);
  const legacy = (Object.keys(LEGACY_PAGE_PATHS) as (keyof typeof LEGACY_PAGE_PATHS)[])
    .find(page => LEGACY_PAGE_PATHS[page] === pathname);
  const alias = Object.entries(LEGACY_PAGE_ALIASES).find(([path]) => path === pathname)?.[1];
  const view: PageView = plugin ? plugin.page?.contributionId === COSTS_PAGE_ID ? 'outcomes' : 'plugin'
    : legacy ?? alias ?? 'dashboard';
  const params = url.searchParams;
  const repo = validRepo(params.get('repo'));
  const supportsPrPanel = view === 'prs' || view === 'runs';
  const prRepo = supportsPrPanel ? validRepo(params.get('prRepo')) : null;
  const prTarget = supportsPrPanel && params.has('prRepo') ? prRepo : repo;
  const pane = params.get('pane');
  const run = params.get('run');
  const mode = params.get('mode');
  const ticket = params.get('ticket');
  const surface = params.get('surface');

  return {
    view,
    repo,
    prRepo,
    pane: pane && (plugin?.page?.panes ?? (view === 'outcomes' || view === 'plugin' ? [] : panes[view])).includes(pane) ? pane : null,
    pr: prTarget ? positiveInteger(params.get('pr')) : null,
    run: run && /^[a-z\d_-]{1,128}$/i.test(run) ? run : null,
    mode: (view === 'runs' || view === 'prs') && (mode === 'review' || mode === 'rerun') ? mode : null,
    ticket: view !== 'plugin' && ticket && /^[a-z][a-z\d_]{0,49}-[1-9]\d{0,14}$/i.test(ticket) ? ticket.toUpperCase() : null,
    surface: view === 'cmux' && isSurfaceRef(surface) ? surface : null,
    ...(plugin && (plugin.slotId === null || view === 'plugin') ? {
      pluginPage: plugin.contributionId,
      ...(plugin.slotId ? { pluginSlot: plugin.slotId } : {}),
    } : {}),
  };
}

function routePath(route: Partial<AppRoute> & { view: PageView }): string {
  if (route.view === 'plugin' || route.view === 'outcomes') {
    if (route.pluginSlot === COSTS_PAGE_SLOT) return COSTS_PAGE_ALIAS;
    if (route.pluginPage) {
      const path = `/plugins/${route.pluginPage}`;
      if (appPages.resolvePath(path)?.contributionId === route.pluginPage) return path;
    }
    return route.view === 'outcomes' ? COSTS_PAGE_ALIAS : LEGACY_PAGE_PATHS.dashboard;
  }
  return LEGACY_PAGE_PATHS[route.view];
}

export function isAppPagePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return Object.values(LEGACY_PAGE_PATHS).some(value => value === path)
    || Object.keys(LEGACY_PAGE_ALIASES).includes(path) || appPages.resolvePath(path) !== null;
}

export function routeHref(route: Partial<AppRoute> & { view: PageView }): string {
  const url = new URL(routePath(route), 'http://helmsman.local');
  const keys = ['repo', 'prRepo', 'pane', 'pr', 'run', 'mode', 'ticket', 'surface'] as const;
  for (const key of keys) {
    const value = route[key];
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const normalized = parseRoute(url);
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = normalized[key];
    if (value !== null) params.set(key, String(value));
  }
  const query = params.toString();
  return `${routePath(normalized)}${query ? `?${query}` : ''}`;
}
