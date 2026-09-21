import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from './pagePaths';
import { appPages, COSTS_PAGE_ALIAS, COSTS_PAGE_ID, COSTS_PAGE_SLOT, HELM_PAGE_SLOT } from '../plugins/builtins';
import { isContributionId } from '../plugins/manifest';

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
  panelInstance?: string | null;
  panelContribution?: string | null;
  panelState?: string | null;
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

function panelState(value: string | null): string | null {
  if (!value || value.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 16) return null;
    for (const [id, state] of Object.entries(parsed)) {
      if (!isContributionId(id) || !state || typeof state !== 'object' || Array.isArray(state)) return null;
      const record = state as Record<string, unknown>;
      if (!Number.isSafeInteger(record.version) || Number(record.version) < 1 || !Object.hasOwn(record, 'value')
        || Object.keys(record).some(key => key !== 'version' && key !== 'value')) return null;
    }
    return value;
  } catch { return null; }
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
  const helm = plugin?.slotId === HELM_PAGE_SLOT || plugin?.page?.composition?.id === HELM_PAGE_SLOT;
  const rawPane = params.get('pane');
  const pane = helm && rawPane === 'myprs' ? 'repoprs' : rawPane;
  const legacyPane = helm && pane && panes.dashboard.includes(pane) ? pane : null;
  const run = params.get('run');
  const mode = params.get('mode');
  const ticket = params.get('ticket');
  const surface = params.get('surface');
  const validTicket = ticket && /^[a-z][a-z\d_]{0,49}-[1-9]\d{0,14}$/i.test(ticket) ? ticket.toUpperCase() : null;
  const explicitInstance = params.get('panel');
  const locatorPane = legacyPane ?? (helm && validTicket && !explicitInstance ? 'newrun' : null);
  const instance = explicitInstance ?? locatorPane;

  return {
    view,
    repo,
    prRepo,
    pane: locatorPane ?? (pane && (plugin?.page?.panes ?? (view === 'outcomes' || view === 'plugin' ? [] : panes[view])).includes(pane) ? pane : null),
    pr: prTarget ? positiveInteger(params.get('pr')) : null,
    run: run && /^[a-z\d_-]{1,128}$/i.test(run) ? run : null,
    mode: (view === 'runs' || view === 'prs') && (mode === 'review' || mode === 'rerun') ? mode : null,
    ticket: view !== 'plugin' || helm ? validTicket : null,
    surface: view === 'cmux' && isSurfaceRef(surface) ? surface : null,
    ...(instance && /^[a-z\d][a-z\d_.:-]{0,159}$/i.test(instance) ? { panelInstance: instance, panelState: panelState(params.get('panelState')) } : {}),
    ...(plugin && params.has('panelState') ? { panelState: panelState(params.get('panelState')) } : {}),
    ...(helm && locatorPane && !explicitInstance ? { panelContribution: `helmsman.${locatorPane}/panel` } : {}),
    ...(plugin && (plugin.slotId === null || view === 'plugin') ? {
      pluginPage: plugin.contributionId,
      ...(plugin.slotId ? { pluginSlot: plugin.slotId } : {}),
    } : {}),
  };
}

function routePath(route: Partial<AppRoute> & { view: PageView }): string {
  if (route.view === 'plugin' || route.view === 'outcomes') {
    if (route.pluginSlot) {
      const slot = appPages.getSlot(route.pluginSlot);
      if (slot) return slot.alias;
    }
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
  if (route.panelInstance && !(route.panelContribution && route.panelInstance === route.pane)) url.searchParams.set('panel', route.panelInstance);
  if (route.panelState) url.searchParams.set('panelState', route.panelState);
  const normalized = parseRoute(url);
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = normalized[key];
    if (value !== null) params.set(key, String(value));
  }
  if (normalized.panelInstance && !(normalized.panelContribution && normalized.panelInstance === normalized.pane)) params.set('panel', normalized.panelInstance);
  if (normalized.panelState) params.set('panelState', normalized.panelState);
  const query = params.toString();
  return `${routePath(normalized)}${query ? `?${query}` : ''}`;
}
