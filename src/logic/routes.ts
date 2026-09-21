import { validRepo } from './repo';
import { parseTaskRepo } from '../plugins/tasks';
import { LEGACY_PAGE_ALIASES, LEGACY_PAGE_PATHS } from './pagePaths';
import { appPages, COMMUNICATION_PAGE_SLOT, COMMUNICATION_PAGE_ID, COSTS_PAGE_ALIAS, COSTS_PAGE_ID, COSTS_PAGE_SLOT, HELM_PAGE_SLOT, PR_PAGE_ID, PR_PAGE_SLOT, RUNS_PAGE_ID, RUNS_PAGE_SLOT, TODOS_PAGE_ID, TRIAGE_PAGE_ID } from '../plugins/builtins';
import { isContributionId } from '../plugins/manifest';

export type PageView = keyof typeof LEGACY_PAGE_PATHS | 'outcomes' | 'plugin';

export interface AppRoute {
  view: PageView;
  repo: string | null;
  prRepo: string | null;
  slackPrRepo?: string | null;
  slackPr?: number | null;
  pane: string | null;
  pr: number | null;
  run: string | null;
  runRepo?: string | null;
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
  prs: ['review-requests', 'authored', 'recent', 'lookup', 'diff'],
  config: ['local-git'],
  runs: ['recent', 'newrun', 'tasks'],
  todos: ['list', 'new'],
  campaigns: [],
  clarifications: [],
};

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
  if (pathname === '/config') {
    const target = validRepo(url.searchParams.get('slackPrRepo'));
    const number = positiveInteger(url.searchParams.get('slackPr'));
    if (target && number) {
      const next = new URL('/communication', url.origin);
      const header = validRepo(url.searchParams.get('repo'));
      if (header) next.searchParams.set('repo', header);
      next.searchParams.set('prRepo', target); next.searchParams.set('pr', String(number));
      return parseRoute(next);
    }
  }
  const plugin = appPages.resolvePath(pathname);
  const legacy = (Object.keys(LEGACY_PAGE_PATHS) as (keyof typeof LEGACY_PAGE_PATHS)[])
    .find(page => LEGACY_PAGE_PATHS[page] === pathname);
  const alias = Object.entries(LEGACY_PAGE_ALIASES).find(([path]) => path === pathname)?.[1];
  const view: PageView = plugin ? plugin.page?.contributionId === COSTS_PAGE_ID ? 'outcomes' : 'plugin'
    : legacy ?? alias ?? 'dashboard';
  const params = url.searchParams;
  const repo = validRepo(params.get('repo'));
  const runsPage = plugin?.slotId === RUNS_PAGE_SLOT || plugin?.page?.composition?.id === RUNS_PAGE_SLOT || plugin?.contributionId === RUNS_PAGE_ID;
  const prPage = plugin?.slotId === PR_PAGE_SLOT || plugin?.page?.composition?.id === PR_PAGE_SLOT || plugin?.contributionId === PR_PAGE_ID;
  const communicationPage = plugin?.slotId === COMMUNICATION_PAGE_SLOT || plugin?.page?.composition?.id === COMMUNICATION_PAGE_SLOT || plugin?.contributionId === COMMUNICATION_PAGE_ID;
  const supportsPrPanel = view === 'prs' || view === 'runs' || runsPage || prPage || communicationPage;
  const slackPrRepo = view === 'config' ? validRepo(params.get('slackPrRepo')) : null;
  const slackPr = slackPrRepo ? positiveInteger(params.get('slackPr')) : null;
  const prRepo = supportsPrPanel ? validRepo(params.get('prRepo')) : null;
  const prTarget = supportsPrPanel && params.has('prRepo') ? prRepo : repo;
  const helm = plugin?.slotId === HELM_PAGE_SLOT || plugin?.page?.composition?.id === HELM_PAGE_SLOT;
  const rawPane = params.get('pane');
  const pane = helm && rawPane === 'myprs' ? 'repoprs' : rawPane;
  const legacyPane = helm && pane && panes.dashboard.includes(pane) ? pane : null;
  const run = params.get('run');
  let runRepo: string | null = null;
  if (plugin && params.has('runRepo')) {
    try { runRepo = parseTaskRepo(params.get('runRepo')); } catch { runRepo = null; }
  }
  const validRun = run && /^[a-z\d_-]{1,128}$/i.test(run) && !(plugin && params.has('runRepo') && !runRepo) ? run : null;
  const mode = params.get('mode');
  const selectedMode = !communicationPage && supportsPrPanel && (mode === 'review' || mode === 'rerun') ? mode : null;
  const selectedPr = prTarget ? positiveInteger(params.get('pr')) : null;
  const ticket = params.get('ticket');
  const surface = params.get('surface');
  const validTicket = ticket && /^[a-z][a-z\d_]{0,49}-[1-9]\d{0,14}$/i.test(ticket) ? ticket.toUpperCase() : null;
  const explicitInstance = params.get('panel');
  const validExplicitInstance = explicitInstance && /^[a-z\d][a-z\d_.:-]{0,159}$/i.test(explicitInstance) ? explicitInstance : null;
  const locatorPane = legacyPane ?? (helm && validTicket && !explicitInstance ? 'newrun' : null);
  const taskPane = explicitInstance && !validExplicitInstance ? null : plugin?.contributionId === TODOS_PAGE_ID && pane && panes.todos.includes(pane)
    ? { contribution: 'helmsman.todos-ui/panel', pane }
    : plugin?.contributionId === TRIAGE_PAGE_ID && pane && panes.triage.includes(pane)
      ? { contribution: 'helmsman.triage/panel', pane } : null;
  const runsPanel = runsPage && !explicitInstance ? pane === 'recent' ? { instance: 'run-history', contribution: 'helmsman.run-history/panel' }
    : pane === 'newrun' || selectedPr && pane !== 'tasks' ? { instance: 'pull-request', contribution: 'helmsman.compat-pr/panel' } : null : null;
  const prPanel = prPage && !explicitInstance && (selectedPr || pane && panes.prs.includes(pane)) ? { instance: 'pull-request', contribution: 'helmsman.compat-pr/panel' } : null;
  const communicationPanel = communicationPage && !explicitInstance && selectedPr ? 'review-request' : null;
  const instance = explicitInstance ?? runsPanel?.instance ?? prPanel?.instance ?? communicationPanel ?? locatorPane;
  const savedPanelState = panelState(params.get('panelState'));
  const taskPanelState = taskPane ? panelState(JSON.stringify({
    ...(savedPanelState ? JSON.parse(savedPanelState) as Record<string, unknown> : {}),
    [taskPane.contribution]: { version: 1, value: { pane: taskPane.pane } },
  })) ?? savedPanelState : null;
  const runsPanelState = (runsPage || prPage) && selectedPr && prTarget ? panelState(JSON.stringify({
    ...(savedPanelState ? JSON.parse(savedPanelState) as Record<string, unknown> : {}),
    'helmsman.compat-pr/panel': { version: 1, value: { target: { repo: prTarget, number: selectedPr }, mode: selectedMode } },
  })) ?? savedPanelState : savedPanelState;

  return {
    view,
    repo,
    prRepo,
    ...(slackPrRepo && slackPr ? { slackPrRepo, slackPr } : {}),
    pane: explicitInstance && !validExplicitInstance ? null : locatorPane ?? taskPane?.pane ?? (pane && (plugin?.page?.panes ?? (runsPage ? panes.runs : prPage ? panes.prs : view === 'outcomes' || view === 'plugin' ? [] : panes[view])).includes(pane) ? pane : null),
    pr: selectedPr,
    run: validRun,
    ...(validRun && runRepo ? { runRepo } : {}),
    mode: selectedMode,
    ticket: view !== 'plugin' || helm || runsPage || prPage ? validTicket : null,
    surface: view === 'cmux' && isSurfaceRef(surface) ? surface : null,
    ...(instance && /^[a-z\d][a-z\d_.:-]{0,159}$/i.test(instance) ? { panelInstance: instance, panelState: panelState(params.get('panelState')) } : {}),
    ...(plugin && params.has('panelState') ? { panelState: panelState(params.get('panelState')) } : {}),
    ...(helm && locatorPane && !explicitInstance ? { panelContribution: `helmsman.${locatorPane}/panel` } : {}),
    ...(taskPane ? { panelState: taskPanelState, ...(!explicitInstance ? { panelContribution: taskPane.contribution } : {}) } : {}),
    ...((runsPage || prPage) && runsPanelState ? { panelState: runsPanelState } : {}),
    ...(runsPanel ? { panelContribution: runsPanel.contribution } : {}),
    ...(prPanel ? { panelContribution: prPanel.contribution } : {}),
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

function hasExplicitPanel(route: Partial<AppRoute>): boolean {
  if (!route.panelInstance) return false;
  if (route.panelContribution && route.panelInstance === route.pane) return false;
  const runsPage = route.pluginSlot === RUNS_PAGE_SLOT || route.pluginPage === RUNS_PAGE_ID
    || route.pluginPage && appPages.resolvePath(`/plugins/${route.pluginPage}`)?.page?.composition?.id === RUNS_PAGE_SLOT;
  const prPage = route.pluginSlot === PR_PAGE_SLOT || route.pluginPage === PR_PAGE_ID
    || route.pluginPage && appPages.resolvePath(`/plugins/${route.pluginPage}`)?.page?.composition?.id === PR_PAGE_SLOT;
  if (prPage && route.panelInstance === 'pull-request' && route.panelContribution === 'helmsman.compat-pr/panel') return false;
  if (runsPage && (route.panelInstance === 'run-history' && route.panelContribution === 'helmsman.run-history/panel'
    || route.panelInstance === 'pull-request' && route.panelContribution === 'helmsman.compat-pr/panel')) return false;
  return true;
}

export function routeHref(route: Partial<AppRoute> & { view: PageView }): string {
  const url = new URL(routePath(route), 'http://helmsman.local');
  const keys = ['repo', 'prRepo', 'pane', 'pr', 'run', 'runRepo', 'mode', 'ticket', 'surface', 'slackPrRepo', 'slackPr'] as const;
  for (const key of keys) {
    const value = route[key];
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  if (hasExplicitPanel(route) && route.panelInstance) url.searchParams.set('panel', route.panelInstance);
  if (route.panelState) url.searchParams.set('panelState', route.panelState);
  const normalized = parseRoute(url);
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = normalized[key];
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  if (hasExplicitPanel(normalized) && normalized.panelInstance) params.set('panel', normalized.panelInstance);
  if (normalized.panelState) params.set('panelState', normalized.panelState);
  const query = params.toString();
  return `${routePath(normalized)}${query ? `?${query}` : ''}`;
}
