import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { jiraProvider } from './provider.js';

const plugin: PluginBackendModule = { activate(context) { context.registerTaskSource('issues', jiraProvider); } };
export default plugin;
