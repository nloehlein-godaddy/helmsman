import { createHostPullRequestCommandService } from './pull-request-command-service';
import { createHostClarificationReadService } from './clarification-read-service';
import { createHostClarificationCommandService } from './clarification-command-service';
import { createHostSuggestedContactAdminService } from './suggested-contact-admin-service';
import { createHostSourceAdminService } from './source-admin-service';
import { createHostTodoLegacyRecoveryService } from './todo-legacy-recovery-service';
import type { CompositionLayoutV1, CompositionServiceV1, ManagedPanelInstanceV1, PageCompositionDefinitionV1,
  PanelLayoutInstanceV1, PanelOpaqueStateV1, PanelScopeV1, PluginPanelModule } from './composition';
import { CompositionLayoutConflictError, parseCompositionLayout, parsePanelOpaqueState, samePanelOpaqueState } from './composition-layout';
import type { PluginPageState } from './sdk';
import type { PresentationLocatorV1 } from './presentation';
import type { PluginPanelRegistry } from './panels';
import { PluginPanelHost } from './panel-host';
import { createHostTaskReadService } from './task-read-service';
import { createHostTaskEditService } from './task-edit-service';
import { createHostSourceCommandService } from './source-command-service';
import { createHostTaskViewsReadService } from './task-views-read-service';
import { createHostPullRequestReadService } from './pull-request-read-service';
import { createHostPullRequestInspectService } from './pull-request-inspect-service';
import { createHostActivityReadService } from './activity-read-service';
import { createHostRunReadService } from './run-read-service';
import { createHostRunInspectService } from './run-inspect-service';
import { createHostDownloadService } from './download-service';
import { createHostRunCommandService } from './run-command-service';

export interface CompositionLayoutPort {
  read(): Promise<CompositionLayoutV1>;
  update(layout: CompositionLayoutV1, expectedRevision: number, signal?: AbortSignal): Promise<CompositionLayoutV1>;
  subscribe(listener: () => void): () => void;
}

interface MountedPanel {
  readonly id: string;
  readonly container: HTMLElement;
  readonly handle: ManagedPanelInstanceV1;
  requestedActive: boolean;
  contributionId: string;
  module: PluginPanelModule | null;
  host: PluginPanelHost | null;
}

export class PluginCompositionHost {
  readonly service: CompositionServiceV1;
  private readonly panels = new Map<string, MountedPanel>();
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private readonly options: {
    definition: PageCompositionDefinitionV1;
    registry: PluginPanelRegistry;
    layout: CompositionLayoutPort;
    container: HTMLElement;
    navigate(href: string): void;
    selectPresentation?(locator: PresentationLocatorV1 | null, scopeRepo: string | null): void;
  };
  private state: PluginPageState;
  private layout: CompositionLayoutV1 | null = null;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private reading = 0;

  constructor(state: PluginPageState, options: PluginCompositionHost['options']) {
    this.state = Object.freeze({ ...state });
    this.options = options;
    this.service = Object.freeze<CompositionServiceV1>({
      version: 1, compositionId: options.definition.id,
      discover: () => this.disposed ? [] : options.registry.discover(options.definition.accepts),
      readLayout: () => this.readLayout(),
      updateLayout: async (layout, expectedRevision) => {
        this.assertActive();
        if (layout.compositionId !== options.definition.id) throw new TypeError('Composition identity changed.');
        const saved = await options.layout.update(layout, expectedRevision, this.lifetime.signal);
        this.assertActive();
        this.accept(saved);
        return saved;
      },
      subscribe: listener => {
        this.assertActive();
        if (typeof listener !== 'function') throw new TypeError('Composition listener must be a function.');
        const subscription = () => listener();
        this.listeners.add(subscription);
        return () => { this.listeners.delete(subscription); };
      },
      mount: (instanceId, container) => this.mount(instanceId, container),
    });
    this.cleanups.push(options.registry.subscribe(() => { this.reconcile(); this.notify(); }));
    this.cleanups.push(options.layout.subscribe(() => { void this.readLayout().catch(() => this.unavailable()); }));
  }

  update(state: PluginPageState): void {
    if (this.disposed) return;
    this.state = Object.freeze({ ...state });
    this.reconcile();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    await Promise.all([...this.panels.values()].map(panel => panel.host?.refresh()));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    for (const panel of this.panels.values()) panel.host?.dispose();
    this.panels.clear();
    this.listeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new DOMException('Composition disposed.', 'AbortError');
  }

  private async readLayout(): Promise<CompositionLayoutV1> {
    this.assertActive();
    const reading = ++this.reading;
    const layout = await this.options.layout.read();
    this.assertActive();
    if (reading === this.reading) this.accept(layout);
    return layout;
  }

  private accept(layout: CompositionLayoutV1): void {
    if (layout.compositionId !== this.options.definition.id) throw new TypeError('Unexpected composition layout.');
    if (this.layout && this.layout.revision > layout.revision) return;
    const changed = this.layout?.revision !== layout.revision;
    this.layout = layout;
    this.reconcile();
    if (changed) this.notify();
  }

  private async mount(instanceId: string, container: HTMLElement): Promise<ManagedPanelInstanceV1> {
    this.assertActive();
    if (!(container instanceof HTMLElement) || container === this.options.container || !this.options.container.contains(container)) {
      throw new TypeError('Panel container must belong to its composition page.');
    }
    if (!this.layout) await this.readLayout();
    this.assertActive();
    if (!this.options.container.contains(container)) throw new TypeError('Panel container no longer belongs to its composition page.');
    const selected = this.layout?.instances.find(instance => instance.instanceId === instanceId);
    if (!selected) throw new TypeError('Panel instance is not in the selected layout.');
    const existing = this.panels.get(instanceId);
    if (existing) {
      if (existing.container !== container) throw new TypeError('Panel instance is already mounted in another container.');
      return existing.handle;
    }
    for (const mounted of this.panels.values()) {
      if (container.contains(mounted.container) || mounted.container.contains(container)) {
        throw new TypeError('Panel containers must not overlap.');
      }
    }
    const handle = Object.freeze<ManagedPanelInstanceV1>({
      instanceId,
      setActive: active => {
        const current = this.panels.get(instanceId);
        if (this.disposed || current?.handle !== handle) return;
        if (typeof active !== 'boolean') throw new TypeError('Panel activity must be boolean.');
        current.requestedActive = active;
        const selected = this.layout?.instances.find(instance => instance.instanceId === instanceId);
        if (selected) this.apply(current, selected);
      },
      refresh: async () => {
        const current = this.panels.get(instanceId);
        if (!this.disposed && current?.handle === handle) await current.host?.refresh();
      },
      dispose: () => {
        const current = this.panels.get(instanceId);
        if (current?.handle !== handle) return;
        this.panels.delete(instanceId);
        current.host?.dispose();
      },
    });
    const panel: MountedPanel = { id: instanceId, container, handle, requestedActive: true,
      contributionId: selected.contributionId, module: null, host: null };
    this.panels.set(instanceId, panel);
    this.apply(panel, selected);
    return handle;
  }

  private reconcile(): void {
    if (this.disposed || !this.layout) return;
    for (const [id, panel] of this.panels) {
      const instance = this.layout.instances.find(instance => instance.instanceId === id);
      if (!instance) { panel.host?.dispose(); this.panels.delete(id); continue; }
      this.apply(panel, instance);
    }
  }

  private apply(panel: MountedPanel, instance: PanelLayoutInstanceV1): void {
    const contribution = this.options.registry.get(instance.contributionId);
    const compatible = contribution && this.options.definition.accepts.some(contract =>
      contract.id === contribution.contract.id && contract.version === contribution.contract.version)
      && contribution.requires.every(requirement => ['helmsman/task-read', 'helmsman/task-edit', 'helmsman/todo-legacy-recovery', 'helmsman/source-command', 'helmsman/source-admin', 'helmsman/task-views-read', 'helmsman/run-read', 'helmsman/run-inspect', 'helmsman/download', 'helmsman/clarification-read', 'helmsman/clarification-command', 'helmsman/suggested-contact-admin', 'helmsman/pull-request-read', 'helmsman/pull-request-inspect', 'helmsman/pull-request-command', 'helmsman/activity-read', 'helmsman/run-command'].includes(requirement.id) && requirement.version === 1);
    const module = compatible ? this.options.registry.getModule(instance.contributionId) : null;
    if (panel.module !== module || panel.contributionId !== instance.contributionId) {
      panel.host?.dispose(); panel.host = null;
      panel.module = module; panel.contributionId = instance.contributionId;
    }
    if (!module) {
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = this.state.pirateMode ? 'This panel is unavailable. Enable or install its plugin to bring it aboard.'
        : 'This panel is unavailable. Enable or install its plugin to restore it.';
      panel.container.replaceChildren(message);
      return;
    }
    const stack = this.layout?.columns.flat().find(stack => stack.instances.includes(instance.instanceId));
    const visible = this.state.visible && panel.requestedActive && !instance.hidden && !!stack && !stack.collapsed
      && stack.activeInstanceId === instance.instanceId;
    const state = { ...this.state, headerRepo: this.state.repo, repo: instance.scope.kind === 'inherit' ? this.state.repo
      : instance.scope.kind === 'all' ? null : instance.scope.repo, visible };
    const savedState = instance.state[instance.contributionId] ?? null;
    const routeTarget = this.layout?.instances.find(value => value.instanceId === state.panelInstance)
      ?? this.layout?.instances.find(value => value.contributionId === state.panelContribution);
    const acceptsRoute = !state.panelInstance && !state.panelContribution || routeTarget?.instanceId === instance.instanceId;
    state.pullRequest = acceptsRoute ? state.pullRequest : null;
    const routeState = acceptsRoute ? state.panelRouteState?.[instance.contributionId] ?? null : null;
    if (panel.host) { panel.host.update(state, savedState, routeState); return; }
    panel.host = new PluginPanelHost(panel.container, module, state, savedState, {
      instanceId: instance.instanceId, contributionId: instance.contributionId, services: (lifetime, activity) => Object.freeze({ version: 1,
        tasks: createHostTaskReadService(lifetime, { scope: activity }),
        taskEdit: createHostTaskEditService(lifetime, { scope: activity }),
        todoLegacyRecovery: createHostTodoLegacyRecoveryService(lifetime, { scope: activity }),
        sourceCommands: createHostSourceCommandService(lifetime, { scope: activity, caller: instance.contributionId }),
        sourceAdmin: createHostSourceAdminService(lifetime, { scope: activity, caller: instance.contributionId }),
        taskViews: createHostTaskViewsReadService(lifetime, { scope: activity }),
        runs: createHostRunReadService(lifetime, { scope: activity }),
        runInspect: createHostRunInspectService(lifetime, { scope: activity }),
        downloads: createHostDownloadService(lifetime, activity),
        clarifications: createHostClarificationReadService(lifetime, { scope: activity, caller: instance.contributionId }),
        clarificationCommands: createHostClarificationCommandService(lifetime, { scope: activity, caller: instance.contributionId }),
        pullRequestCommands: createHostPullRequestCommandService(lifetime, { scope: activity, caller: instance.contributionId }),
        suggestedContacts: createHostSuggestedContactAdminService(lifetime, { scope: activity, caller: instance.contributionId }),
        pullRequests: createHostPullRequestReadService(lifetime, { scope: activity }),
        pullRequestInspect: createHostPullRequestInspectService(lifetime, { scope: activity }),
        activity: createHostActivityReadService(lifetime, { scope: activity }),
        runCommands: createHostRunCommandService(lifetime, { scope: activity, caller: instance.contributionId }) }),
      selectPresentation: this.options.selectPresentation,
      navigate: href => this.options.navigate(href), errorMessage: () => 'This panel could not load. Reload to try again.',
      saveState: (value, signal) => this.saveState(panel, instance.contributionId, value, signal),
      compareAndSetState: (expected, value, signal) => this.saveState(panel, instance.contributionId,
        parsePanelOpaqueState(value), signal, parsePanelOpaqueState(expected)),
      setScope: (scope, signal) => this.setScope(panel, instance.contributionId, scope, signal),
    }, routeState);
  }

  private async saveState(panel: MountedPanel, contributionId: string, value: PanelOpaqueStateV1 | null, signal: AbortSignal,
    expected?: PanelOpaqueStateV1 | null): Promise<void> {
    try {
      await this.updateInstance(panel, contributionId, signal, selected => {
        if (expected !== undefined && !samePanelOpaqueState(selected.state[contributionId] ?? null, expected)) {
          throw new CompositionLayoutConflictError('Saved panel state changed. Reload it before saving.');
        }
        const state = { ...selected.state };
        if (value === null) delete state[contributionId]; else state[contributionId] = value;
        return { ...selected, state };
      });
    } catch (error) {
      if (expected !== undefined && error instanceof CompositionLayoutConflictError && !this.disposed) {
        await this.readLayout().catch(() => undefined);
      }
      throw error;
    }
  }

  private async setScope(panel: MountedPanel, contributionId: string, scope: PanelScopeV1, signal: AbortSignal): Promise<void> {
    await this.updateInstance(panel, contributionId, signal, selected => ({ ...selected, scope }));
  }

  private async updateInstance(panel: MountedPanel, contributionId: string, signal: AbortSignal,
    update: (instance: PanelLayoutInstanceV1) => PanelLayoutInstanceV1): Promise<void> {
    this.assertActive();
    signal.throwIfAborted();
    const current = await this.options.layout.read();
    this.assertActive();
    signal.throwIfAborted();
    if (this.panels.get(panel.id) !== panel || panel.contributionId !== contributionId) throw new DOMException('Panel replaced.', 'AbortError');
    const selected = current.instances.find(instance => instance.instanceId === panel.id);
    if (!selected || selected.contributionId !== contributionId) throw new Error('Panel selection changed.');
    const layout = parseCompositionLayout({ ...current, instances: current.instances.map(instance => instance === selected ? update(instance) : instance) });
    const saved = await this.options.layout.update(layout, current.revision, signal);
    if (!this.disposed) this.accept(saved);
  }

  private unavailable(): void {
    if (this.disposed) return;
    for (const panel of this.panels.values()) panel.host?.update({ ...this.state, visible: false });
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { continue; } }
  }
}
