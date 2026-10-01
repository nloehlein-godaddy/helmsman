import { parseTriggerRoleV1 } from '../../../src/plugins/trigger';
import { parseWorkflowModeV1 } from '../../../src/plugins/workflow';
import { canonicalWorkflowProviderId } from '../workflow-selection';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { packPluginDirectory, readPluginArchiveFile } from './artifacts';
import { validatePluginImports } from './imports';
import { configurePlugin, createPluginCoordinator, installPlugin, pluginDirectory, readPluginState, resetPluginSettings, selectPluginPage, setPluginEnabled, type PluginCoordinator } from './store';
import { selectFeedbackTrackerProvider, selectTriggerProvider, selectWorkflowProvider, selectNativeTerminalProvider, selectExecutionHostProvider, selectAgentProvider, selectAgentReviewers, selectCommunicationProvider, selectPricingProvider, selectPullRequestProvider, selectSchedulingProvider } from './data';
import { openPersistence, registerPersistenceWriter, type Persistence } from '../persistence';
import { openExecutionStore } from '../execution-store';
import { openPluginLifecycle } from './lifecycle';
import { backupPersistenceSet } from '../persistence-backup';

const usage = 'Usage: plugins [--dir STORE] [--db DATABASE] pack DIRECTORY ARCHIVE | install ARCHIVE | enable ID | disable ID | uninstall ID | collect HASH | backup DESTINATION | select SLOT ID|default | configure ID JSON | reset-settings ID [KEY] | select-pricing ID|default | select-pull-request ID|default | select-feedback ID|disabled | select-communication ID|default | select-scheduling ID|default | select-trigger campaign|slack-review|github-review|github-webhook ID|default|disabled | select-workflow coding|review|branch ID|default | select-native-terminal ID|default | select-browser-host ID|default | select-execution-host ID|default | select-agent ID|default | select-agent-reviewers ID[,ID...]|default | list';

export async function pluginCommand(args: string[], options: { coordinate?: boolean; dbPath?: string } = {}): Promise<string> {
  const rest = [...args];
  let root = pluginDirectory();
  let dbPath = options.dbPath ?? process.env.HELMSMAN_DB ?? join(process.cwd(), '.helmsman.sqlite');
  while (rest[0] === '--dir' || rest[0] === '--db') {
    if (!rest[1]) throw new Error(usage);
    if (rest[0] === '--dir') root = rest[1]; else dbPath = rest[1];
    rest.splice(0, 2);
  }
  const [command, first, second] = rest;
  if ((command === '--help' || command === 'help') && rest.length === 1) return `${usage}\n\nbackup requires an offline application and an unused destination directory. It captures the main, catalog, and plugin-data databases with a checksummed manifest. Retain the plugin and runtime artifact stores alongside the backup.`;
  if (command === 'backup') {
    if (!first || rest.length !== 2) throw new Error(usage);
    const databases = { main: resolve(dbPath), catalog: resolve(root, 'catalog.sqlite'), data: resolve(root, 'plugin-data.sqlite') };
    await backupPersistenceSet({ databases, destination: first, metadata: {
      creator: 'helmsman-plugin-cli', databases, pluginDirectory: resolve(root),
      node: process.versions.node, platform: process.platform, architecture: process.arch,
    } });
    return `Persistence backup saved to ${resolve(first)}. Retain the plugin and runtime artifact stores alongside this backup.`;
  }
  let persistence: Persistence | undefined;
  let coordinator: PluginCoordinator | undefined;
  let releaseWriter: (() => void) | undefined;
  if ((options.coordinate !== false || args.includes('--db') || command === 'uninstall' || command === 'collect') && command && ['install', 'enable', 'disable', 'uninstall', 'collect', 'select', 'configure', 'reset-settings', 'select-pricing', 'select-pull-request', 'select-communication', 'select-feedback', 'select-scheduling', 'select-agent', 'select-agent-reviewers', 'select-execution-host', 'select-native-terminal', 'select-browser-host', 'select-workflow', 'select-trigger'].includes(command)) {
    persistence = openPersistence(dbPath);
    try {
      const executions = openExecutionStore(persistence);
      const lifecycle = openPluginLifecycle(persistence, executions);
      coordinator = await createPluginCoordinator({ root, persistence, executions, lifecycle });
      releaseWriter = registerPersistenceWriter(persistence, 'plugin-cli');
    } catch (error) { persistence.close(); throw error; }
  }
  try {
  if (command === 'configure' && first && second && rest.length === 3) return JSON.stringify(await configurePlugin(root, first, JSON.parse(second)), null, 2);
  if (command === 'reset-settings' && first && (rest.length === 2 || rest.length === 3 && second)) {
    resetPluginSettings(root, first, second);
    return 'Plugin settings reset. Restart Helmsman to apply declared defaults.';
  }
  if (command === 'select-pricing' && first && rest.length === 2) {
    selectPricingProvider(root, first === 'default' ? null : first);
    return 'Pricing selection saved.';
  }
  if (command === 'select-trigger' && first && rest[2] && rest.length === 3) {
    const kind = parseTriggerRoleV1(first); const value = rest[2];
    selectTriggerProvider(root, kind, value === 'disabled' || value === 'null' ? null : value);
    return 'Trigger selection saved.';
  }
  if (command === 'select-workflow' && first && rest[2] && rest.length === 3) {
    const mode = parseWorkflowModeV1(first); const value = rest[2];
    selectWorkflowProvider(root, mode, value === 'default' || value === 'null' ? null : canonicalWorkflowProviderId(value));
    return 'Workflow selection saved for future voyages.';
  }
  if ((command === 'select-native-terminal' || command === 'select-browser-host') && first && rest.length === 2) {
    selectNativeTerminalProvider(root, command === 'select-browser-host' ? 'browser' : 'terminal', first === 'default' ? null : first);
    return 'Native terminal provider selection saved.';
  }
  if (command === 'select-execution-host' && first && rest.length === 2) {
    selectExecutionHostProvider(root, first === 'default' ? null : first);
    return 'Execution host selection saved for future voyages.';
  }
  if (command === 'select-agent' && first && rest.length === 2) {
    selectAgentProvider(root, first === 'default' ? null : first);
    return 'Agent selection saved for future voyages.';
  }
  if (command === 'select-agent-reviewers' && first && rest.length === 2) {
    selectAgentReviewers(root, first === 'default' ? null : first.split(','));
    return 'Ordered agent reviewer selection saved for future voyages.';
  }
  if (command === 'select-scheduling' && first && rest.length === 2) {
    selectSchedulingProvider(root, first === 'default' ? null : first);
    return 'Scheduling provider selection saved for future automatic starts.';
  }
  if (command === 'select-pull-request' && first && rest.length === 2) {
    selectPullRequestProvider(root, first === 'default' ? null : first);
    return 'Pull request provider selection saved.';
  }
  if (command === 'select-feedback' && first && rest.length === 2) { selectFeedbackTrackerProvider(root, first === 'disabled' ? null : first); return 'Feedback tracker selection saved.'; }
  if (command === 'select-communication' && first && rest.length === 2) {
    selectCommunicationProvider(root, first === 'default' ? null : first);
    return 'Communication provider selection saved.';
  }
  if (command === 'pack' && first && second && rest.length === 3) {
    const archive = await packPluginDirectory(first);
    await validatePluginImports(archive);
    await writeFile(second, archive.bytes, { flag: 'wx' });
    return `Packed ${archive.package.manifest.id}: ${archive.hash}`;
  }
  if (command === 'install' && first && rest.length === 2) {
    const archive = await readPluginArchiveFile(first);
    const installed = await installPlugin(root, archive.bytes, coordinator);
    return `Installed ${installed.id} (${installed.hash}). ${installed.enabled ? 'Already enabled.' : 'Disabled; enable only packages you trust.'}`;
  }
  if ((command === 'enable' || command === 'disable') && first && rest.length === 2) {
    await setPluginEnabled(root, first, command === 'enable', coordinator);
    return `${command === 'enable' ? 'Enabled' : 'Disabled'} ${first}. Restart Helmsman and reload browser tabs to apply.`;
  }
  if (command === 'uninstall' && first && rest.length === 2 && coordinator) {
    await coordinator.uninstall(first);
    return `Uninstalled ${first}. Settings, layout bindings, and historical provenance are retained.`;
  }
  if (command === 'collect' && first && rest.length === 2 && coordinator) {
    await coordinator.collect(first);
    return `Collected unreferenced plugin artifact ${first}.`;
  }
  if (command === 'select' && first && second && rest.length === 3) {
    await selectPluginPage(root, first, second === 'default' ? null : second);
    return 'Page selection saved. Restart Helmsman and reload browser tabs to apply.';
  }
  if (command === 'list' && rest.length === 1) return JSON.stringify(readPluginState(root), null, 2);
  throw new Error(usage);
  } finally { coordinator?.dispose(); releaseWriter?.(); persistence?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  pluginCommand(process.argv.slice(2), { coordinate: true }).then(message => process.stdout.write(`${message}\n`), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Plugin command failed.'}\n`);
    process.exitCode = 1;
  });
}
