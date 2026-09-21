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

  update(state: PluginPageState): void {
    if (this.disposed) return;
    if (state.repo !== this.state.repo) { this.scopeOverride = null; this.presentation = null; }
    this.state = { ...state };
    this.render();
  }

  select(input: PresentationLocatorV1 | null, scopeRepo: string | null): void {
    if (this.disposed) return;
    this.presentation = scopedPresentationLocatorV1(input, scopeRepo);
    this.scopeOverride = scopeRepo === this.state.repo ? null : { repo: scopeRepo };
    this.render();
  }

  rehome(destination: HTMLElement | null): void {
    if (this.disposed || destination === this.element.parentElement) return;
    const focused = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
    this.element.remove();
    this.render();
    destination?.append(this.element);
    this.render();
    if (this.state.visible && this.element.isConnected && focused?.isConnected) {
      focused.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.start !== undefined && selection.end !== null
        && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)) focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    }
  }

  refresh(): Promise<void> { return this.host.refresh(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.cleanups.forEach(cleanup => cleanup());
    this.host.dispose();
    this.element.remove();
  }

  private render(): void {
    if (this.disposed) return;
    this.connected = this.element.isConnected;
    const page = this.options.registry.getSlot(this.options.slotId) ? this.options.registry.selected(this.options.slotId).page : null;
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
    this.host.show(page.contributionId, module, { ...this.state,
      repo: this.scopeOverride ? this.scopeOverride.repo : this.state.repo,
      visible: this.state.visible && this.element.isConnected,
      presentation: this.presentation,
    });
  }
}
