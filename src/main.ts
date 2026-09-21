import { AuxiliaryPageHost } from './plugins/auxiliary-page-host';
import { scopedPresentationLocatorV1, type PresentationLocatorV1 } from './plugins/presentation';
import { applyBootTerminology } from './logic/bootTerminology';
import { term, setPirateMode, isPirateMode } from './logic/terminology';
import { loadProfile } from './data/profile';
import { getContext } from './data/context';
import { emptyLocalGit, fetchLocalGit, updateLocalGit, type LocalGitAction, type LocalGitState } from './data/localGit';
import { renderLocalGit } from './renderLocalGit';
import { fetchSlack, markSlackNotificationRead, unavailableSlack, type SlackState } from './data/slack';
import { renderSlack } from './renderSlack';
import { SlackReviewSession } from './slack-review-session';
import './style.css';
import { isAppPagePath, parseRoute, routeHref, type AppRoute, type PageView } from './logic/routes';
import { escapeHtml } from './logic/html';
import { appPages, COSTS_PAGE_SLOT, HELM_PAGE_SLOT, PR_PAGE_SLOT, RUN_HISTORY_PAGE_SLOT, RUN_VIEWER_PAGE_SLOT, RUNS_PAGE_SLOT } from './plugins/builtins';
import { appPageModules, disableBuiltinPageModules, syncBuiltinFrontend } from './plugins/builtin-modules';
import { AppCompositionFactory } from './plugins/app-composition';
import { loadPluginCatalog } from './plugins/runtime';
import { PluginPageHost } from './plugins/page-host';
import type { PluginPageState } from './plugins/sdk';
import { mountCampaigns } from './renderCampaigns';
import { LOCAL_POLL_MS } from './data/live';
import { activePageTabId, renderAppShell, renderHelmHead, type HelmHeadOpts, renderCmuxView, renderConfigView } from './render';
import { fetchAgents, type RunSummary } from './data/agents';
import { getConfig, setConfig, type UiConfig } from './data/config';
import { selectSurface, isPolling, providerOf, parseCmuxTabs, type CmuxTabView, type PanelState } from './logic/cmuxPanel';
import { mapKeyEvent, type CmuxKeyIntent } from './logic/cmuxKeys';
import { applyTheme, loadThemeId, saveThemeId } from './data/themes';
import {
  loadRepoScope,
  saveRepoScope,
  loadCollapsed,
  saveCollapsed,
} from './logic/prefs';

const CMUX_SCREEN_POLL_MS: number = 2_000;
const CMUX_SCREEN_UNAVAILABLE: string = 'Screen unavailable — tab has no rendered output yet.';

interface CmuxScreenPayload {
  surface?: string;
  text?: string;
}

interface CmuxEventPayload {
  kind?: string;
}

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly rootEvents = new window.AbortController();
  private readonly slackReviews = new SlackReviewSession();
  private readonly auxiliary: AuxiliaryPageHost;
  private presentationSelection: { locator: Exclude<PresentationLocatorV1, { kind: 'pull-request' }>; scopeRepo: string | null } | null = null;
  private destroyed = false;
  private contentView: PageView | null = null;
  private repos: string[] = [];
  private selectedRepo: string | null = loadRepoScope();
  private runs: RunSummary[] = [];
  private uiConfig: UiConfig = { config: {}, overridden: [] };
  private configLoaded = false;
  private configLoading = false;
  private configError: string | null = null;
  private configSeq = 0;
  private configDrafts = new Map<string, string>();
  private configErrors = new Map<string, string>();
  private configPendingKeys = new Set<string>();
  private collapsed: Set<string> = loadCollapsed();
  private refreshSeq: number = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPending: { repo: string | null; promise: Promise<void> } | null = null;
  private lastLocalRefresh: number = -Infinity;
  private readonly onVisibilityChange = (): void => {
    this.syncCmuxPolling();
    if (this.isPluginPage()) this.paintPluginPage();
    if (!document.hidden) {
      void this.refresh(false);
      if (this.view === 'cmux') void this.handleCmuxTabsChanged();
    }
  };
  private view: PageView = parseRoute(new URL('/helm', window.location.origin)).view;
  private route: AppRoute = parseRoute(new URL('/helm', window.location.origin));
  private routeSeq: number = 0;
  private localGit: LocalGitState = emptyLocalGit(null);
  private localGitSeq: number = 0;
  private localGitPending: { repo: string; promise: Promise<void> } | null = null;
  private localGitOperations = new Map<string, Promise<void>>();
  private readonly onResize = (): void => { this.revealActiveTab(); };
  private readonly onPopState = (): void => { void this.navigate(parseRoute(new URL(window.location.href)), 'none'); };
  private cmuxConnected: boolean = false;
  private cmuxTabsError: string | null = null;
  private cmuxTabsSeq = 0;
  private cmuxTabs: CmuxTabView[] = [];
  private cmuxPanelState: PanelState = { selectedSurface: null };
  private cmuxScreen: string = '';
  private cmuxScreenTimer: ReturnType<typeof setInterval> | null = null;
  private cmuxScreenPending: boolean = false;
  private cmuxEventSource: EventSource | null = null;
  private cmuxCapturing: boolean = false;
  private readonly onCaptureKeydown = (event: KeyboardEvent): void => this.handleCaptureKeydown(event);
  private themeId: string = loadThemeId();
  private greetingName: string | null = null;
  private configSaves: number = 0;
  private pendingViewActions: number = 0;
  private jiraEnabled: boolean = true;
  private slack: SlackState = unavailableSlack();
  private slackOpen: boolean = false;
  private slackError: string | null = null;
  private slackSeq: number = 0;
  private slackReads = new Set<string>();
  private campaigns: ReturnType<typeof mountCampaigns> | null = null;
  private unsubscribePages: (() => void) | null = null;
  private unsubscribePageModules: (() => void) | null = null;
  private pageHost: PluginPageHost | null = null;
  private readonly compositions = new AppCompositionFactory();

  constructor(root: HTMLElement) {
    this.root = root;
    this.slackReviews.subscribe(() => { if (!this.destroyed) this.paintSlackReviewRequests(); });
    applyTheme(this.themeId);
    this.root.addEventListener('click', (event: MouseEvent): void => this.handleClick(event), { signal: this.rootEvents.signal });
    this.root.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.slackOpen) {
        this.slackOpen = false;
        this.paintSlack();
        this.root.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus();
        return;
      }
      const tab = event.target;
      if (tab instanceof HTMLAnchorElement && tab.matches('.page-tab')) {
        const tabs = Array.from(this.root.querySelectorAll<HTMLAnchorElement>('.page-tab'));
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) {
          event.preventDefault();
          tabs.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1; });
          tabs[next]?.focus();
        } else if (event.key === ' ') {
          event.preventDefault();
          tab.click();
        }
        return;
      }
    }, { signal: this.rootEvents.signal });
    this.root.addEventListener('change', (event: Event): void => {
      const control = event.target;
      if (control instanceof HTMLInputElement && control.matches('.local-git-cleanup-force')) {
        if (control.disabled || this.localGit.loading || this.localGit.pendingAction) return;
        this.localGit = { ...this.localGit, cleanup: undefined, cleanupForce: control.checked };
        this.paintLocalGit();
        this.root.querySelector<HTMLInputElement>('.local-git-cleanup-force')?.focus();
        return;
      }
      if (!(control instanceof HTMLSelectElement)) return;
      if (control.matches('.repo-select')) {
        const panelState = this.panelRouteState() ?? {};
        const nextPanelState = { ...panelState };
        if (this.route.pr && !this.route.prRepo) delete nextPanelState['helmsman.compat-pr/panel'];
        void this.navigate({ ...this.route, view: this.view, repo: control.value || null, prRepo: null, pr: null, run: null,
          panelState: Object.keys(nextPanelState).length ? JSON.stringify(nextPanelState) : null });
      } else if (control.matches('.theme-select')) {
        this.themeId = control.value;
        applyTheme(this.themeId);
        saveThemeId(this.themeId);
        if (this.isPluginPage()) this.paintPluginPage();
      }
    }, { capture: true, signal: this.rootEvents.signal });
    this.root.addEventListener('submit', (event: SubmitEvent): void => this.handleSubmit(event), { signal: this.rootEvents.signal });
    this.root.addEventListener('paste', (event: ClipboardEvent): void => void this.handlePasteImage(event), { signal: this.rootEvents.signal });

    this.auxiliary = new AuxiliaryPageHost(this.pluginPresentationState(), {
      slotId: RUN_VIEWER_PAGE_SLOT, registry: appPages, modules: appPageModules,
      createComposition: (id, owner, state) => this.compositions.create(id, owner, state,
        href => this.navigatePluginHref(href), (locator, scopeRepo) => this.selectPluginPresentation(locator, scopeRepo)),
      navigate: href => this.navigatePluginHref(href),
      selectPresentation: (locator, scopeRepo) => this.selectPluginPresentation(locator, scopeRepo),
      loadingMessage: () => term('loadingPluginPage'), errorMessage: () => term('failedPluginPage'),
      unavailableMessage: () => term('unavailablePluginMessage'),
    });
  }

  async start(): Promise<void> {
    this.unsubscribePages ??= appPages.subscribe(() => {
      if (this.destroyed) return;
      const next = parseRoute(new URL(window.location.href));
      if (this.view === 'outcomes' || this.view === 'plugin') {
        if (next.view !== this.view || next.pluginPage !== this.route.pluginPage || next.pluginSlot !== this.route.pluginSlot) {
          void this.navigate(next, 'replace');
        } else {
          this.updateAddress(next, 'replace');
          this.syncShell();
          this.paintPluginPage();
        }
      } else this.syncShell();
    });
    this.unsubscribePageModules ??= appPageModules.subscribe(() => {
      if (!this.destroyed && this.isPluginPage()) this.paintPluginPage();
    });
    void this.loadGreeting();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const route = parseRoute(new URL(window.location.href));
    this.route = route;
    this.selectedRepo = route.repo;
    this.view = route.view;
    const context = await getContext();
    if (this.destroyed) return;
    if (context) {
      this.repos = context.repos;
      this.jiraEnabled = context.jiraEnabled !== false;
    }
    await this.refresh();
    if (this.destroyed) return;
    await this.navigate(parseRoute(new URL(window.location.href)), 'replace');
    if (this.destroyed) return;
    this.refreshTimer = setInterval(() => void this.refresh(false), LOCAL_POLL_MS);
  }

  private async loadGreeting(): Promise<void> {
    const profile = await loadProfile();
    if (this.destroyed) return;
    this.greetingName = profile.displayName ?? profile.login;
    this.syncShell();
  }

  private syncPirateToggle(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-pirate-mode]');
    if (toggle) {
      toggle.disabled = this.configSaves > 0 || this.pendingViewActions > 0;
      toggle.setAttribute('aria-pressed', String(isPirateMode()));
      toggle.title = `Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}`;
    }
  }

  private async withStableView(action: () => Promise<void>): Promise<void> {
    ++this.pendingViewActions;
    this.syncPirateToggle();
    try {
      await action();
    } finally {
      --this.pendingViewActions;
      this.syncPirateToggle();
    }
  }

  private changePirateMode(enabled: boolean): void {
    if (this.configSaves > 0 || this.pendingViewActions > 0) return;
    const controls = (): Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> => {
      const result = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
      const occurrences = new Map<string, number>();
      for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
        const identity = `${control.tagName}:${control.id || control.name || control.className}`;
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        result.set(`${identity}:${occurrence}`, control);
      }
      return result;
    };
    const savedControls = controls();
    const openDetails = Array.from(this.root.querySelectorAll('details'), detail => detail.open);
    const pageScroll = this.root.querySelector('#page-content')?.scrollTop ?? 0;
    setPirateMode(enabled);
    this.paint();
    this.paintSlack();
    this.updateAddress(this.route, 'replace');
    const template = document.createElement('template');
    template.innerHTML = renderAppShell(this.shellOptions(), '');
    const footer = template.content.querySelector('.app-footer');
    if (footer) this.root.querySelector('.app-footer')?.replaceWith(footer);
    for (const [key, control] of controls()) {
      const previous = savedControls.get(key);
      if (!previous) continue;
      control.value = previous.value;
      if (control instanceof HTMLInputElement && previous instanceof HTMLInputElement) control.checked = previous.checked;
    }
    this.root.querySelectorAll('details').forEach((detail, index) => { detail.open = openDetails[index] ?? false; });
    const page = this.root.querySelector('#page-content');
    if (page) page.scrollTop = pageScroll;
    this.root.querySelector<HTMLButtonElement>('[data-pirate-mode]')?.focus({ preventScroll: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.rootEvents.abort();
    this.unsubscribePages?.();
    this.unsubscribePages = null;
    this.unsubscribePageModules?.();
    this.unsubscribePageModules = null;
    this.pageHost?.dispose();
    this.pageHost = null;
    this.auxiliary.dispose();
    this.compositions.dispose();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    ++this.routeSeq;
    ++this.refreshSeq;
    ++this.localGitSeq;
    ++this.slackSeq;
    window.removeEventListener('popstate', this.onPopState);
    this.stopCmuxScreenPoll();
    this.stopCapture();
    this.campaigns?.destroy();
    this.campaigns = null;
    this.slackReviews.dispose();
    this.cmuxEventSource?.close();
  }

  private updateAddress(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): void {
    const href = routeHref(route);
    this.route = parseRoute(new URL(href, window.location.origin));
    if (history === 'replace') window.history.replaceState(null, '', href);
    else if (history === 'push' && href !== window.location.pathname + window.location.search) window.history.pushState(null, '', href);
    document.title = `${route.view === 'plugin' ? (route.pluginPage ? appPages.getPage(route.pluginPage)?.title : null) ?? term('unavailablePluginPage') : route.view === 'dashboard' ? term('dashboard') : route.view === 'prs' ? term('prs') : route.view === 'runs' ? term('runs') : route.view === 'outcomes' ? term('costsOutcomes') : route.view === 'campaigns' ? term('campaigns') : route.view === 'clarifications' ? term('clarifications') : route.view === 'cmux' ? 'Terminal' : route.view[0]!.toUpperCase() + route.view.slice(1)} · Helmsman`;
  }

  private async navigate(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): Promise<void> {
    if (route.view === 'runs' || route.view === 'prs') route = parseRoute(new URL(routeHref(route), window.location.origin));
    if (this.view === 'campaigns' && route.view !== 'campaigns') {
      this.campaigns?.destroy();
      this.campaigns = null;
    }
    if (this.presentationSelection && (route.run !== this.presentationSelection.locator.runId
      || this.presentationSelection.locator.kind === 'run' && route.runRepo !== this.presentationSelection.locator.repo)) this.presentationSelection = null;
    const seq = ++this.routeSeq;
    this.stopCmuxScreenPoll();
    this.stopCapture();
    this.cmuxCapturing = false;
    const scope = route.repo;
    const scopeChanged = this.selectedRepo !== scope;
    if (route.view !== 'outcomes' && route.view !== 'plugin') {
      this.pageHost?.dispose();
      this.pageHost = null;
    }
    if (scopeChanged) {
      this.presentationSelection = null;
      ++this.refreshSeq;
      this.refreshPending = null;
      ++this.localGitSeq;
      this.localGitPending = null;
      this.localGit = emptyLocalGit(scope);
    }
    this.selectedRepo = scope;
    saveRepoScope(scope);
    this.view = route.view;
    if (route.view === 'cmux') {
      this.cmuxPanelState = { selectedSurface: null };
      this.cmuxScreen = '';
    }
    this.updateAddress(route, history);
    if (route.pane) this.collapsed.delete(`${route.view}:${route.pane === 'tabs' ? 'list' : route.pane === 'screen' ? 'detail' : route.pane}`);
    if (!route.run) this.presentationSelection = null;
    this.paint();
    if (scopeChanged) this.paintSlack();
    if (scopeChanged) await this.refresh(false);
    if (seq !== this.routeSeq) return;
    if (this.isPluginPage() && !this.isRunViewerPage()) await this.pageHost?.refresh();
    else if (route.view === 'config') {
      await this.loadUiConfig();
      if (seq !== this.routeSeq) return;
      void this.loadLocalGit();
    }
    else if (route.view === 'cmux') {
      await this.loadCmuxTabs();
      if (seq !== this.routeSeq) return;
      this.cmuxPanelState = { selectedSurface: this.cmuxTabs.some(tab => tab?.surfaceRef === route.surface) ? route.surface : null };
      this.ensureCmuxEvents();
      await this.pollCmuxScreen();
      this.syncCmuxPolling();
    }
    if (seq !== this.routeSeq) return;
    if (route.view !== 'config') this.paint();
    this.rehomeRunViewer();
    this.focusRoute();
  }

  private focusRoute(): void {
    const pane = this.route.pane;
    const target = pane ? this.root.querySelector<HTMLElement>(`[data-pane="${pane}"]`) : null;
    target?.scrollIntoView?.({ block: 'start' });
    if (this.route.mode) this.root.querySelector<HTMLElement>(this.route.mode === 'review' ? '.pr-review-agent' : '.pr-rerun-feedback')?.focus({ preventScroll: true });

  }

  private bindPaneLinks(): void {
    const selectors: Record<string, string> = this.view === 'cmux' ? { tabs: '[data-collapse-id="cmux:list"]', screen: '[data-collapse-id="cmux:detail"]' } : {};
    for (const [pane, selector] of Object.entries(selectors)) {
      const found = this.root.querySelector<HTMLElement>(selector);
      const panel = found?.closest<HTMLElement>('.panel, .faceplate');
      if (!panel) continue;
      panel.dataset.pane = pane;
      const head = panel.querySelector('.panel-head, .faceplate-head');
      if (!head || head.querySelector('.pane-link')) continue;
      const link = document.createElement('a');
      link.className = 'pane-link app-link';
      link.href = routeHref({ ...this.route, view: this.view, pane, repo: this.selectedRepo });
      link.textContent = '↗';
      link.setAttribute('aria-label', `Link to ${panel.querySelector('.panel-title, .faceplate-title')?.textContent ?? pane}`);
      head.append(link);
    }
  }

  refresh(force: boolean = true): Promise<void> {
    if (!force && document.hidden) return Promise.resolve();
    if (this.refreshPending?.repo === this.selectedRepo) {
      const pending = this.refreshPending;
      return pending.promise;
    }
    const repo = this.selectedRepo;
    const promise = this.performRefresh(force).finally(() => {
      if (this.refreshPending?.promise === promise) this.refreshPending = null;
    });
    this.refreshPending = { repo, promise };
    return promise;
  }

  private async performRefresh(force: boolean): Promise<void> {
    const now = Date.now();
    const localDue = force || now - this.lastLocalRefresh >= LOCAL_POLL_MS;
    if (localDue) this.lastLocalRefresh = now;
    const seq: number = ++this.refreshSeq;
    const slackSeq = ++this.slackSeq;
    const repo: string | null = this.selectedRepo;
    const [agents, , slack, context] = await Promise.all([
      localDue ? fetchAgents() : null,
      force ? this.loadUiConfig(false) : null,
      localDue ? fetchSlack() : undefined,
      localDue ? getContext() : null,
    ]);
    if (seq !== this.refreshSeq || repo !== this.selectedRepo) return;
    const priorJiraEnabled = this.jiraEnabled;
    if (agents) {
      this.runs = agents.runs;
    }
    if (context) {
      this.repos = [...new Set(context.repos)].sort();
      if (typeof context.jiraEnabled === 'boolean') this.jiraEnabled = context.jiraEnabled;
    }
    if (priorJiraEnabled !== this.jiraEnabled) {
      this.uiConfig.config.JIRA_ENABLED = String(this.jiraEnabled);
    }
    this.syncShell();
    if (localDue && slackSeq === this.slackSeq) {
      this.slack = slack ?? {
        ...this.slack,
        health: { ...this.slack.health, status: 'unavailable', error: 'Notifications unavailable. Showing saved notifications.' },
        ...(this.slack.githubHealth ? { githubHealth: { ...this.slack.githubHealth, status: 'unavailable' as const, error: 'Notifications unavailable.' } } : {}),
      };
      this.paintSlack();
    }
    if (this.view === 'config' && force) {
      this.paintConfig();
      void this.loadLocalGit();
    } else if (this.isPluginPage() && localDue) {
      this.paintPluginPage();
      const compositionId = appPages.getPage(this.route.pluginPage ?? '')?.composition?.id;
      const managesRefresh = [HELM_PAGE_SLOT, RUN_VIEWER_PAGE_SLOT, RUN_HISTORY_PAGE_SLOT, RUNS_PAGE_SLOT, PR_PAGE_SLOT]
        .some(slot => this.route.pluginSlot === slot || compositionId === slot);
      if (force || !managesRefresh) void (this.isRunViewerPage() ? this.auxiliary.refresh() : this.pageHost?.refresh());
    }
  }

  private paint(): void {
    const focused = document.activeElement;
    const focusedTab = focused instanceof HTMLAnchorElement && this.root.contains(focused) && focused.matches('.page-tab')
      ? focused.id : null;
    const sameView = this.root.querySelector<HTMLElement>('.helm')?.dataset.page === this.view;
    this.paintView();
    this.syncPirateToggle();
    if (focusedTab) {
      const tabs = Array.from(this.root.querySelectorAll<HTMLAnchorElement>('.page-tab'));
      const selected = (sameView ? tabs.find(tab => tab.id === focusedTab) : null)
        ?? tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
      tabs.forEach(tab => { tab.tabIndex = tab === selected ? 0 : -1; });
      selected?.focus({ preventScroll: true });
    }
  }

  private isPluginPage(): boolean {
    return this.view === 'outcomes' || this.view === 'plugin';
  }

  private panelRouteState(): PluginPageState['panelRouteState'] {
    const value = this.route.panelState ? JSON.parse(this.route.panelState) as NonNullable<PluginPageState['panelRouteState']> : {};
    const helm = this.route.pluginSlot === HELM_PAGE_SLOT || appPages.getPage(this.route.pluginPage ?? '')?.composition?.id === HELM_PAGE_SLOT;
    if (!helm || !this.route.ticket || value['helmsman.newrun/panel']) return value;
    return { ...value, 'helmsman.newrun/panel': { version: 1, value: { legacyTicket: this.route.ticket } } };
  }

  private navigatePluginHref(href: string): void {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin === window.location.origin && isAppPagePath(url.pathname)) void this.navigate(parseRoute(url));
    } catch { return; }
  }

  private isRunViewerPage(): boolean {
    return this.route.pluginSlot === RUN_VIEWER_PAGE_SLOT
      || appPages.getPage(this.route.pluginPage ?? '')?.composition?.id === RUN_VIEWER_PAGE_SLOT;
  }

  private pluginPresentationState(): PluginPageState {
    const selected = this.presentationSelection;
    const sameRun = selected?.locator.runId === this.route.run;
    return { repo: this.selectedRepo, themeId: this.themeId, pirateMode: isPirateMode(), visible: !document.hidden, pane: null,
      presentation: sameRun && selected ? selected.locator : this.route.run
        ? this.route.runRepo ? { version: 1, kind: 'run', repo: this.route.runRepo, runId: this.route.run } : { version: 1, kind: 'legacy-run', runId: this.route.run } : null };
  }

  private presentationScopeRepo(): string | null {
    return this.presentationSelection ? this.presentationSelection.scopeRepo
      : this.selectedRepo === null ? null : this.route.runRepo ?? this.selectedRepo;
  }

  private selectPluginPresentation(input: PresentationLocatorV1 | null, scopeRepo: string | null): void {
    if (this.destroyed) return;
    const locator = scopedPresentationLocatorV1(input, scopeRepo);
    if (locator?.kind === 'pull-request') { void this.enterPrView(locator.repo, locator.number); return; }
    const reveal = locator !== null && !this.auxiliary.element.contains(document.activeElement);
    this.presentationSelection = locator ? { locator, scopeRepo } : null;
    this.updateAddress({ ...this.route, run: locator?.runId ?? null, runRepo: locator?.kind === 'run' ? locator.repo : null });
    this.paintPluginPage();
    if (reveal && !this.isRunViewerPage()) queueMicrotask(() => {
      if (this.destroyed || !this.auxiliary.element.isConnected || this.route.run !== locator?.runId) return;
      this.auxiliary.element.tabIndex = -1;
      this.auxiliary.element.focus({ preventScroll: true });
      this.auxiliary.element.scrollIntoView?.({ block: 'start' });
    });
  }

  private paintPluginPage(): void {
    if (this.destroyed || !this.isPluginPage()) return;
    const page = this.route.pluginSlot
      ? appPages.selected(this.route.pluginSlot).page
      : this.route.pluginPage ? appPages.getPage(this.route.pluginPage) : appPages.selected(COSTS_PAGE_SLOT).page;
    const module = page ? appPageModules.get(page.contributionId) : null;
    if (this.isRunViewerPage()) {
      if (!this.root.querySelector('[data-plugin-standalone]')) this.mountPage(renderAppShell(this.shellOptions(), '<div data-plugin-standalone></div>'));
      this.syncShell();
    } else if (!page || !module) {
      this.mountPage(renderAppShell(this.shellOptions(), `<section class="panel"><h1>${escapeHtml(term('unavailablePluginPage'))}</h1><p class="empty-note" role="status">${escapeHtml(term('unavailablePluginMessage'))}</p></section>`));
    } else {
      if (!this.pageHost) {
        this.mountPage(renderAppShell(this.shellOptions(), '<div data-plugin-page-host></div><aside class="plugin-auxiliary-slot" hidden></aside>'));
        const container = this.root.querySelector<HTMLElement>('[data-plugin-page-host]');
        if (!container) return;
        this.pageHost = new PluginPageHost(container, {
          createComposition: (id, owner, state) => this.compositions.create(id, owner, state,
            href => this.navigatePluginHref(href), (locator, scopeRepo) => this.selectPluginPresentation(locator, scopeRepo)),
          navigate: href => this.navigatePluginHref(href),
          selectPresentation: (locator, scopeRepo) => this.selectPluginPresentation(locator, scopeRepo),
          loadingMessage: () => term('loadingPluginPage'),
          errorMessage: () => term('failedPluginPage'),
        });
      }
      const pullRequestRepo = this.route.prRepo ?? this.route.repo;
      const state: PluginPageState = {
        ...this.pluginPresentationState(),
        repo: this.selectedRepo,
        pane: this.route.pane,
        panelInstance: this.route.panelInstance ?? null,
        panelContribution: this.route.panelContribution ?? null,
        panelRouteState: this.panelRouteState(),
        pullRequest: this.route.pr && pullRequestRepo ? { version: 1, repo: pullRequestRepo, number: this.route.pr, mode: this.route.mode } : null,
      };
      this.pageHost.show(page.contributionId, module, state);
      this.syncShell();
    }
    this.bindHeadControls();
    this.rehomeRunViewer();
  }

  private paintView(): void {
    if (this.isPluginPage()) {
      this.paintPluginPage();
      return;
    }
    if (this.view === 'campaigns') {
      const existing = this.root.querySelector<HTMLElement>('#campaigns-page');
      if (!existing || !this.campaigns) {
        this.campaigns?.destroy();
        this.mountPage(renderAppShell(this.shellOptions(), '<div id="campaigns-page"></div>'));
        const container = this.root.querySelector<HTMLElement>('#campaigns-page');
        if (container) {
          this.campaigns = mountCampaigns(container, {
            repo: () => this.selectedRepo,
            onOpenRun: runId => { void this.navigate({ ...this.route, view: 'runs', pane: 'tasks', run: runId }); },
          });
        }
      } else void this.campaigns.refresh();
      this.bindHeadControls();
      this.rehomeRunViewer();
      return;
    }
    if (this.view === 'cmux') {
      this.paintCmux();
      return;
    }
    if (this.view === 'config') {
      this.paintConfig();
      return;
    }
    this.mountPage(renderAppShell(this.shellOptions(), `<p role="status">${escapeHtml(term('unavailablePluginMessage'))}</p>`));
    this.bindHeadControls(); this.rehomeRunViewer();
  }

  private revealActiveTab(): void {
    const tabs = this.root.querySelector<HTMLElement>('.page-tabs');
    const activeTab = tabs?.querySelector<HTMLElement>('.page-tab.is-active');
    if (tabs && activeTab) {
      const right = activeTab.offsetLeft + activeTab.offsetWidth;
      if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
      else if (activeTab.offsetLeft < tabs.scrollLeft) tabs.scrollLeft = activeTab.offsetLeft;
    }
  }

  private shellOptions(): HelmHeadOpts {
    return {
      active: this.view, repos: this.repos, selectedRepo: this.selectedRepo, themeId: this.themeId,
      pluginPage: this.route.pluginPage, pluginSlot: this.route.pluginSlot,
      jiraEnabled: this.jiraEnabled,
      greetingName: this.greetingName,
      readout: {
        running: this.runs.filter(run => run?.status === 'running' && (!this.selectedRepo || run.repo === this.selectedRepo)).length,
        queued: null,
        review: null,
      },
    };
  }

  private mountPage(markup: string): void {
    this.pageHost?.dispose();
    this.pageHost = null;
    if (this.contentView === 'config') this.captureConfigDrafts();
    const template = document.createElement('template');
    template.innerHTML = markup;
    const next = template.content.querySelector('#page-content');
    if (!next) return;
    if (!this.root.querySelector('.helm-head')) {
      this.root.innerHTML = renderAppShell(this.shellOptions(), '');
      this.paintSlack();
    }
    const content = this.root.querySelector<HTMLElement>('#page-content');
    this.auxiliary.park();
    content?.replaceChildren(...next.childNodes);
    if (content && this.contentView !== this.view) content.scrollTop = 0;
    this.contentView = this.view;
    this.syncShell();
    this.paintSlackReviewRequests();
  }

  private syncShell(): void {
    const shell = this.root.querySelector<HTMLElement>('.helm');
    if (!shell) return;
    const opts = this.shellOptions();
    shell.dataset.page = this.view;
    shell.className = `helm${this.view === 'dashboard' ? '' : ` ${this.view}-view`}`;
    this.root.querySelector('#page-content')?.setAttribute('aria-labelledby', activePageTabId(opts));
    const template = document.createElement('template');
    template.innerHTML = renderHelmHead(opts);
    const repo = shell.querySelector<HTMLSelectElement>('.repo-select');
    const nextRepo = template.content.querySelector<HTMLSelectElement>('.repo-select');
    if (repo && nextRepo) {
      if (repo.innerHTML !== nextRepo.innerHTML) repo.innerHTML = nextRepo.innerHTML;
      repo.value = this.selectedRepo ?? '';
      repo.setAttribute('aria-label', nextRepo.getAttribute('aria-label') ?? '');
    }
    const tabs = shell.querySelector('.page-tabs');
    const nextTabs = template.content.querySelector('.page-tabs');
    const tabIds = (node: Element | null) => Array.from(node?.querySelectorAll('.page-tab') ?? []).map(tab => tab.id).join(',');
    if (tabs && nextTabs && tabIds(tabs) !== tabIds(nextTabs)) tabs.replaceChildren(...nextTabs.childNodes);
    for (const next of template.content.querySelectorAll<HTMLAnchorElement>('.page-tab')) {
      const tab = shell.querySelector<HTMLAnchorElement>(`#${next.id}`);
      if (!tab) continue;
      tab.className = next.className;
      tab.textContent = next.textContent;
      for (const name of ['href', 'data-view', 'aria-selected', 'aria-current']) {
        const value = next.getAttribute(name);
        if (value === null) tab.removeAttribute(name);
        else tab.setAttribute(name, value);
      }
      if (!shell.querySelector('.page-tabs')?.contains(document.activeElement)) tab.tabIndex = next.tabIndex;
    }
    for (const next of template.content.querySelectorAll<HTMLElement>('[data-fleet-count]')) {
      const count = shell.querySelector<HTMLElement>(`[data-fleet-count="${next.dataset.fleetCount}"]`);
      if (!count) continue;
      count.textContent = next.textContent;
      if (next.hasAttribute('title')) count.setAttribute('title', next.title);
      else count.removeAttribute('title');
    }
    shell.querySelector('.helm-readout')?.setAttribute('aria-label', term('systemStatus'));
    for (const label of template.content.querySelectorAll<HTMLElement>('[data-readout-label]')) {
      const current = shell.querySelector(`[data-readout-label="${label.dataset.readoutLabel}"]`);
      if (current) current.textContent = label.textContent;
    }
    const repos = shell.querySelector('[data-footer-repos]');
    if (repos) repos.textContent = `${this.repos.length} ${term(this.repos.length === 1 ? 'repository' : 'repositories').toLowerCase()} tracked`;
    const running = shell.querySelector('[data-footer-running]');
    if (running) running.textContent = `${opts.readout?.running ?? '—'} ${term('running').toLowerCase()}`;
    const nextGreeting = template.content.querySelector('[data-greeting]');
    const greeting = shell.querySelector('[data-greeting]');
    if (nextGreeting && greeting) greeting.replaceWith(nextGreeting);
    else if (nextGreeting) shell.querySelector('.nameplate-scope')?.append(nextGreeting);
  }

  private bindHeadControls(): void {
    this.revealActiveTab();
    this.bindPaneLinks();
  }

  private paintSlack(): void {
    const controls = this.root.querySelector('.helm-controls');
    if (!controls) return;
    let center = controls.querySelector<HTMLElement>('.slack-center');
    if (!center) {
      center = document.createElement('div');
      center.className = 'slack-center';
      controls.append(center);
    }
    const focused = document.activeElement;
    const focusReadId = focused instanceof HTMLElement && center.contains(focused) ? focused.dataset.slackRead : undefined;
    const focusToggle = focused instanceof HTMLElement && center.contains(focused) && focused.hasAttribute('data-slack-toggle');
    const scrollTop = center.querySelector('.slack-popover')?.scrollTop ?? 0;
    const template = document.createElement('template');
    template.innerHTML = renderSlack(this.slack, this.slackOpen, this.slackError, undefined, this.selectedRepo);
    const nextToggle = template.content.querySelector<HTMLButtonElement>('[data-slack-toggle]');
    const nextPopover = template.content.querySelector<HTMLElement>('.slack-popover');
    const toggle = center.querySelector<HTMLButtonElement>('[data-slack-toggle]');
    const currentPopover = center.querySelector<HTMLElement>('.slack-popover');
    if (!toggle || !currentPopover || !nextToggle || !nextPopover) center.replaceChildren(...template.content.childNodes);
    else {
      toggle.className = nextToggle.className;
      toggle.setAttribute('aria-expanded', nextToggle.getAttribute('aria-expanded') ?? 'false');
      toggle.setAttribute('aria-label', nextToggle.getAttribute('aria-label') ?? 'Notifications');
      if (toggle.innerHTML !== nextToggle.innerHTML) toggle.innerHTML = nextToggle.innerHTML;
      currentPopover.hidden = nextPopover.hidden;
      if (currentPopover.innerHTML !== nextPopover.innerHTML) currentPopover.innerHTML = nextPopover.innerHTML;
    }
    const popover = center.querySelector('.slack-popover');
    if (popover) popover.scrollTop = scrollTop;
    for (const button of center.querySelectorAll<HTMLButtonElement>('[data-slack-read]')) {
      button.disabled = this.slackReads.has(button.dataset.slackRead ?? '');
    }
    if (focusReadId !== undefined) {
      const button = Array.from(center.querySelectorAll<HTMLButtonElement>('[data-slack-read]')).find(item => item.dataset.slackRead === focusReadId);
      (button ?? center.querySelector<HTMLButtonElement>('[data-slack-toggle]'))?.focus({ preventScroll: true });
    } else if (focusToggle) center.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus({ preventScroll: true });
  }

  private paintSlackReviewRequests(): void {
    this.slackReviews.paint(this.root, String(this.uiConfig.config?.SLACK_ENABLED) !== 'false');
  }

  private async sendSlackReviewRequest(button: HTMLButtonElement): Promise<void> {
    const repo = button.dataset.repo; const number = Number(button.dataset.number);
    if (!repo || !Number.isSafeInteger(number) || number < 1) return;
    await this.slackReviews.request({ repo, number });
  }

  private async readSlackNotification(id: string): Promise<void> {
    if (this.slackReads.has(id)) return;
    this.slackReads.add(id);
    this.slackError = null;
    this.paintSlack();
    const ok = await markSlackNotificationRead(id);
    this.slackReads.delete(id);
    if (ok) {
      ++this.slackSeq;
      this.slack = { ...this.slack, notifications: this.slack.notifications.map(item => item.id === id ? { ...item, readAt: new Date().toISOString() } : item) };
    } else this.slackError = 'Could not mark notification read. Try again.';
    this.paintSlack();
  }

  private paintCmux(): void {
    this.mountPage(renderCmuxView({
      connected: this.cmuxConnected,
      error: this.cmuxTabsError,
      tabs: this.cmuxTabs,
      selectedSurface: this.cmuxPanelState.selectedSurface,
      screen: this.cmuxScreen,
      isCapturing: this.cmuxCapturing,
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      themeId: this.themeId,
      collapsed: this.collapsed,
    }));
    this.bindHeadControls();
  }

  private paintLocalGit(): void {
    if (this.view !== 'config') return;
    const card = this.root.querySelector('.local-git-panel');
    if (card) card.outerHTML = renderLocalGit(this.localGit);
  }

  private loadLocalGit(): Promise<void> {
    const repo = this.selectedRepo;
    if (!repo) {
      this.localGit = emptyLocalGit(null);
      this.paintLocalGit();
      return Promise.resolve();
    }
    const operation = this.localGitOperations.get(repo);
    if (operation) {
      const seq = this.localGitSeq;
      this.localGit = { ...this.localGit, loading: true, pendingAction: 'Waiting for the local Git operation…' };
      this.paintLocalGit();
      return operation.then(() => {
        if (seq === this.localGitSeq && repo === this.selectedRepo) return this.loadLocalGit();
      });
    }
    if (this.localGitPending?.repo === repo) return this.localGitPending.promise;
    const seq = ++this.localGitSeq;
    this.localGit = { ...(this.localGit.repo === repo ? this.localGit : emptyLocalGit(repo)), loading: true, confirmation: undefined, cleanup: undefined, pendingAction: undefined };
    this.paintLocalGit();
    const promise = fetchLocalGit(repo).then(result => {
      if (seq !== this.localGitSeq || repo !== this.selectedRepo) return;
      this.localGit = result;
      this.paintLocalGit();
    }).finally(() => {
      if (this.localGitPending?.promise === promise) this.localGitPending = null;
    });
    this.localGitPending = { repo, promise };
    return promise;
  }

  private confirmLocalGitDeletion(button: HTMLButtonElement): void {
    if (button.disabled || this.localGit.loading || this.localGit.pendingAction || this.localGit.repo !== this.selectedRepo) return;
    const branchName = button.dataset.localBranch;
    const worktreePath = button.dataset.localWorktree;
    const branch = this.localGit.branches.find(item => item?.name === branchName);
    const tree = this.localGit.worktrees.find(item => item?.path === worktreePath);
    if (branch && !branch.current && !branch.deletionBlockedReason) {
      this.localGit = { ...this.localGit, cleanup: undefined, confirmation: { action: 'delete-branch', branch: branch.name, expectedCommit: branch.commit } };
    } else if (tree && !tree.locked && !tree.bare && tree.path !== this.localGit.path && !tree.deletionBlockedReason) {
      this.localGit = { ...this.localGit, cleanup: undefined, confirmation: { action: 'delete-worktree', path: tree.path, expectedCommit: tree.commit } };
    } else return;
    this.paintLocalGit();
    this.root.querySelector<HTMLButtonElement>('.local-git-cancel')?.focus();
  }

  private mutateLocalGit(action: LocalGitAction): Promise<void> {
    const repo = this.selectedRepo;
    if (!repo || this.localGit.repo !== repo || this.localGit.loading || this.localGit.pendingAction || this.localGitOperations.has(repo)) return Promise.resolve();
    const seq = ++this.localGitSeq;
    this.localGit = { ...this.localGit, confirmation: undefined, cleanup: undefined, error: null,
      pendingAction: action.action === 'refresh-remotes' ? 'Fetching remote status…'
        : action.action === 'preview-delete-untracked-branches' ? 'Checking eligible branches…' : 'Deleting…' };
    this.paintLocalGit();
    const promise = updateLocalGit(repo, action).then(result => {
      if (seq !== this.localGitSeq || repo !== this.selectedRepo) return;
      this.localGit = result;
      this.paintLocalGit();
    }).finally(() => {
      if (this.localGitOperations.get(repo) === promise) this.localGitOperations.delete(repo);
    });
    this.localGitOperations.set(repo, promise);
    return promise;
  }

  private captureConfigDrafts(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('.config-row[data-key]')) {
      const key = row.dataset.key;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      if (!key || !input || input.dataset.configValue === undefined) continue;
      if (input.value !== input.dataset.configValue) this.configDrafts.set(key, input.value);
      else this.configDrafts.delete(key);
    }
  }

  private async loadUiConfig(paint = true): Promise<void> {
    if (this.configPendingKeys.size > 0) return;
    const seq = ++this.configSeq;
    this.configLoading = true;
    if (paint && this.view === 'config') this.paintConfig();
    const config = await getConfig();
    if (seq !== this.configSeq || this.destroyed) return;
    this.configLoading = false;
    if (config) {
      this.uiConfig = config;
      this.configLoaded = true;
      this.configError = null;
    } else {
      this.configError = 'Settings could not be loaded. Check the Helmsman connection and retry. Unsaved changes are kept.';
    }
    if (paint && this.view === 'config') this.paintConfig();
  }

  private paintConfig(): void {
    const focused = document.activeElement;
    const sourceFocusId = focused instanceof HTMLElement ? focused.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId : undefined;
    const sourceFocusField = focused instanceof HTMLElement ? focused.dataset.sourceField : undefined;
    const focusKey = focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement
      ? focused.closest<HTMLElement>('.config-row')?.dataset.key : undefined;
    const selection = focused instanceof HTMLInputElement && focused.type === 'text'
      ? [focused.selectionStart, focused.selectionEnd] as const : null;
    this.mountPage(renderConfigView(this.uiConfig, {
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      themeId: this.themeId,
      localGit: this.localGit,
      loading: this.configLoading,
      error: this.configError,
      unavailable: !this.configLoaded,
    }));
    for (const row of this.root.querySelectorAll<HTMLElement>('.config-row[data-key]')) {
      const key = row.dataset.key;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      if (!key || !input) continue;
      input.dataset.configValue = input.value;
      const draft = this.configDrafts.get(key);
      if (draft !== undefined) input.value = draft;
      const error = this.configErrors.get(key);
      const errorEl = row.querySelector('.config-error');
      if (errorEl) errorEl.textContent = error ?? '';
      if (error) input.setAttribute('aria-invalid', 'true');
      const button = row.querySelector<HTMLButtonElement>('.config-save');
      if (button) button.disabled = this.configPendingKeys.has(key);
      if (focusKey === key) {
        input.focus({ preventScroll: true });
        if (selection && input instanceof HTMLInputElement && input.type === 'text') input.setSelectionRange(...selection);
      }
    }
    if (sourceFocusId && sourceFocusField) {
      const field = [...this.root.querySelectorAll<HTMLElement>('[data-source-id]')].find(row => row.dataset.sourceId === sourceFocusId)
        ?.querySelector<HTMLElement>(`[data-source-field="${sourceFocusField}"]`);
      field?.focus({ preventScroll: true });
    }
    const slackRepo = this.route.slackPrRepo; const slackPr = this.route.slackPr;
    if (slackRepo && slackPr) {
      const content = this.root.querySelector('#page-content');
      const section = document.createElement('section');
      section.className = 'panel slack-review-settings';
      section.innerHTML = `<h2>${escapeHtml(term('requestSlackReview'))}</h2><p>${escapeHtml(slackRepo)} #${slackPr}</p><div data-slack-review-control data-repo="${escapeHtml(slackRepo)}" data-number="${slackPr}"><button type="button" data-slack-review-request data-repo="${escapeHtml(slackRepo)}" data-number="${slackPr}">${escapeHtml(term('requestSlackReview'))}</button><span class="slack-review-result" role="status"></span></div>`;
      content?.prepend(section);
      this.paintSlackReviewRequests();
    }
    this.bindHeadControls();
  }

  private async loadCmuxTabs(): Promise<void> {
    const seq = ++this.cmuxTabsSeq;
    try {
      const res: Response = await fetch('/api/cmux/tabs', { signal: AbortSignal.timeout(10_000) });
      const data = res.ok ? parseCmuxTabs(await res.json()) : null;
      if (seq !== this.cmuxTabsSeq || this.destroyed) return;
      if (!data) throw new Error('Terminal tabs unavailable');
      this.cmuxConnected = data.connected;
      this.cmuxTabs = data.tabs;
      this.cmuxTabsError = null;
    } catch {
      if (seq !== this.cmuxTabsSeq || this.destroyed) return;
      this.cmuxTabsError = 'Terminal tabs could not be refreshed. Check the Helmsman connection and try again.';
      return;
    }
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    const stillExists: boolean = surface !== null && this.cmuxTabs.some((t) => t.surfaceRef === surface);
    if (surface !== null && !stillExists) {
      this.cmuxPanelState = { selectedSurface: null };
      this.cmuxScreen = '';
    }
  }

  private ensureCmuxEvents(): void {
    if (this.cmuxEventSource) return;
    const src: EventSource = new EventSource('/api/cmux/events');
    src.onmessage = (m: MessageEvent<string>): void => {
      let msg: CmuxEventPayload = {};
      try {
        msg = JSON.parse(m.data) as CmuxEventPayload;
      } catch {
        return;
      }
      if (msg?.kind === 'cmux-tabs-changed') void this.handleCmuxTabsChanged();
    };
    this.cmuxEventSource = src;
  }

  private cmuxSnapshotSignature(): string {
    const tabsPart: string = this.cmuxTabs
      .map((t) => `${t.surfaceRef}${t.surfaceTitle}${t.workspaceTitle}${t.type}`)
      .join('');
    return JSON.stringify([this.cmuxConnected, this.cmuxTabsError, tabsPart]);
  }

  private async handleCmuxTabsChanged(): Promise<void> {
    if (document.hidden || this.view !== 'cmux') return;
    const prevSignature: string = this.cmuxSnapshotSignature();
    await this.loadCmuxTabs();
    if (this.view !== 'cmux') return;
    if (this.cmuxSnapshotSignature() !== prevSignature) {
      this.repaintCmuxPreservingInput();
    }
    this.syncCmuxPolling();
  }

  private repaintCmuxPreservingInput(): void {
    const prevInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.cmux-input');
    const hadFocus: boolean = document.activeElement === prevInput;
    const screenFocused = document.activeElement === this.root.querySelector('.cmux-screen');
    const previousSurface = this.root.querySelector<HTMLElement>('.cmux-tab.is-selected')?.dataset.surface;
    const value: string = prevInput?.value ?? '';
    const selectionStart: number | null = prevInput?.selectionStart ?? null;
    const selectionEnd: number | null = prevInput?.selectionEnd ?? null;

    this.paint();

    if (!previousSurface || previousSurface !== this.cmuxPanelState.selectedSurface) return;
    if (screenFocused) this.root.querySelector<HTMLElement>('.cmux-screen')?.focus({ preventScroll: true });
    if (!value && !hadFocus) return;
    const nextInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.cmux-input');
    if (!nextInput) return;
    nextInput.value = value;
    if (hadFocus) {
      nextInput.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  private syncCmuxPolling(): void {
    if (!document.hidden && this.view === 'cmux' && this.cmuxConnected && isPolling(this.cmuxPanelState)) {
      this.restartCmuxScreenPoll();
    } else {
      this.stopCmuxScreenPoll();
    }
  }

  private restartCmuxScreenPoll(): void {
    this.stopCmuxScreenPoll();
    this.cmuxScreenTimer = setInterval(() => void this.pollCmuxScreen(), CMUX_SCREEN_POLL_MS);
  }

  private stopCmuxScreenPoll(): void {
    if (this.cmuxScreenTimer !== null) {
      clearInterval(this.cmuxScreenTimer);
      this.cmuxScreenTimer = null;
    }
  }

  private async pollCmuxScreen(): Promise<void> {
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface || this.view !== 'cmux' || document.hidden || this.cmuxScreenPending) return;
    this.cmuxScreenPending = true;
    try {
      const res: Response = await fetch(`/api/cmux/screen?surface=${encodeURIComponent(surface)}&lines=40`);
      if (this.view !== 'cmux' || this.cmuxPanelState.selectedSurface !== surface) return;
      if (res.status === 404) {
        if (this.cmuxScreen === CMUX_SCREEN_UNAVAILABLE) return;
        this.cmuxScreen = CMUX_SCREEN_UNAVAILABLE;
        this.setCmuxScreenText(this.cmuxScreen);
        return;
      }
      if (!res.ok) return;
      const data: CmuxScreenPayload = (await res.json()) as CmuxScreenPayload;
      if (this.view !== 'cmux' || this.cmuxPanelState.selectedSurface !== surface) return;
      this.cmuxScreen = data?.text ?? '';
      this.setCmuxScreenText(this.cmuxScreen);
    } catch {
      return;
    } finally {
      this.cmuxScreenPending = false;
    }
  }

  private setCmuxScreenText(text: string): void {
    const pre: HTMLElement | null = this.root.querySelector<HTMLElement>('.cmux-screen');
    if (pre) pre.textContent = text;
  }

  private async handleCmuxTabClick(btn: HTMLButtonElement): Promise<void> {
    const surface: string | undefined = btn.dataset.surface;
    if (!surface) return;
    this.cmuxPanelState = selectSurface(this.cmuxPanelState, surface);
    this.updateAddress({ ...this.route, view: 'cmux', surface: this.cmuxPanelState.selectedSurface, pane: 'screen' });
    this.cmuxScreen = '';
    this.paint();
    await this.pollCmuxScreen();
    this.syncCmuxPolling();
  }

  private showCmuxError(message: string): void {
    const detail: HTMLElement | null = this.root.querySelector<HTMLElement>('.cmux-detail');
    if (!detail) return;
    let errEl: HTMLDivElement | null = detail.querySelector<HTMLDivElement>('.cmux-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'cmux-error';
      errEl.setAttribute('role', 'alert');
      detail.appendChild(errEl);
    }
    errEl.textContent = message;
  }

  private clearCmuxError(): void {
    this.root.querySelector<HTMLElement>('.cmux-error')?.remove();
  }

  private async handleCmuxAction(btn: HTMLButtonElement): Promise<void> {
    const action: string | undefined = btn.dataset.action;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!action || !surface) return;
    const tab: CmuxTabView | undefined = this.cmuxTabs.find((t) => t.surfaceRef === surface);
    if (!tab) return;
    btn.disabled = true;
    try {
      const res: Response = await fetch('/api/cmux/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, provider: providerOf(tab), action }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Action failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Action failed.');
    } finally {
      btn.disabled = false;
    }
  }

  private async handleCmuxSend(form: HTMLFormElement): Promise<void> {
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    const input: HTMLInputElement | null = form.querySelector<HTMLInputElement>('.cmux-input');
    if (!surface || !input) return;
    const text: string = input.value;
    if (text.trim() === '') return;
    try {
      const res: Response = await fetch('/api/cmux/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, text, enter: true }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Send failed.');
        return;
      }
      this.clearCmuxError();
      input.value = '';
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Send failed.');
    }
  }

  private async handlePasteImage(event: ClipboardEvent): Promise<void> {
    if (this.view !== 'cmux') return;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface) return;
    const items: DataTransferItemList | undefined = event.clipboardData?.items;
    if (!items) return;
    const imageItem: DataTransferItem | undefined = Array.from(items).find((i) => i.type.startsWith('image/'));
    if (!imageItem) return;
    const file: File | null = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    const ext: string = file.type.split('/')[1] ?? 'png';
    let dataBase64: string;
    try {
      dataBase64 = await this.blobToBase64(file);
    } catch {
      this.showCmuxError('Could not read pasted image.');
      return;
    }
    try {
      const res: Response = await fetch('/api/cmux/paste-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, dataBase64, ext }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Image paste failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Image paste failed.');
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader: FileReader = new FileReader();
      reader.onerror = (): void => reject(new Error('read failed'));
      reader.onload = (): void => {
        const result: string = String(reader.result);
        const comma: number = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  private handleCmuxCaptureToggle(): void {
    this.cmuxCapturing = !this.cmuxCapturing;
    if (this.cmuxCapturing) this.startCapture();
    else this.stopCapture();
    this.repaintCmuxPreservingInput();
    this.root.querySelector<HTMLElement>(this.cmuxCapturing ? '.cmux-screen' : '[data-cmux-capture]')?.focus();
  }

  private startCapture(): void {
    document.addEventListener('keydown', this.onCaptureKeydown);
  }

  private stopCapture(): void {
    document.removeEventListener('keydown', this.onCaptureKeydown);
  }

  private handleCaptureKeydown(event: KeyboardEvent): void {
    if (this.view !== 'cmux' || !this.cmuxCapturing) return;
    if (event.key === 'Escape' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.handleCmuxCaptureToggle();
      return;
    }
    if (!(event.target instanceof HTMLElement) || !event.target.matches('.cmux-screen')) return;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface) return;
    const intent: CmuxKeyIntent = mapKeyEvent(event);
    if (intent.kind === 'ignore') return;
    event.preventDefault();
    if (intent.kind === 'key') void this.sendCmuxKey(surface, intent.token);
    else void this.sendCmuxText(surface, intent.text);
  }

  private async handleCmuxKeyPad(btn: HTMLButtonElement): Promise<void> {
    const key: string | undefined = btn.dataset.key;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!key || !surface) return;
    await this.sendCmuxKey(surface, key);
  }

  private async sendCmuxKey(surface: string, key: string): Promise<void> {
    try {
      const res: Response = await fetch('/api/cmux/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, key }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Key failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Key failed.');
    }
  }

  private async sendCmuxText(surface: string, text: string): Promise<void> {
    try {
      const res: Response = await fetch('/api/cmux/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, text, enter: false }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Send failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Send failed.');
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    if (event.defaultPrevented) return;
    const target: EventTarget | null = event.target;
    if (!(target instanceof HTMLFormElement) || !target.classList.contains('cmux-send')) return;
    event.preventDefault();
    void this.withStableView(() => this.handleCmuxSend(target));
  }

  private handleClick(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) return;
    const pirateToggle = target.closest<HTMLButtonElement>('[data-pirate-mode]');
    if (pirateToggle) {
      if (!pirateToggle.disabled) this.changePirateMode(!isPirateMode());
      return;
    }
    const slackReview = target.closest<HTMLButtonElement>('[data-slack-review-request]');
    if (slackReview) {
      event.preventDefault();
      if (!slackReview.disabled) void this.sendSlackReviewRequest(slackReview);
      return;
    }
    if (target.closest('[data-slack-toggle], [data-slack-close]')) {
      this.slackOpen = target.closest('[data-slack-close]') ? false : !this.slackOpen;
      this.paintSlack();
      this.root.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus({ preventScroll: true });
      return;
    }
    const slackRead = target.closest<HTMLButtonElement>('[data-slack-read]');
    if (slackRead?.dataset.slackRead) {
      void this.readSlackNotification(slackRead.dataset.slackRead);
      return;
    }
    if (this.slackOpen && !target.closest('.slack-center')) {
      this.slackOpen = false;
      this.paintSlack();
    }

    const link = target.closest<HTMLAnchorElement>('a.view-toggle, a.app-link');
    if (link) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void this.navigate(parseRoute(new URL(link.href)));
      return;
    }

    const surfaceCollapseBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.surface-collapse');
    if (surfaceCollapseBtn) {
      const id: string | undefined = surfaceCollapseBtn.dataset.collapseId;
      if (id) {
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        saveCollapsed(this.collapsed);
        this.paint();
      }
      return;
    }

    if (target.closest('[data-cmux-refresh]')) {
      void this.handleCmuxTabsChanged();
      return;
    }

    const cmuxTabBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-tab');
    if (cmuxTabBtn) {
      void this.handleCmuxTabClick(cmuxTabBtn);
      return;
    }

    const cmuxActionBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-action');
    if (cmuxActionBtn) {
      void this.withStableView(() => this.handleCmuxAction(cmuxActionBtn));
      return;
    }

    const cmuxCaptureToggle: HTMLButtonElement | null = target.closest<HTMLButtonElement>('[data-cmux-capture]');
    if (cmuxCaptureToggle) {
      this.handleCmuxCaptureToggle();
      return;
    }

    const cmuxKeypadBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-keypad-btn');
    if (cmuxKeypadBtn) {
      void this.handleCmuxKeyPad(cmuxKeypadBtn);
      return;
    }

    const localGitButton = target.closest<HTMLButtonElement>('.local-git-panel button');
    if (localGitButton) {
      if (localGitButton.disabled) return;
      if (localGitButton.matches('.local-git-check-remotes')) void this.mutateLocalGit({ action: 'refresh-remotes' });
      else if (localGitButton.matches('.local-git-cleanup-preview')) void this.mutateLocalGit({
        action: 'preview-delete-untracked-branches', ...(this.localGit.cleanupForce ? { force: true } : {}),
      });
      else if (localGitButton.matches('.local-git-cleanup-cancel')) {
        this.localGit = { ...this.localGit, cleanup: undefined, cleanupForce: false };
        this.paintLocalGit();
      } else if (localGitButton.matches('.local-git-cleanup-confirm')) {
        const cleanup = this.localGit.cleanup;
        if (cleanup?.candidates.length) void this.mutateLocalGit({
          action: 'delete-untracked-branches', expectedHead: cleanup.expectedHead,
          branches: cleanup.candidates.map(({ branch, expectedCommit }) => ({ branch, expectedCommit })),
          ...(cleanup.force ? { force: true } : {}),
        });
      }
      else if (localGitButton.matches('.local-git-cancel')) {
        this.localGit = { ...this.localGit, confirmation: undefined };
        this.paintLocalGit();
      } else if (localGitButton.matches('.local-git-confirm-delete')) {
        const action = this.localGit.confirmation;
        if (action) void this.mutateLocalGit(action.action === 'delete-branch'
          ? { ...action, force: this.root.querySelector<HTMLInputElement>('.local-git-force')?.checked === true }
          : action);
      } else if (localGitButton.matches('.local-git-delete')) this.confirmLocalGitDeletion(localGitButton);
      else if (localGitButton.matches('.local-git-refresh')) void this.loadLocalGit();
      return;
    }

    if (target.closest('[data-config-retry]')) {
      if (!this.configLoading) void this.loadUiConfig();
      return;
    }
    const configSaveBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.config-save');
    if (configSaveBtn) {
      void this.handleConfigSave(configSaveBtn);
      return;
    }

  }

  private async enterPrView(repo?: string, number?: number): Promise<void> {
    await this.navigate(parseRoute(new URL(routeHref({ view: 'prs', repo: this.selectedRepo, prRepo: repo ?? null, pr: number ?? null, pane: number ? 'lookup' : null }), window.location.origin)));
  }

  private rehomeRunViewer(): void {
    const presentation = this.pluginPresentationState();
    const standalone = this.isPluginPage() && this.isRunViewerPage();
    const auxiliarySlot = this.root.querySelector<HTMLElement>('.plugin-auxiliary-slot');
    const showAuxiliary = presentation.presentation !== null && this.isPluginPage() && !standalone;
    if (auxiliarySlot) auxiliarySlot.hidden = !showAuxiliary;
    this.auxiliary.update({ ...presentation, pane: standalone ? this.route.pane : null,
      panelInstance: standalone ? this.route.panelInstance ?? null : null,
      panelContribution: standalone ? this.route.panelContribution ?? null : null,
      panelRouteState: standalone ? this.panelRouteState() : {},
    }, standalone || auxiliarySlot ? {
      contributionId: standalone && !this.route.pluginSlot ? this.route.pluginPage ?? null : null,
      scopeRepo: this.presentationScopeRepo(),
    } : undefined);
    this.auxiliary.rehome(standalone ? this.root.querySelector<HTMLElement>('[data-plugin-standalone]') : showAuxiliary ? auxiliarySlot : null);
  }

  private async handleConfigSave(btn: HTMLButtonElement): Promise<void> {
    if (btn.disabled || !this.configLoaded) return;
    const row = btn.closest<HTMLElement>('.config-row');
    const key = row?.dataset.key;
    const input = row?.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
    if (!key || !input || this.configPendingKeys.has(key)) return;
    if (!input.reportValidity()) return;
    this.captureConfigDrafts();
    const value = input.value;
    this.configErrors.delete(key);
    input.removeAttribute('aria-invalid');
    const errorEl = row?.querySelector<HTMLElement>('.config-error');
    if (errorEl) errorEl.textContent = '';
    btn.disabled = true;
    this.configPendingKeys.add(key);
    ++this.configSeq;
    this.configLoading = false;
    ++this.configSaves;
    this.syncPirateToggle();
    try {
      const result = await setConfig(key, value);
      if (this.destroyed) return;
      if (!result.ok) {
        const error = result.error || 'Save failed. Check the Helmsman connection and try again.';
        this.configErrors.set(key, error);
        for (const currentRow of this.root.querySelectorAll<HTMLElement>('.config-row')) {
          if (currentRow.dataset.key !== key) continue;
          const currentError = currentRow.querySelector('.config-error');
          if (currentError) currentError.textContent = error;
          currentRow.querySelector('.config-input')?.setAttribute('aria-invalid', 'true');
        }
        return;
      }
      ++this.configSeq;
      ++this.refreshSeq;
      this.refreshPending = null;
      this.captureConfigDrafts();
      if (this.configDrafts.get(key) === value) this.configDrafts.delete(key);
      if (key === 'JIRA_API_TOKEN') this.uiConfig.jiraTokenSet = true;
      else this.uiConfig.config[key] = value;
      for (const currentRow of this.root.querySelectorAll<HTMLElement>('.config-row')) {
        if (currentRow.dataset.key !== key) continue;
        const currentInput = currentRow.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
        if (!currentInput) continue;
        currentInput.dataset.configValue = key === 'JIRA_API_TOKEN' ? '' : value;
        if (key === 'JIRA_API_TOKEN' && currentInput.value === value) currentInput.value = '';
      }
      this.configPendingKeys.delete(key);
      if (this.configPendingKeys.size === 0) await this.refresh();
    } finally {
      this.configPendingKeys.delete(key);
      btn.disabled = false;
      for (const button of this.root.querySelectorAll<HTMLButtonElement>('.config-save')) {
        if (button.dataset.key === key) button.disabled = false;
      }
      --this.configSaves;
      this.syncPirateToggle();
    }
  }

}

function armBootScreen(boot: HTMLElement): () => void {
  applyBootTerminology(boot);
  const MIN_MS: number = 2000;
  const CAP_MS: number = 4200;
  const start: number = performance.now();
  const pctEl: HTMLElement | null = boot.querySelector<HTMLElement>('.boot-pct');
  let dismissed: boolean = false;
  let raf: number = 0;

  const tick = (): void => {
    if (dismissed) return;
    const t: number = Math.min(1, (performance.now() - start) / MIN_MS);
    if (pctEl) pctEl.textContent = String(Math.min(99, Math.round(t * 100)));
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    cancelAnimationFrame(raf);
    if (pctEl) pctEl.textContent = '100';
    boot.removeEventListener('click', skip);
    window.removeEventListener('keydown', skip);
    boot.classList.add('boot-out');
    window.setTimeout(() => boot.remove(), 520);
  };
  function skip(): void {
    if (performance.now() - start >= MIN_MS) dismiss();
  }
  boot.addEventListener('click', skip);
  window.addEventListener('keydown', skip);
  window.setTimeout(dismiss, CAP_MS);

  return (): void => {
    const elapsed: number = performance.now() - start;
    window.setTimeout(dismiss, Math.max(0, MIN_MS - elapsed));
  };
}

export function bootstrap(): void {
  const root: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('missing #app root element');
  const view: DashboardView = new DashboardView(root);
  const boot: HTMLElement | null = document.getElementById('boot');
  const finishBoot: () => void = boot ? armBootScreen(boot) : (): void => {};
  void loadPluginCatalog(appPages, appPageModules, { pollIntervalMs: 2000, applyBuiltins: syncBuiltinFrontend }).then(async runtime => {
    if (runtime.safeMode) disableBuiltinPageModules();
    await view.start();
    if (runtime.errors.length || runtime.safeMode) {
      const status = document.createElement('div');
      status.className = 'degraded-banner';
      status.setAttribute('role', 'status');
      status.textContent = runtime.errors.length ? term('pluginCatalogFailed') : term('pluginSafeMode');
      root.prepend(status);
    }
  }).then(finishBoot, finishBoot);
}

if (import.meta.env.MODE !== 'test') bootstrap();
