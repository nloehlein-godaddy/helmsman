import type { PluginPageModule } from './sdk';
import type { PluginPanelModule } from './composition';

function cachedModule<T>(load: () => Promise<{ default: T }>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => pending ??= Promise.resolve().then(load).then(value => value.default).catch(error => {
    pending = null;
    throw error;
  });
}

export function lazyPageModule(load: () => Promise<{ default: PluginPageModule }>, attention?: PluginPageModule['attention']): PluginPageModule {
  const resolve = cachedModule(load);
  return {
    ...(attention ? { attention } : {}),
    async mount(container, context) {
      context.signal.throwIfAborted();
      const module = await resolve();
      context.signal.throwIfAborted();
      return module.mount(container, context);
    },
  };
}

export function lazyPanelModule(load: () => Promise<{ default: PluginPanelModule }>): PluginPanelModule {
  const resolve = cachedModule(load);
  return {
    async mount(container, context) {
      context.signal.throwIfAborted();
      const module = await resolve();
      context.signal.throwIfAborted();
      return module.mount(container, context);
    },
  };
}
