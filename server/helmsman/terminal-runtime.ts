import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import { isContributionId } from '../../src/plugins/manifest';
import type { PluginCatalog } from '../../src/plugins/runtime';

export function terminalContributionEnabled(catalog: PluginCatalog, caller: string): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === 'helmsman/terminal' && requirement.version === 1) === true;
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBridge, type Bridge } from './cmux/bridge';
import { createWezTermBridge } from './wezterm/bridge';
import { resolveSocket } from './wezterm/socket';
import { persistenceHash } from './persistence';

export function resolveCmuxSocket(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), exists: (path: string) => boolean = existsSync): string {
  if (env.CMUX_SOCKET_PATH) return env.CMUX_SOCKET_PATH;
  const paths = [join(home, '.local', 'state', 'cmux', 'cmux.sock'), join(home, '.config', 'cmux', 'cmux.sock'), '/tmp/cmux.sock'];
  return paths.find(exists) ?? paths[0]!;
}
export interface TerminalSocketStat {
  readonly dev: bigint; readonly ino: bigint; readonly ctimeNs: bigint; readonly mtimeNs: bigint; readonly birthtimeNs: bigint;
}
export function createTerminalSessionIdentity(options: {
  readonly kind: string; socket(): string | null; startup?: string; stat?(path: string): TerminalSocketStat;
}): () => string {
  const startup = options.startup ?? randomUUID(); const stat = options.stat ?? (path => statSync(path, { bigint: true }));
  function metadata(path: string) {
    const value = stat(path);
    return { dev: String(value.dev), ino: String(value.ino), created: String(value.birthtimeNs), changed: String(value.ctimeNs), modified: String(value.mtimeNs) };
  }
  return () => {
    const socket = options.socket();
    if (socket === null) return persistenceHash({ startup, kind: options.kind, socket });
    try { return persistenceHash({ startup, kind: options.kind, socket, metadata: metadata(socket) }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw error;
      // Windows sockets cannot be stat'd; replacing an entry changes its parent directory generation.
      try { return persistenceHash({ startup, kind: options.kind, socket, parent: metadata(dirname(socket)) }); }
      catch (parentError) {
        if (code === 'ENOENT' && (parentError as NodeJS.ErrnoException)?.code === 'ENOENT') return persistenceHash({ startup, kind: options.kind, socket, missing: true });
        throw parentError;
      }
    }
  };
}
export function createNativeTerminalRuntime(kind: string): { bridge: Bridge; sessionIdentity(): string } {
  const socket = kind === 'wezterm' ? () => resolveSocket() : () => resolveCmuxSocket();
  const environment = (path: string) => ({ ...process.env, ...(kind === 'wezterm' ? { WEZTERM_UNIX_SOCKET: path } : { CMUX_SOCKET_PATH: path, CMUX_QUIET: '1' }) });
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const path = socket();
    if (!path) return { code: 1, stdout: '', stderr: 'Terminal bridge is unavailable' };
    return new Promise((resolve, reject) => {
      const child = spawn(kind === 'wezterm' ? process.env.WEZTERM_BIN || 'wezterm' : 'cmux', args, { env: environment(path) });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    });
  };
  return { bridge: kind === 'wezterm' ? createWezTermBridge({ run, socket }) : createBridge(run,
    () => spawn('cmux', ['events', '--reconnect', '--no-heartbeat'], { env: environment(socket() ?? resolveCmuxSocket()) })),
    sessionIdentity: createTerminalSessionIdentity({ kind, socket }),
  };
}
