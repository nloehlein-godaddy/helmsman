import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packPluginDirectory, readPluginArchiveFile } from './artifacts';
import { validatePluginImports } from './imports';
import { configurePlugin, installPlugin, pluginDirectory, readPluginState, resetPluginSettings, selectPluginPage, setPluginEnabled } from './store';
import { selectPricingProvider } from './data';

const usage = 'Usage: plugins [--dir STORE] pack DIRECTORY ARCHIVE | install ARCHIVE | enable ID | disable ID | select SLOT ID|default | configure ID JSON | reset-settings ID [KEY] | select-pricing ID|default | list';

export async function pluginCommand(args: string[]): Promise<string> {
  const rest = [...args];
  let root = pluginDirectory();
  if (rest[0] === '--dir') {
    if (!rest[1]) throw new Error(usage);
    root = rest[1]; rest.splice(0, 2);
  }
  const [command, first, second] = rest;
  if (command === 'configure' && first && second && rest.length === 3) return JSON.stringify(await configurePlugin(root, first, JSON.parse(second)), null, 2);
  if (command === 'reset-settings' && first && (rest.length === 2 || rest.length === 3 && second)) {
    resetPluginSettings(root, first, second);
    return 'Plugin settings reset. Restart Helmsman to apply declared defaults.';
  }
  if (command === 'select-pricing' && first && rest.length === 2) {
    selectPricingProvider(root, first === 'default' ? null : first);
    return 'Pricing selection saved.';
  }
  if (command === 'pack' && first && second && rest.length === 3) {
    const archive = await packPluginDirectory(first);
    await validatePluginImports(archive);
    await writeFile(second, archive.bytes, { flag: 'wx' });
    return `Packed ${archive.package.manifest.id}: ${archive.hash}`;
  }
  if (command === 'install' && first && rest.length === 2) {
    const archive = await readPluginArchiveFile(first);
    const installed = await installPlugin(root, archive.bytes);
    return `Installed ${installed.id} (${installed.hash}). ${installed.enabled ? 'Already enabled.' : 'Disabled; enable only packages you trust.'}`;
  }
  if ((command === 'enable' || command === 'disable') && first && rest.length === 2) {
    await setPluginEnabled(root, first, command === 'enable');
    return `${command === 'enable' ? 'Enabled' : 'Disabled'} ${first}. Restart Helmsman and reload browser tabs to apply.`;
  }
  if (command === 'select' && first && second && rest.length === 3) {
    await selectPluginPage(root, first, second === 'default' ? null : second);
    return 'Page selection saved. Restart Helmsman and reload browser tabs to apply.';
  }
  if (command === 'list' && rest.length === 1) return JSON.stringify(readPluginState(root), null, 2);
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  pluginCommand(process.argv.slice(2)).then(message => process.stdout.write(`${message}\n`), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Plugin command failed.'}\n`);
    process.exitCode = 1;
  });
}
