import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  NativeTerminalBrowserV1,
  NativeTerminalProviderV1,
  NativeTerminalSurfaceV1,
} from '@helmsman/plugin-sdk';

const OUTPUT_BYTES = 4 * 1024 * 1024;
const SCREEN_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const REFERENCE_BYTES = 256;

export interface NativeSocketStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly birthtimeNs: bigint;
}

export type CmuxCommandRunner = (args: readonly string[], signal?: AbortSignal, socketPath?: string) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolveCmuxSocket(
  configured = '',
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (configured) return configured;
  const candidates = [join(home, '.local', 'state', 'cmux', 'cmux.sock'), join(home, '.config', 'cmux', 'cmux.sock'), '/tmp/cmux.sock'];
  return candidates.find(exists) ?? candidates[0]!;
}

export function createNativeSessionIdentity(options: {
  readonly kind: string;
  readonly socket: () => string | null;
  readonly startup?: string;
  readonly stat?: (path: string) => NativeSocketStat;
}): () => string {
  const startup = options.startup ?? randomUUID();
  const inspect = options.stat ?? (path => statSync(path, { bigint: true }));
  const metadata = (path: string) => {
    const value = inspect(path);
    return { dev: String(value.dev), ino: String(value.ino), created: String(value.birthtimeNs), changed: String(value.ctimeNs), modified: String(value.mtimeNs) };
  };
  return () => {
    const socket = options.socket();
    if (socket === null) return hash({ startup, kind: options.kind, socket });
    try { return hash({ startup, kind: options.kind, socket, metadata: metadata(socket) }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw error;
      try { return hash({ startup, kind: options.kind, socket, parent: metadata(dirname(socket)) }); }
      catch (parentError) {
        if (code === 'ENOENT' && (parentError as NodeJS.ErrnoException)?.code === 'ENOENT') return hash({ startup, kind: options.kind, socket, missing: true });
        throw parentError;
      }
    }
  };
}

function commandRunner(binary: string, socket: () => string): CmuxCommandRunner {
  return (args, signal, socketPath) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, [...args], {
      env: { ...process.env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socketPath ?? socket() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    };
    const fail = (error: Error) => {
      child.kill();
      finish(() => reject(error));
    };
    const append = (target: 'stdout' | 'stderr', chunk: unknown) => {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > OUTPUT_BYTES) { fail(new Error('cmux command output exceeds the limit')); return; }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('cmux command aborted'));
    const timer = setTimeout(() => fail(new Error('cmux command timed out')), TIMEOUT_MS);
    child.stdout?.on('data', chunk => append('stdout', chunk));
    child.stderr?.on('data', chunk => append('stderr', chunk));
    child.once('error', error => finish(() => reject(error)));
    child.once('close', code => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function bounded(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || !empty && !value || value.length > maximum || Buffer.byteLength(value) > maximum || value.includes('\0')) {
    throw new TypeError('Invalid cmux argument');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout) > OUTPUT_BYTES) throw new Error('cmux JSON output exceeds the limit');
  return JSON.parse(stdout) as unknown;
}

interface Workspace {
  readonly windowRef: string;
  readonly workspaceRef: string;
  readonly workspaceTitle: string;
  readonly cwd: string | null;
}

function parseWorkspaces(value: unknown): readonly Workspace[] | null {
  const row = record(value);
  if (!row || typeof row.window_ref !== 'string' || !Array.isArray(row.workspaces) || row.workspaces.length > 4096) return null;
  const windowRef = bounded(row.window_ref, REFERENCE_BYTES);
  const result: Workspace[] = [];
  for (const item of row.workspaces) {
    const workspace = record(item);
    if (!workspace || typeof workspace.ref !== 'string') return null;
    const workspaceRef = bounded(workspace.ref, REFERENCE_BYTES);
    const title = typeof workspace.title === 'string' ? workspace.title
      : typeof workspace.custom_title === 'string' ? workspace.custom_title : workspaceRef;
    const cwd = workspace.current_directory === null || workspace.current_directory === undefined
      ? null : bounded(workspace.current_directory, 4096);
    result.push({ windowRef, workspaceRef, workspaceTitle: bounded(title, 4096, true), cwd });
  }
  return result;
}

function parseSurfaces(value: unknown, workspace: Workspace): readonly NativeTerminalSurfaceV1[] | null {
  const row = record(value);
  if (!row || !Array.isArray(row.surfaces) || row.surfaces.length > 4096) return null;
  const result: NativeTerminalSurfaceV1[] = [];
  for (const item of row.surfaces) {
    const surface = record(item);
    if (!surface || typeof surface.ref !== 'string' || typeof surface.title !== 'string'
      || typeof surface.type !== 'string' || typeof surface.selected !== 'boolean') return null;
    result.push({
      ...workspace,
      surfaceRef: bounded(surface.ref, REFERENCE_BYTES),
      surfaceTitle: bounded(surface.title, 4096, true),
      type: bounded(surface.type, 128),
      selected: surface.selected,
    });
  }
  return result;
}

function browserProvider(run: CmuxCommandRunner, socket: () => string): NativeTerminalBrowserV1 {
  const command = async (args: readonly string[], signal?: AbortSignal): Promise<string> => {
    const result = await run(args, signal, socket());
    if (result.code !== 0) throw new Error('cmux browser command failed');
    return result.stdout;
  };
  return Object.freeze<NativeTerminalBrowserV1>({
    async tree(signal) {
      return parseJson(await command(['--id-format', 'both', 'tree', '--all', '--json'], signal));
    },
    async focus(input, signal) {
      const surface = bounded(input?.surface, REFERENCE_BYTES);
      await command(['rpc', 'surface.focus', JSON.stringify({ surface_id: surface })], signal);
    },
    async evaluate(input, signal) {
      const output = await command(['browser', bounded(input?.surface, REFERENCE_BYTES), 'eval', bounded(input?.script, 1024 * 1024)], signal);
      return parseJson(output);
    },
    async click(input, signal) {
      await command(['browser', bounded(input?.surface, REFERENCE_BYTES), 'click', bounded(input?.selector, 8192)], signal);
    },
    async fill(input, signal) {
      await command(['browser', bounded(input?.surface, REFERENCE_BYTES), 'fill', bounded(input?.selector, 8192), bounded(input?.value, 128 * 1024, true)], signal);
    },
    async wait(input, signal) {
      if (!Number.isSafeInteger(input?.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > TIMEOUT_MS) throw new TypeError('Invalid cmux wait timeout');
      await command(['browser', bounded(input?.surface, REFERENCE_BYTES), 'wait', '--selector', bounded(input?.selector, 8192), '--timeout-ms', String(input.timeoutMs)], signal);
    },
  });
}

export interface CmuxNativeTerminalOptions {
  readonly binary?: string;
  readonly socketPath?: string;
  readonly home?: string;
  readonly exists?: (path: string) => boolean;
  readonly run?: CmuxCommandRunner;
  readonly startup?: string;
  readonly stat?: (path: string) => NativeSocketStat;
}

export function createCmuxNativeTerminal(options: CmuxNativeTerminalOptions = {}): NativeTerminalProviderV1 {
  const socket = () => resolveCmuxSocket(options.socketPath ?? '', options.home, options.exists);
  const run = options.run ?? commandRunner(options.binary || 'cmux', socket);
  const sessionIdentity = createNativeSessionIdentity({ kind: 'cmux', socket, startup: options.startup, stat: options.stat });
  const fetchSurfaces = async (workspace: Workspace, socketPath: string, signal?: AbortSignal): Promise<readonly NativeTerminalSurfaceV1[] | null> => {
    const response = await run(['list-pane-surfaces', '--workspace', workspace.workspaceRef, '--json'], signal, socketPath);
    return response.code === 0 ? parseSurfaces(parseJson(response.stdout), workspace) : null;
  };
  const collect = async (workspaces: readonly Workspace[], socketPath: string, signal?: AbortSignal): Promise<readonly NativeTerminalSurfaceV1[] | null> => {
    const tabs: NativeTerminalSurfaceV1[] = [];
    for (const workspace of workspaces) {
      const surfaces = await fetchSurfaces(workspace, socketPath, signal);
      if (surfaces === null) continue;
      tabs.push(...surfaces);
      if (tabs.length > 4096) return null;
    }
    return tabs;
  };
  return {
    metadata: { version: 1, label: 'cmux', browser: true },
    sessionIdentity,
    async listTabs(signal) {
      try {
        const socketPath = socket();
        const windows = await run(['list-windows', '--json'], signal, socketPath);
        if (windows.code === 0) {
          const value = parseJson(windows.stdout);
          if (Array.isArray(value) && value.length > 0 && value.length <= 256) {
            const all: Workspace[] = [];
            for (const item of value) {
              const window = record(item);
              if (!window || window.id === undefined) { all.length = 0; break; }
              if (typeof window.id !== 'string' && typeof window.id !== 'number') { all.length = 0; break; }
              const response = await run(['workspace', 'list', '--window', bounded(String(window.id), REFERENCE_BYTES), '--json'], signal, socketPath);
              const parsed = response.code === 0 ? parseWorkspaces(parseJson(response.stdout)) : null;
              if (parsed) all.push(...parsed);
            }
            if (all.length > 0 && all.length <= 4096) {
              const tabs = await collect(all, socketPath, signal);
              if (tabs) return { connected: true, tabs };
            }
          }
        }
        const response = await run(['workspace', 'list', '--json'], signal, socketPath);
        if (response.code !== 0) return { connected: false, tabs: [] };
        const workspaces = parseWorkspaces(parseJson(response.stdout));
        if (!workspaces) return { connected: false, tabs: [] };
        return { connected: true, tabs: await collect(workspaces, socketPath, signal) ?? [] };
      } catch {
        return { connected: false, tabs: [] };
      }
    },
    async readScreen(surfaceRef, lines, signal) {
      try {
        const response = await run(['read-screen', '--surface', bounded(surfaceRef, REFERENCE_BYTES), '--lines', String(lines)], signal, socket());
        if (response.code !== 0) return { ok: false, error: response.stderr || 'read failed' };
        if (Buffer.byteLength(response.stdout) > SCREEN_BYTES) return { ok: false, error: 'screen output exceeds the limit' };
        return { ok: true, text: response.stdout };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'cmux unavailable' }; }
    },
    async send(surfaceRef, text, enter, signal) {
      try {
        const surface = bounded(surfaceRef, REFERENCE_BYTES);
        const socketPath = socket();
        const response = await run(['send', '--surface', surface, bounded(text, 128 * 1024, true)], signal, socketPath);
        if (response.code !== 0) return { ok: false, error: response.stderr || 'send failed' };
        if (enter) {
          const key = await run(['send-key', '--surface', surface, 'Enter'], signal, socketPath);
          if (key.code !== 0) return { ok: false, error: key.stderr || 'enter failed' };
        }
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'cmux unavailable' }; }
    },
    async sendKey(surfaceRef, key, signal) {
      try {
        const response = await run(['send-key', '--surface', bounded(surfaceRef, REFERENCE_BYTES), bounded(key, 128)], signal, socket());
        return response.code === 0 ? { ok: true } : { ok: false, error: response.stderr || 'send-key failed' };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'cmux unavailable' }; }
    },
    browser: browserProvider(run, socket),
  };
}
