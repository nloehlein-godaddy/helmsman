import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { createSlackOiProvider } from './provider.js';

const plugin: PluginBackendModule = { activate(context) { context.registerCommunication('slack', createSlackOiProvider()); } };
export default plugin;
