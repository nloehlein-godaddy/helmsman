import type { PluginBackendModule } from '@helmsman/plugin-sdk';
import { githubPullRequestProvider } from './provider.js';

const plugin: PluginBackendModule = { activate(context) { context.registerPullRequest('github', githubPullRequestProvider); } };
export default plugin;
