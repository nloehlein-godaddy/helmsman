import type { AgentBackendModuleV1 } from '@helmsman/plugin-sdk';
import { claudeAgentProvider } from './provider.js';

const plugin: AgentBackendModuleV1 = { activate(context) { context.registerAgent('claude-code', claudeAgentProvider); } };
export default plugin;
