import { PageAttentionHost } from './plugins/page-attention-host';
import { CLARIFICATIONS_PAGE_SLOT } from './plugins/page-slots';
import { AuxiliaryPageHost } from './plugins/auxiliary-page-host';
import { scopedPresentationLocatorV1, type PresentationLocatorV1 } from './plugins/presentation';
import { applyBootTerminology } from './logic/bootTerminology';
import { term, setPirateMode, isPirateMode } from './logic/terminology';
import { getContext } from './data/context';
import './style.css';
import { isAppPagePath, parseRoute, routeHref, type AppRoute, type PageView } from './logic/routes';
import { escapeHtml } from './logic/html';
import { appPages, COSTS_PAGE_SLOT, HELM_PAGE_SLOT, PRODUCT_FEEDBACK_FOOTER_SLOT, NOTIFICATION_HEADER_SLOT, PROFILE_HEADER_SLOT, PR_PAGE_SLOT, RUN_HISTORY_PAGE_SLOT, RUN_VIEWER_PAGE_SLOT, RUNS_PAGE_SLOT } from './plugins/builtins';
import { appPageModules, disableBuiltinPageModules, syncBuiltinFrontend } from './plugins/builtin-modules';
import { AppCompositionFactory } from './plugins/app-composition';
import { loadPluginCatalog } from './plugins/runtime';
import { PluginPageHost } from './plugins/page-host';
import type { PluginPageState } from './plugins/sdk';
import { LOCAL_POLL_MS } from './data/live';
import { activePageTabId, renderAppShell, renderHelmHead, type HelmHeadOpts, renderConfigView } from './render';
import { fetchAgents, type RunSummary } from './data/agents';
import { getConfig, setConfig, type UiConfig } from './data/config';
import { applyTheme, loadThemeId, saveThemeId } from './data/themes';
import {
  loadRepoScope,
  saveRepoScope,
  loadCollapsed,
  saveCollapsed,
} from './logic/prefs';

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly rootEvents = new window.AbortController();
  private readonly feedbackContribution: AuxiliaryPageHost;
  private readonly profileContribution: AuxiliaryPageHost;
  private readonly headerContribution: AuxiliaryPageHost;
  private readonly auxiliary: AuxiliaryPageHost;
  private readonly questionsAttention: PageAttentionHost;
  private questionsNeedAttention = false;
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
    this.paintHeaderContribution();
    if (this.isPluginPage()) this.paintPluginPage();
    if (!document.hidden) {
      void this.refresh(false);
    }
  };
  private view: PageView = parseRoute(new URL('/helm', window.location.origin)).view;
  private route: AppRoute = parseRoute(new URL('/helm', window.location.origin));
  private routeSeq: number = 0;
  private readonly onResize = (): void => { this.revealActiveTab(); };
  private readonly onPopState = (): void => { void this.navigate(parseRoute(new URL(window.location.href)), 'none'); };
  private themeId: string = loadThemeId();
  private configSaves: number = 0;
  private jiraEnabled: boolean = true;
  private unsubscribePages: (() => void) | null = null;
  private unsubscribePageModules: (() => void) | null = null;
  private pageHost: PluginPageHost | null = null;
  private readonly compositions = new AppCompositionFactory();

  constructor(root: HTMLElement) {
    this.root = root;
    this.questionsAttention = new PageAttentionHost(attention => { this.questionsNeedAttention = attention; this.paintQuestionsAttention(); });
    applyTheme(this.themeId);
    this.root.addEventListener('click', (event: MouseEvent): void => this.handleClick(event), { signal: this.rootEvents.signal });
    this.root.addEventListener('keydown', (event: KeyboardEvent): void => {
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

    this.feedbackContribution = new AuxiliaryPageHost(this.pluginPresentationState(), {
      slotId: PRODUCT_FEEDBACK_FOOTER_SLOT, registry: appPages, modules: appPageModules,
      navigate: href => this.navigatePluginHref(href),
      loadingMessage: () => '', errorMessage: () => '', unavailableMessage: () => '',
    });
    this.profileContribution = new AuxiliaryPageHost({ ...this.pluginPresentationState(), repo: null }, {
      slotId: PROFILE_HEADER_SLOT, registry: appPages, modules: appPageModules,
      navigate: href => this.navigatePluginHref(href),
      loadingMessage: () => '', errorMessage: () => '', unavailableMessage: () => '',
    });
    this.headerContribution = new AuxiliaryPageHost(this.pluginPresentationState(), {
      slotId: NOTIFICATION_HEADER_SLOT, registry: appPages, modules: appPageModules,
      navigate: href => this.navigatePluginHref(href),
      loadingMessage: () => term('loadingPluginPage'), errorMessage: () => term('failedPluginPage'),
      unavailableMessage: () => '',
    });
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
      if (this.destroyed) return;
      this.syncQuestionsAttention();
      if (this.isPluginPage()) this.paintPluginPage();
    });
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

  private syncPirateToggle(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-pirate-mode]');
    if (toggle) {
      toggle.disabled = this.configSaves > 0;
      toggle.setAttribute('aria-pressed', String(isPirateMode()));
      toggle.title = `Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}`;
    }
  }

  private changePirateMode(enabled: boolean): void {
    if (this.configSaves > 0) return;
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
    this.paintHeaderContribution();
    this.updateAddress(this.route, 'replace');
    const template = document.createElement('template');
    template.innerHTML = renderAppShell(this.shellOptions(), '');
    const footer = template.content.querySelector('.app-footer');
    if (footer) {
      this.root.querySelector('.app-footer')?.replaceWith(footer);
      this.feedbackContribution.rehome(this.root.querySelector<HTMLElement>('[data-feedback-footer]'));
    }
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
    this.headerContribution.dispose();
    this.profileContribution.dispose();
    this.feedbackContribution.dispose();
    this.compositions.dispose();
    this.questionsAttention.dispose();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    ++this.routeSeq;
    ++this.refreshSeq;
    window.removeEventListener('popstate', this.onPopState);
  }

  private updateAddress(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): void {
    const href = routeHref(route);
    this.route = parseRoute(new URL(href, window.location.origin));
    if (history === 'replace') window.history.replaceState(null, '', href);
    else if (history === 'push' && href !== window.location.pathname + window.location.search) window.history.pushState(null, '', href);
    document.title = `↻ ${route.view === 'plugin' ? (route.pluginPage ? appPages.getPage(route.pluginPage)?.title : null) ?? term('unavailablePluginPage') : route.view === 'dashboard' ? term('dashboard') : route.view === 'prs' ? term('prs') : route.view === 'runs' ? term('runs') : route.view === 'outcomes' ? term('costsOutcomes') : route.view === 'campaigns' ? term('campaigns') : route.view === 'clarifications' ? term('clarifications') : route.view === 'cmux' ? 'Terminal' : route.view[0]!.toUpperCase() + route.view.slice(1)} · Helmsman`;
  }

  private async navigate(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): Promise<void> {
    if (route.view === 'runs' || route.view === 'prs' || route.view === 'cmux' || route.view === 'campaigns') route = parseRoute(new URL(routeHref(route), window.location.origin));
    if (this.presentationSelection && (route.run !== this.presentationSelection.locator.runId
      || this.presentationSelection.locator.kind === 'run' && route.runRepo !== this.presentationSelection.locator.repo)) this.presentationSelection = null;
    const seq = ++this.routeSeq;
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
    }
    this.selectedRepo = scope;
    saveRepoScope(scope);
    this.view = route.view;
    this.updateAddress(route, history);
    this.syncQuestionsAttention();
    if (route.pane) this.collapsed.delete(`${route.view}:${route.pane === 'tabs' ? 'list' : route.pane === 'screen' ? 'detail' : route.pane}`);
    if (!route.run) this.presentationSelection = null;
    this.paint();
    if (scopeChanged) this.paintHeaderContribution();
    if (scopeChanged) await this.refresh(false);
    if (seq !== this.routeSeq) return;
    if (this.isPluginPage() && !this.isRunViewerPage()) await this.pageHost?.refresh();
    else if (route.view === 'config') {
      await this.loadUiConfig();
      if (seq !== this.routeSeq) return;
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
    const repo: string | null = this.selectedRepo;
    const [agents, , context] = await Promise.all([
      localDue ? fetchAgents() : null,
      force ? this.loadUiConfig(false) : null,
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
    if (force) { void this.feedbackContribution.refresh(); void this.profileContribution.refresh(); await this.headerContribution.refresh(); }
    if (this.view === 'config' && force) {
      this.paintConfig();
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
        terminal: this.route.surface || this.route.pane === 'tabs' || this.route.pane === 'screen' ? { version: 1, surface: this.route.surface, pane: this.route.pane === 'tabs' || this.route.pane === 'screen' ? this.route.pane : null } : null,
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
      this.paintHeaderContribution();
    }
    const content = this.root.querySelector<HTMLElement>('#page-content');
    this.auxiliary.park();
    content?.replaceChildren(...next.childNodes);
    if (content && this.contentView !== this.view) content.scrollTop = 0;
    this.contentView = this.view;
    this.syncShell();
  }

  private syncQuestionsAttention(): void {
    const selected = appPages.selected(CLARIFICATIONS_PAGE_SLOT);
    const id = selected.page?.contributionId;
    const module = id ? appPageModules.get(id) : null;
    this.questionsAttention.update(id && module ? { id, module, repo: this.selectedRepo,
      selected: this.route.pluginSlot === CLARIFICATIONS_PAGE_SLOT || this.route.pluginPage === id } : null);
    this.paintQuestionsAttention();
  }

  private paintQuestionsAttention(): void {
    const tab = this.root.querySelector<HTMLAnchorElement>('#page-tab-clarifications');
    if (!tab) return;
    tab.classList.toggle('needs-attention', this.questionsNeedAttention);
    if (this.questionsNeedAttention) tab.setAttribute('aria-label', `${tab.textContent ?? term('clarifications')}: ${term('unansweredQuestions')}`);
    else tab.removeAttribute('aria-label');
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
    this.syncQuestionsAttention();
    const menu = shell.querySelector<HTMLDetailsElement>('[data-pages-menu]');
    const items = menu?.querySelector('[data-pages-menu-items]');
    const nextItems = template.content.querySelector('[data-pages-menu-items]');
    if (menu && items && nextItems) {
      const retained = new Map(Array.from(items.querySelectorAll<HTMLAnchorElement>('[data-page-contribution]'), link => [link.dataset.pageContribution, link]));
      const nextNodes = Array.from(nextItems.children, next => {
        if (!(next instanceof HTMLAnchorElement)) return next;
        const current = retained.get(next.dataset.pageContribution);
        if (!current) return next;
        if (current.innerHTML !== next.innerHTML) current.replaceChildren(...next.childNodes);
        for (const name of ['href', 'aria-current', 'title']) {
          const value = next.getAttribute(name);
          if (value === null) current.removeAttribute(name); else current.setAttribute(name, value);
        }
        return current;
      });
      if (items.contains(document.activeElement) && !nextNodes.some(node => node === document.activeElement || node.contains(document.activeElement))) {
        menu.querySelector<HTMLElement>('[data-pages-menu-summary]')?.focus({ preventScroll: true });
      }
      nextNodes.forEach((node, index) => { if (items.children[index] !== node) items.insertBefore(node, items.children[index] ?? null); });
      for (const node of Array.from(items.children)) if (!nextNodes.includes(node)) node.remove();
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
    if (nextGreeting && greeting) greeting.textContent = nextGreeting.textContent;
    this.paintHeaderContribution();
  }

  private bindHeadControls(): void {
    this.revealActiveTab();
  }

  private paintHeaderContribution(): void {
    this.feedbackContribution.update({ ...this.pluginPresentationState(), presentation: null });
    this.feedbackContribution.rehome(this.root.querySelector<HTMLElement>('[data-feedback-footer]'));
    this.profileContribution.update({ ...this.pluginPresentationState(), repo: null, presentation: null });
    this.profileContribution.rehome(this.root.querySelector<HTMLElement>('[data-profile-header]'));
    this.headerContribution.update({ ...this.pluginPresentationState(), presentation: null });
    this.headerContribution.rehome(this.root.querySelector<HTMLElement>('.helm-controls'));
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
    this.bindHeadControls();
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
    const link = target.closest<HTMLAnchorElement>('a.view-toggle, a.app-link');
    if (link) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
        || link.hasAttribute('download') || (link.target && link.target.toLowerCase() !== '_self')) return;
      const destination = new URL(link.href);
      if (destination.origin !== window.location.origin) return;
      event.preventDefault();
      void this.navigate(parseRoute(destination));
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
      this.uiConfig.config[key] = value;
      for (const currentRow of this.root.querySelectorAll<HTMLElement>('.config-row')) {
        if (currentRow.dataset.key !== key) continue;
        const currentInput = currentRow.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
        if (!currentInput) continue;
        currentInput.dataset.configValue = value;
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
