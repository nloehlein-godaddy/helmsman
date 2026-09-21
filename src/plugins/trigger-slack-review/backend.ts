import type { TriggerBackendModuleV1 } from '@helmsman/plugin-sdk';
import { parseRepoFilterJson, slackReviewTriggerProvider } from './provider.js';

const module: TriggerBackendModuleV1 = {
  activate(context) {
    const enabled = typeof context.settings.enabled === 'boolean' ? context.settings.enabled : true;
    const intervalMs = typeof context.settings.intervalMs === 'number' ? context.settings.intervalMs : 300_000;
    const overlapSeconds = typeof context.settings.overlapSeconds === 'number' ? context.settings.overlapSeconds : 300;
    const repoFilterJson = typeof context.settings.repoFilterJson === 'string' ? context.settings.repoFilterJson : '[]';
    context.registerTrigger('watch', slackReviewTriggerProvider({ enabled, intervalMs, overlapSeconds, repoFilter: parseRepoFilterJson(repoFilterJson) }));
  },
};

export default module;
