import { parsePresentationLocatorV1, samePresentationLocatorV1, scopedPresentationLocatorV1, type PresentationLocatorV1 } from './presentation';
import type { PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from './sdk';
import { createHostPageServices } from './host-services';
import type { PluginCompositionHost } from './composition-host';

interface PageSession {
  id: string;
  module: PluginPageModule;
  element: HTMLElement;
  controller: AbortController;
  cleanups: Set<() => void>;
  instance: PluginPageInstance | null;
  state: PluginPageState;
  revision: number;
  applied: number;
  mounting: Promise<void>;
  updating: Promise<void> | null;
  refreshing: Promise<void> | null;
  composition: PluginCompositionHost | null;
  activityController: AbortController;
  activityEpoch: number;
}

export interface PluginPageHostOptions {
  selectPresentation?(locator: PresentationLocatorV1 | null, scopeRepo: string | null): void;
  navigate(href: string): void;
  loadingMessage(): string;
  errorMessage(): string;
  createComposition?(id: string, container: HTMLElement, state: PluginPageState): PluginCompositionHost | null;
}

const sameState = (a: PluginPageState, b: PluginPageState) => a.repo === b.repo && a.themeId === b.themeId
  && a.pirateMode === b.pirateMode && a.visible === b.visible && a.pane === b.pane && a.panelInstance === b.panelInstance
  && a.panelContribution === b.panelContribution && samePresentationLocatorV1(a.presentation, b.presentation)
  && JSON.stringify(a.panelRouteState ?? {}) === JSON.stringify(b.panelRouteState ?? {});

function validInstance(value: unknown): value is PluginPageInstance {
  if (!value || typeof value !== 'object') return false;
  const instance = value as Partial<PluginPageInstance>;
  return typeof instance.update === 'function' && typeof instance.dispose === 'function'
    && (instance.refresh === undefined || typeof instance.refresh === 'function');
}

export class PluginPageHost {
  private session: PageSession | null = null;
  private disposed = false;
  private readonly container: HTMLElement;
  private readonly options: PluginPageHostOptions;

  constructor(container: HTMLElement, options: PluginPageHostOptions) {
    this.container = container;
    this.options = options;
  }

  show(id: string, module: PluginPageModule, state: PluginPageState): void {
    if (this.disposed) return;
    const current = this.session;
    if (current?.id === id && current.module === module && !current.controller.signal.aborted) {
      if (!sameState(current.state, state)) {
        if (current.state.repo !== state.repo || current.state.visible !== state.visible) {
          current.activityController.abort();
          current.activityController = new AbortController();
          ++current.activityEpoch;
          if (!state.visible) current.activityController.abort();
        }
        if (current.state.repo !== state.repo) this.loading();
        current.state = Object.freeze({ ...state, ...(state.presentation === undefined ? {} : { presentation: parsePresentationLocatorV1(state.presentation) }) });
        current.composition?.update(current.state);
        ++current.revision;
        void this.update(current);
      }
      return;
    }
    this.clear();
    const session: PageSession = {
      id, module, element: document.createElement('div'), controller: new AbortController(), cleanups: new Set(),
      instance: null, state: Object.freeze({ ...state, ...(state.presentation === undefined ? {} : { presentation: parsePresentationLocatorV1(state.presentation) }) }), revision: 0, applied: 0,
      mounting: Promise.resolve(), updating: null, refreshing: null,
      composition: null,
      activityController: new AbortController(), activityEpoch: 0,
    };
    if (!state.visible) session.activityController.abort();
    session.element.dataset.pluginPage = id;
    this.session = session;
    this.container.replaceChildren(session.element);
    try { session.composition = this.options.createComposition?.(id, session.element, session.state) ?? null; }
    catch { this.fail(session); return; }
    const context: PluginPageContext = Object.freeze({
      contributionId: id,
      state: session.state,
      ...(this.options.selectPresentation ? { selectPresentation: (input: PresentationLocatorV1 | null) => {
        if (!this.active(session) || !session.state.visible || session.activityController.signal.aborted) throw new DOMException('Page is inactive.', 'AbortError');
        const locator = scopedPresentationLocatorV1(input, session.state.repo);
        this.options.selectPresentation?.(locator, session.state.repo);
      } } : {}),
      signal: session.controller.signal,
      services: createHostPageServices(session.controller.signal, () => ({ repo: session.state.repo, active: session.state.visible,
        epoch: session.activityEpoch, signal: session.activityController.signal }), id),
      ...(session.composition ? { composition: session.composition.service } : {}),
      navigate: (href: string) => { if (this.active(session)) this.options.navigate(href); },
      onDispose: (cleanup: () => void) => {
        if (typeof cleanup !== 'function') throw new TypeError('Page cleanup must be a function.');
        if (this.active(session)) session.cleanups.add(cleanup);
        else this.cleanup(cleanup);
      },
    });
    session.mounting = this.mount(session, context);
  }

  async refresh(): Promise<void> {
    const session = this.session;
    if (!session || !this.active(session) || !session.state.visible) return;
    const signal = session.controller.signal;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await Promise.race([this.refreshSession(session), cancelled]);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private async refreshSession(session: PageSession): Promise<void> {
    if (session.refreshing) return session.refreshing;
    await session.mounting;
    await this.update(session);
    if (!this.active(session) || !session.state.visible || !session.instance) return;
    if (!session.refreshing) {
      session.refreshing = this.refreshInstance(session).finally(() => { session.refreshing = null; });
    }
    await session.refreshing;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.container.replaceChildren();
  }

  private active(session: PageSession): boolean {
    return !this.disposed && this.session === session && !session.controller.signal.aborted;
  }

  private async mount(session: PageSession, context: PluginPageContext): Promise<void> {
    try {
      const instance: unknown = await session.module.mount(session.element, context);
      if (!validInstance(instance)) throw new TypeError('Page did not return a valid lifecycle.');
      if (!this.active(session)) { this.release(instance); return; }
      session.instance = instance;
      await this.update(session);
    } catch {
      this.fail(session);
    }
  }

  private update(session: PageSession): Promise<void> {
    if (session.updating) return session.updating;
    if (!session.instance || !this.active(session)) return Promise.resolve();
    session.updating = this.updateInstance(session).finally(() => {
      session.updating = null;
      if (this.active(session) && session.applied !== session.revision) return this.update(session);
    });
    return session.updating;
  }

  private async updateInstance(session: PageSession): Promise<void> {
    try {
      while (this.active(session) && session.instance) {
        if (session.applied !== session.revision) {
          const revision = session.revision;
          await session.instance.update(session.state);
          if (!this.active(session)) return;
          session.applied = revision;
          if (revision !== session.revision) continue;
          if (session.element.parentNode !== this.container) this.container.replaceChildren(session.element);
          this.container.removeAttribute('aria-busy');
        }
        break;
      }
    } catch {
      this.fail(session);
    }
  }

  private async refreshInstance(session: PageSession): Promise<void> {
    try { await session.instance?.refresh?.(); } catch { this.fail(session); }
  }

  clear(): void {
    const previous = this.session;
    this.session = null;
    if (!previous) return;
    previous.controller.abort();
    previous.activityController.abort();
    previous.composition?.dispose();
    for (const cleanup of [...previous.cleanups].reverse()) this.cleanup(cleanup);
    previous.cleanups.clear();
    if (previous.instance) this.release(previous.instance);
    previous.element.remove();
    this.container.removeAttribute('aria-busy');
  }

  private release(instance: PluginPageInstance): void {
    try { void Promise.resolve(instance.dispose()).catch(() => {}); } catch { return; }
  }

  private cleanup(cleanup: () => void): void {
    try { void Promise.resolve(cleanup()).catch(() => {}); } catch { return; }
  }

  private loading(): void {
    const message = document.createElement('p');
    message.className = 'empty-note';
    message.setAttribute('role', 'status');
    message.textContent = this.options.loadingMessage();
    this.container.replaceChildren(message);
    this.container.setAttribute('aria-busy', 'true');
  }

  private fail(session: PageSession): void {
    if (!this.active(session)) return;
    this.clear();
    const message = document.createElement('p');
    message.className = 'degraded-banner';
    message.setAttribute('role', 'alert');
    message.textContent = this.options.errorMessage();
    this.container.replaceChildren(message);
  }
}
