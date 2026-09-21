import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { slackCommunicationProvider } from './provider.js';

const plugin: PluginBackendModule = { activate(context) { context.registerCommunication('slack', slackCommunicationProvider); } };
export default plugin;
