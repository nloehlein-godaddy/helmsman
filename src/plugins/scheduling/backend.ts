import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { roundRobinSchedulingProvider } from './provider.js';

const plugin: PluginBackendModule = {
  activate(context) {
    const intervalMs = context.settings.intervalMs;
    context.registerScheduling('round-robin', {
      ...roundRobinSchedulingProvider,
      intervalMs: typeof intervalMs === 'number' && Number.isFinite(intervalMs) ? intervalMs : roundRobinSchedulingProvider.intervalMs,
    });
  },
};

export default plugin;
