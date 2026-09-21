import type { AgentBackendModuleV1 } from '@helmsman/plugin-sdk';
import { commandAgentProvider } from './provider.js';

const plugin: AgentBackendModuleV1 = {
  activate(context) {
    const commandTemplate = typeof context.settings.commandTemplate === 'string' ? context.settings.commandTemplate : '';
    context.registerAgent('command', commandAgentProvider(commandTemplate));
  },
};

export default plugin;
