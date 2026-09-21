import type { TriggerBackendModuleV1 } from '@helmsman/plugin-sdk';
import { githubWebhookTriggerProvider, parseGithubWebhookRoutes } from './provider.js';

const module: TriggerBackendModuleV1 = {
  activate(context) {
    const enabled = typeof context.settings.enabled === 'boolean' ? context.settings.enabled : false;
    const routesJson = typeof context.settings.routesJson === 'string' ? context.settings.routesJson : '[]';
    context.registerTrigger('github', githubWebhookTriggerProvider({ enabled, routes: parseGithubWebhookRoutes(routesJson) }));
  },
};

export default module;
