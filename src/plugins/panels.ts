import { isContributionId, parsePluginManifest, PluginManifestError } from './manifest';
import type { PanelContractV1, PluginPanelModule, RegisteredPluginPanel } from './composition';

export class PluginPanelRegistry {
  private readonly plugins = new Map<string, object>();
  private readonly panels = new Map<string, RegisteredPluginPanel>();
  private readonly modules = new Map<string, PluginPanelModule>();
  private readonly listeners = new Set<() => void>();

  register(value: unknown): () => void {
    const manifest = parsePluginManifest(value);
    if (this.plugins.has(manifest.id)) throw new PluginManifestError(`Plugin ${manifest.id} already has registered panels.`);
    const registration = {};
    const panels = manifest.manifestVersion === 2 ? manifest.panels.map(panel => Object.freeze({ ...panel,
      contributionId: `${manifest.id}/${panel.id}`, pluginId: manifest.id })) : [];
    this.plugins.set(manifest.id, registration);
    for (const panel of panels) this.panels.set(panel.contributionId, panel);
    this.notify();
    return () => {
      if (this.plugins.get(manifest.id) !== registration) return;
      this.plugins.delete(manifest.id);
      for (const panel of panels) this.panels.delete(panel.contributionId);
      this.notify();
    };
  }

  registerModule(contributionId: string, module: PluginPanelModule): () => void {
    if (!isContributionId(contributionId)) throw new PluginManifestError('Invalid panel contribution ID.');
    if (this.modules.has(contributionId)) throw new PluginManifestError(`Panel module ${contributionId} already registered.`);
    if (!module || typeof module !== 'object') throw new PluginManifestError('Invalid panel module.');
    let source: object | null = module;
    let mount: PluginPanelModule['mount'] | null = null;
    while (source) {
      const descriptor = Object.getOwnPropertyDescriptor(source, 'mount');
      if (descriptor) {
        if ('value' in descriptor && typeof descriptor.value === 'function') mount = descriptor.value as PluginPanelModule['mount'];
        break;
      }
      source = Object.getPrototypeOf(source) as object | null;
    }
    if (!mount) throw new PluginManifestError('Panel module must declare a callable mount method.');
    const invoke = mount;
    const registered = Object.freeze<PluginPanelModule>({ mount: (container, context) => invoke.call(module, container, context) });
    this.modules.set(contributionId, registered);
    this.notify();
    return () => {
      if (this.modules.get(contributionId) !== registered) return;
      this.modules.delete(contributionId);
      this.notify();
    };
  }

  get(contributionId: string): RegisteredPluginPanel | null {
    return this.panels.get(contributionId) ?? null;
  }

  getModule(contributionId: string): PluginPanelModule | null {
    return this.modules.get(contributionId) ?? null;
  }

  discover(accepts: readonly PanelContractV1[]): readonly RegisteredPluginPanel[] {
    return Object.freeze([...this.panels.values()].filter(panel => accepts.some(contract =>
      contract.id === panel.contract.id && contract.version === panel.contract.version)));
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Panel registry listener must be a function.');
    const subscription = () => listener();
    this.listeners.add(subscription);
    return () => { this.listeners.delete(subscription); };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { continue; }
    }
  }
}

export const appPanels = new PluginPanelRegistry();
