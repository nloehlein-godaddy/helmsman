import type { TriggerBackendModuleV1 } from '@helmsman/plugin-sdk';
import { campaignTriggerProvider } from './provider.js';

const module: TriggerBackendModuleV1 = {
  activate(context) {
    const enabled = typeof context.settings.enabled === 'boolean' ? context.settings.enabled : true;
    const intervalMs = typeof context.settings.intervalMs === 'number' ? context.settings.intervalMs : 5_000;
    context.registerTrigger('dispatch', campaignTriggerProvider({ enabled, intervalMs }));
  },
};

export default module;
