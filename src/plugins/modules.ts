import { isContributionId, PluginManifestError } from './manifest';
import type { PluginPageModule } from './sdk';

function method<K extends 'mount' | 'attention'>(module: PluginPageModule, name: K): PluginPageModule[K] {
  if (!module || typeof module !== 'object') throw new PluginManifestError('Page module must be an object.');
  let source: object | null = module;
  while (source) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor) {
      if (name === 'attention' && 'value' in descriptor && descriptor.value === undefined) return undefined as PluginPageModule[K];
      if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value;
      break;
    }
    source = Object.getPrototypeOf(source) as object | null;
  }
  if (name === 'attention' && !source) return undefined as PluginPageModule[K];
  throw new PluginManifestError(`Page module must declare a callable ${name} method.`);
}

export class PluginPageModules {
  private readonly modules = new Map<string, PluginPageModule>();
  private readonly listeners = new Set<() => void>();

  register(contributionId: string, module: PluginPageModule): () => void {
    if (!isContributionId(contributionId)) throw new PluginManifestError('Invalid contribution ID.');
    if (this.modules.has(contributionId)) throw new PluginManifestError(`Page module ${contributionId} is already registered.`);
    const mount = method(module, 'mount');
    const attention = method(module, 'attention');
    const registered = Object.freeze<PluginPageModule>({
      mount: (container, context) => mount.call(module, container, context),
      ...(attention ? { attention: context => attention.call(module, context) } : {}),
    });
    this.modules.set(contributionId, registered);
    this.notify();
    return () => {
      if (this.modules.get(contributionId) !== registered) return;
      this.modules.delete(contributionId);
      this.notify();
    };
  }

  get(contributionId: string): PluginPageModule | null {
    return this.modules.get(contributionId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new PluginManifestError('Module listener must be a function.');
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
