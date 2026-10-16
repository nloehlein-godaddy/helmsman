import { createApiReadScope } from '../data/api-client';
import { parseTerminalRouteV1, sameTerminalRouteV1 } from './terminal-route';
import type { PanelActivityV1, PanelOpaqueStateV1, PanelScopeV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, PluginPanelServicesV1 } from './composition';
import type { PluginPageState } from './sdk';
import { parsePullRequestRouteV1, samePullRequestRouteV1, parsePresentationLocatorV1, samePresentationLocatorV1, scopedPresentationLocatorV1, type PresentationLocatorV1 } from './presentation';

export interface PanelHostOptions {
  readonly contributionId?: string;
  readonly selectPresentation?: (locator: PresentationLocatorV1 | null, scopeRepo: string | null) => void;
  readonly instanceId: string;
  readonly services: (lifetime: AbortSignal, activity: () => PanelActivityV1, fetcher?: typeof fetch) => PluginPanelServicesV1;
  readonly navigate: (href: string) => void;
  readonly saveState: (state: PanelOpaqueStateV1 | null, signal: AbortSignal) => Promise<void>;
  readonly compareAndSetState?: (expected: PanelOpaqueStateV1 | null, state: PanelOpaqueStateV1 | null, signal: AbortSignal) => Promise<void>;
  readonly setScope?: (scope: PanelScopeV1, signal: AbortSignal) => Promise<void>;
  readonly errorMessage: () => string;
}

export class PluginPanelHost {
  private readonly lifetime = new AbortController();
  private scope = new AbortController();
  private readonly readScope: ReturnType<typeof createApiReadScope>;
  private readonly cleanups = new Set<() => void>();
  private readonly element = document.createElement('div');
  private instance: PluginPanelInstance | null = null;
  private state: PluginPanelState;
  private revision = 0;
  private mounting: Promise<void>;
  private refreshing: { epoch: number; force: boolean; promise: Promise<void> } | null = null;
  private cacheRefreshQueued = false;
  private readonly container: HTMLElement;
  private readonly options: PanelHostOptions;

  constructor(container: HTMLElement, module: PluginPanelModule, state: PluginPageState & Pick<PluginPanelState, 'headerRepo'>,
    savedState: PanelOpaqueStateV1 | null, options: PanelHostOptions, routeState: PanelOpaqueStateV1 | null = null) {
    this.container = container;
    this.options = options;
    if (!state.visible) this.scope.abort();
    this.state = Object.freeze({ ...state, ...(state.terminal === undefined ? {} : { terminal: parseTerminalRouteV1(state.terminal) }), ...(state.pullRequest === undefined ? {} : { pullRequest: parsePullRequestRouteV1(state.pullRequest) }), ...(state.presentation === undefined ? {} : { presentation: parsePresentationLocatorV1(state.presentation) }), panelRouteState: undefined, instanceId: options.instanceId, savedState, routeState,
      activity: Object.freeze({ epoch: 0, signal: this.scope.signal, active: state.visible, repo: state.repo }) });
    this.readScope = createApiReadScope(this.lifetime.signal, () => this.readUpdated());
    this.element.dataset.panelInstance = options.instanceId;
    this.element.hidden = !state.visible;
    container.replaceChildren(this.element);
    const host = this;
    const setScope = options.setScope;
    const compareAndSetState = options.compareAndSetState;
    const context = Object.freeze<PluginPanelContext>({
      contributionId: options.contributionId,
      refresh: () => this.refresh(),
      state: this.state, signal: this.lifetime.signal,
      ...(options.selectPresentation ? { selectPresentation: (input: PresentationLocatorV1 | null) => {
        if (this.lifetime.signal.aborted || !this.state.activity.active || this.state.activity.signal.aborted) throw new DOMException('Panel is inactive.', 'AbortError');
        const locator = scopedPresentationLocatorV1(input, this.state.activity.repo);
        options.selectPresentation?.(locator, this.state.activity.repo);
      } } : {}),
      get activity() { return host.state.activity; },
      services: options.services(this.lifetime.signal, () => this.state.activity, this.readScope.fetch),
      navigate: href => { if (!this.lifetime.signal.aborted && this.state.activity.active) options.navigate(href); },
      saveState: async value => {
        if (this.lifetime.signal.aborted) throw new DOMException('Panel disposed.', 'AbortError');
        await options.saveState(value, this.lifetime.signal);
      },
      ...(compareAndSetState ? { compareAndSetState: async (expected: PanelOpaqueStateV1 | null, value: PanelOpaqueStateV1 | null) => {
        if (this.lifetime.signal.aborted) throw new DOMException('Panel disposed.', 'AbortError');
        await compareAndSetState(expected, value, this.lifetime.signal);
      } } : {}),
      ...(setScope ? { setScope: async (scope: PanelScopeV1) => {
        if (!this.state.activity.active || this.lifetime.signal.aborted) throw new DOMException('Panel is inactive.', 'AbortError');
        await setScope(scope, this.state.activity.signal);
      } } : {}),
      onDispose: cleanup => {
        if (typeof cleanup !== 'function') throw new TypeError('Panel cleanup must be a function.');
        if (this.lifetime.signal.aborted) this.cleanup(cleanup);
        else this.cleanups.add(cleanup);
      },
    });
    this.mounting = this.mount(module, context);
  }

  update(state: PluginPageState & Pick<PluginPanelState, 'headerRepo'>, savedState: PanelOpaqueStateV1 | null = this.state.savedState,
    routeState: PanelOpaqueStateV1 | null = this.state.routeState ?? null): void {
    if (this.lifetime.signal.aborted) return;
    const previous = this.state;
    if (previous.repo === state.repo && previous.headerRepo === state.headerRepo && previous.visible === state.visible && previous.themeId === state.themeId
      && previous.pirateMode === state.pirateMode && previous.pane === state.pane && previous.panelInstance === state.panelInstance
      && previous.panelContribution === state.panelContribution && samePresentationLocatorV1(previous.presentation, state.presentation) && samePullRequestRouteV1(previous.pullRequest, state.pullRequest) && sameTerminalRouteV1(previous.terminal, state.terminal)
      && previous.savedState === savedState && JSON.stringify(previous.routeState) === JSON.stringify(routeState)) return;
    const changed = previous.repo !== state.repo || previous.visible !== state.visible;
    if (changed) {
      this.scope.abort();
      this.scope = new AbortController();
      if (!state.visible) this.scope.abort();
    }
    this.state = Object.freeze({ ...state, ...(state.terminal === undefined ? {} : { terminal: parseTerminalRouteV1(state.terminal) }), ...(state.pullRequest === undefined ? {} : { pullRequest: parsePullRequestRouteV1(state.pullRequest) }), ...(state.presentation === undefined ? {} : { presentation: parsePresentationLocatorV1(state.presentation) }), panelRouteState: undefined, instanceId: this.options.instanceId, savedState, routeState,
      activity: changed ? Object.freeze({ epoch: previous.activity.epoch + 1, signal: this.scope.signal,
        active: state.visible, repo: state.repo }) : previous.activity });
    this.element.hidden = !state.visible;
    const revision = ++this.revision;
    if (this.instance) void this.deliver(this.state, revision);
  }

  async refresh(force = true): Promise<void> {
    const activity = this.state.activity;
    if (this.lifetime.signal.aborted || !activity.active) return;
    if (this.refreshing?.epoch === activity.epoch) {
      const pending = this.refreshing;
      await pending.promise;
      if (force && !pending.force && this.state.activity === activity) return this.refresh(true);
      return;
    }
    const promise = this.untilAbort((async () => {
      await this.mounting;
      if (this.lifetime.signal.aborted || activity.signal.aborted) return;
      try {
        const operation = async () => { await this.instance?.refresh?.(); };
        if (force) await this.readScope.fresh(operation); else await operation();
      }
      catch { if (!activity.signal.aborted) this.fail(); }
    })(), activity.signal);
    const refresh = { epoch: activity.epoch, force, promise };
    this.refreshing = refresh;
    try { await promise; } finally { if (this.refreshing === refresh) this.refreshing = null; }
  }

  private readUpdated(): void {
    const activity = this.state.activity;
    if (this.lifetime.signal.aborted || !activity.active || activity.signal.aborted) return;
    if (!this.refreshing) { void this.refresh(false); return; }
    if (this.cacheRefreshQueued) return;
    this.cacheRefreshQueued = true;
    void this.refreshing.promise.finally(() => {
      this.cacheRefreshQueued = false;
      if (this.state.activity === activity) void this.refresh(false);
    });
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.scope.abort();
    for (const cleanup of [...this.cleanups].reverse()) this.cleanup(cleanup);
    this.cleanups.clear();
    if (this.instance) this.release(this.instance);
    this.instance = null;
    this.element.remove();
  }

  private async mount(module: PluginPanelModule, context: PluginPanelContext): Promise<void> {
    try {
      const value: unknown = await module.mount(this.element, context);
      const instance = value && typeof value === 'object' ? value as Partial<PluginPanelInstance> : null;
      if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function'
        || instance.refresh !== undefined && typeof instance.refresh !== 'function') throw new TypeError('Invalid panel lifecycle.');
      if (this.lifetime.signal.aborted) { this.release(instance as PluginPanelInstance); return; }
      this.instance = instance as PluginPanelInstance;
      if (this.revision) await this.deliver(this.state, this.revision);
    } catch { this.fail(); }
  }

  private async deliver(state: PluginPanelState, revision: number): Promise<void> {
    try { await this.instance?.update(state); }
    catch { if (revision === this.revision && !this.lifetime.signal.aborted) this.fail(); }
  }

  private async untilAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    signal.addEventListener('abort', cancel, { once: true });
    try { await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', cancel); }
  }

  private cleanup(callback: () => void): void {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { return; }
  }

  private release(instance: PluginPanelInstance): void {
    this.cleanup(() => { void Promise.resolve(instance.dispose()).catch(() => {}); });
  }

  private fail(): void {
    if (this.lifetime.signal.aborted) return;
    this.dispose();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = this.options.errorMessage();
    this.container.replaceChildren(message);
  }
}
