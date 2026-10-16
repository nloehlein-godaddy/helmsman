import { PluginPageHost, type PluginPageHostOptions } from './page-host';
import type { PluginPageRegistry } from './registry';
import type { PluginPageModules } from './modules';
import { scopedPresentationLocatorV1, type PresentationLocatorV1 } from './presentation';
import type { PluginPageState } from './sdk';

export interface AuxiliaryPageHostOptions extends PluginPageHostOptions {
  slotId: string;
  registry: PluginPageRegistry;
  modules: PluginPageModules;
  unavailableMessage(): string;
}

export class AuxiliaryPageHost {
  readonly element = document.createElement('div');
  private readonly host: PluginPageHost;
  private readonly cleanups: (() => void)[];
  private readonly observer: MutationObserver;
  private state: PluginPageState;
  private presentation: PresentationLocatorV1 | null = null;
  private scopeOverride: { repo: string | null } | null = null;
  private disposed = false;
  private connected = false;
  private mounted = false;
  private contributionId: string | null = null;
  private parked = false;
  private focus: { element: HTMLElement; selection: { start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | null } | null = null;
  private readonly options: AuxiliaryPageHostOptions;

  constructor(state: PluginPageState, options: AuxiliaryPageHostOptions) {
    this.options = options;
    this.state = { ...state };
    this.element.dataset.auxiliaryPage = options.slotId;
    this.host = new PluginPageHost(this.element, { ...options, selectPresentation: (locator, scopeRepo) => {
      this.select(locator, scopeRepo);
      options.selectPresentation?.(locator, scopeRepo);
    } });
    this.cleanups = [options.registry.subscribe(() => this.render()), options.modules.subscribe(() => this.render())];
    this.observer = new MutationObserver(() => {
      if (this.element.isConnected !== this.connected) this.render();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.render();
  }

  update(state: PluginPageState, target?: { contributionId: string | null; scopeRepo: string | null }): void {
    if (this.disposed) return;
    if (state.repo !== this.state.repo) { this.scopeOverride = null; this.presentation = null; }
    this.state = { ...state };
    if (target) {
      this.contributionId = target.contributionId;
      this.presentation = scopedPresentationLocatorV1(state.presentation ?? null, target.scopeRepo);
      this.scopeOverride = target.scopeRepo === state.repo ? null : { repo: target.scopeRepo };
    }
    this.render();
  }

  select(input: PresentationLocatorV1 | null, scopeRepo: string | null): void {
    if (this.disposed) return;
    this.presentation = scopedPresentationLocatorV1(input, scopeRepo);
    this.scopeOverride = scopeRepo === this.state.repo ? null : { repo: scopeRepo };
    this.render();
  }

  park(): void {
    if (this.disposed || this.parked) return;
    this.captureFocus();
    this.parked = true;
    this.element.remove();
    queueMicrotask(() => {
      if (!this.parked || this.disposed) return;
      this.parked = false;
      this.focus = null;
      this.render();
    });
  }

  private captureFocus(): void {
    const focused = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement : null;
    if (focused) this.focus = { element: focused, selection: focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null };
  }

  rehome(destination: HTMLElement | null): void {
    if (this.disposed || !this.parked && destination === this.element.parentElement) return;
    this.captureFocus();
    if (destination) destination.append(this.element); else this.element.remove();
    this.parked = false;
    const focused = this.focus?.element; const selection = this.focus?.selection;
    if (this.state.visible && this.element.isConnected && focused?.isConnected
      && (document.activeElement === document.body || document.activeElement === focused)) {
      focused.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.start !== undefined && selection.end !== null
        && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)) focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    }
    this.focus = null;
    this.render();
  }

  refresh(force = true): Promise<void> { return this.host.refresh(force); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.cleanups.forEach(cleanup => cleanup());
    this.host.dispose();
    this.element.remove();
  }

  private render(): void {
    if (this.disposed || this.parked) return;
    this.connected = this.element.isConnected;
    const page = this.contributionId ? this.options.registry.getPage(this.contributionId)
      : this.options.registry.getSlot(this.options.slotId) ? this.options.registry.selected(this.options.slotId).page : null;
    const module = page ? this.options.modules.get(page.contributionId) : null;
    if (!page || !module) {
      this.host.clear();
      const message = this.options.unavailableMessage();
      if (this.element.textContent !== message) {
        const status = document.createElement('p');
        status.setAttribute('role', 'status'); status.textContent = message;
        this.element.replaceChildren(status);
      }
      return;
    }
    if (!this.connected && !this.mounted) return;
    this.mounted = true;
    this.host.show(page.contributionId, module, { ...this.state,
      headerRepo: this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo,
      repo: this.scopeOverride ? this.scopeOverride.repo : this.state.repo,
      visible: this.state.visible && this.element.isConnected,
      presentation: this.presentation,
    });
  }
}
