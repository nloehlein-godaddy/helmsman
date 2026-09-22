import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { createSlackCompanionProvider } from './provider.js';

const plugin: PluginBackendModule = { activate(context) { context.registerCommunication('slack', createSlackCompanionProvider()); } };
export default plugin;
