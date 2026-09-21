import type { AgentBackendModuleV1 } from '@helmsman/plugin-sdk';
import { codexAgentProvider } from './provider.js';

const plugin: AgentBackendModuleV1 = {
  activate(context) {
    context.registerAgent('codex', codexAgentProvider);
  },
};

export default plugin;
