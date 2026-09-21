import { appPages, HELM_PAGE_SLOT } from './builtins';
import { appPanels } from './panels';
import { openCompositionLayoutStore, type CompositionLayoutStore } from './composition-layout';
import { PluginCompositionHost, type CompositionLayoutPort } from './composition-host';
import type { CompositionLayoutV1, PageCompositionDefinitionV1 } from './composition';
import type { PluginPageState } from './sdk';
import { loadRackLayoutRaw } from '../logic/prefs';
import { initializeTaskPageLayout } from './task-page-migration';

export function initialCompositionLayout(definition: PageCompositionDefinitionV1): CompositionLayoutV1 {
  return { version: 1, compositionId: definition.id, revision: 0,
    instances: definition.initialLayout?.instances.map(instance => ({ ...instance, hidden: false, scope: { kind: 'inherit' }, state: {} })) ?? [],
    columns: definition.initialLayout?.columns ?? [] };
}

export class AppCompositionFactory {
  private readonly stores = new Map<string, Promise<CompositionLayoutStore>>();
  private readonly legacyRack = loadRackLayoutRaw();
  private disposed = false;

  create(id: string, container: HTMLElement, state: PluginPageState, navigate: (href: string) => void): PluginCompositionHost | null {
    if (this.disposed) throw new DOMException('Composition factory disposed.', 'AbortError');
    const page = appPages.getPage(id);
    const definition = page?.composition;
    if (!definition) {
      if (page?.requires?.some(requirement => requirement.id === 'helmsman/composition')) throw new Error('Page requires a declared composition.');
      return null;
    }
    let pending = this.stores.get(definition.id);
    if (!pending) {
      pending = openCompositionLayoutStore({ compositionId: definition.id, initialLayout: initialCompositionLayout(definition),
        ...(definition.id === 'helmsman/triage-page' ? { initialize: initializeTaskPageLayout } : {}),
        ...(definition.id === HELM_PAGE_SLOT ? { legacy: { rackRaw: this.legacyRack } } : {}) });
      this.stores.set(definition.id, pending);
      const opening = pending;
      void pending.then(store => { if (this.disposed) store.close(); }).catch(() => {
        if (this.stores.get(definition.id) === opening) this.stores.delete(definition.id);
      });
    }
    const store = pending;
    const port: CompositionLayoutPort = {
      read: async () => (await store).read(),
      update: async (layout, revision, signal) => (await store).update(layout, revision, signal),
      subscribe: listener => {
        let removed = false;
        let unsubscribe: (() => void) | null = null;
        void store.then(store => { if (!removed && !this.disposed) unsubscribe = store.subscribe(listener); }).catch(() => {});
        return () => { removed = true; unsubscribe?.(); };
      },
    };
    return new PluginCompositionHost(state, { definition, registry: appPanels, layout: port, container, navigate });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.stores.values()) void pending.then(store => store.close()).catch(() => {});
    this.stores.clear();
  }
}
