import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeTerminalProviderV1, NativeTerminalSurfaceV1 } from '@helmsman/plugin-sdk';

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

export interface WeztermSocketCandidate {
  readonly path: string;
  readonly pid: number;
  readonly mtimeMs: number | null;
}

export type WeztermCommandRunner = (args: readonly string[], socket: string, signal?: AbortSignal) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function weztermRuntimeDirectory(home = homedir()): string {
  return join(home, '.local', 'share', 'wezterm');
}

export function weztermSocketCandidates(directory: string): readonly WeztermSocketCandidate[] {
  let names: string[];
  try { names = readdirSync(directory); }
  catch { return []; }
  const result: WeztermSocketCandidate[] = [];
  for (const name of names) {
    const match = /^gui-sock-(\d+)$/.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    let mtimeMs: number | null = null;
    try { mtimeMs = statSync(path).mtimeMs; } catch {}
    result.push({ path, pid: Number(match[1]), mtimeMs });
  }
  return result;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

export function pickWeztermSocket(
  candidates: readonly WeztermSocketCandidate[],
  alive: (pid: number) => boolean = pidAlive,
): string | null {
  const live = candidates.filter(candidate => alive(candidate.pid));
  if (live.length === 0) return null;
  const dated = live.filter(candidate => candidate.mtimeMs !== null);
  const pool = dated.length > 0 ? dated : live;
  return pool.reduce((left, right) => {
    if (left.mtimeMs !== null && right.mtimeMs !== null) return right.mtimeMs > left.mtimeMs ? right : left;
    return right.pid > left.pid ? right : left;
  }).path;
}

export function resolveWeztermSocket(options: {
  readonly configured?: string;
  readonly directory?: string;
  readonly candidates?: (directory: string) => readonly WeztermSocketCandidate[];
  readonly alive?: (pid: number) => boolean;
} = {}): string | null {
  if (options.configured) return options.configured;
  const directory = options.directory ?? weztermRuntimeDirectory();
  return pickWeztermSocket((options.candidates ?? weztermSocketCandidates)(directory), options.alive);
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

function commandRunner(binary: string): WeztermCommandRunner {
  return (args, socket, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, [...args], {
      env: { ...process.env, WEZTERM_UNIX_SOCKET: socket },
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
      if (bytes > OUTPUT_BYTES) { fail(new Error('WezTerm command output exceeds the limit')); return; }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('WezTerm command aborted'));
    const timer = setTimeout(() => fail(new Error('WezTerm command timed out')), TIMEOUT_MS);
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
    throw new TypeError('Invalid WezTerm argument');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout) > OUTPUT_BYTES) throw new Error('WezTerm JSON output exceeds the limit');
  return JSON.parse(stdout) as unknown;
}

export function weztermCwd(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) return null;
  if (!raw.startsWith('file://')) return raw;
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(raw).pathname); }
  catch { return null; }
  if (/^\/[a-z]:/i.test(pathname)) {
    const drivePath = pathname.slice(1);
    return process.platform === 'win32' ? drivePath.replaceAll('/', '\\') : drivePath;
  }
  try { return fileURLToPath(raw); } catch { return pathname; }
}

function parsePanes(value: unknown, focusedPane: number | null): readonly NativeTerminalSurfaceV1[] | null {
  if (!Array.isArray(value) || value.length > 4096) return null;
  const result: NativeTerminalSurfaceV1[] = [];
  for (const item of value) {
    const pane = record(item);
    if (!pane || !Number.isSafeInteger(pane.window_id) || !Number.isSafeInteger(pane.tab_id) || !Number.isSafeInteger(pane.pane_id)) return null;
    const paneId = Number(pane.pane_id);
    const workspace = typeof pane.workspace === 'string' ? bounded(pane.workspace, 4096, true) : '';
    const tabTitle = typeof pane.tab_title === 'string' && pane.tab_title ? bounded(pane.tab_title, 4096) : workspace || `tab ${pane.tab_id}`;
    const title = typeof pane.title === 'string' && pane.title ? bounded(pane.title, 4096) : `pane ${paneId}`;
    result.push({
      windowRef: `window:${pane.window_id}`,
      workspaceRef: `tab:${pane.tab_id}`,
      workspaceTitle: tabTitle,
      surfaceRef: String(paneId),
      surfaceTitle: title,
      type: 'terminal',
      cwd: weztermCwd(pane.cwd),
      selected: focusedPane === null ? pane.is_active === true : paneId === focusedPane,
    });
  }
  return result;
}

function keyBytes(key: string): string | null {
  const named: Record<string, string> = {
    enter: '\r', escape: '\x1b', tab: '\t', backspace: '\x7f', up: '\x1b[A', down: '\x1b[B',
    right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  };
  const value = named[key.toLowerCase()];
  if (value !== undefined) return value;
  const control = /^(?:ctrl\+|c-)([a-z])$/i.exec(key);
  if (control?.[1]) return String.fromCharCode(control[1].toLowerCase().charCodeAt(0) - 96);
  return key.length === 1 && key >= ' ' && key <= '~' ? key : null;
}

export interface WeztermNativeTerminalOptions {
  readonly binary?: string;
  readonly socketPath?: string;
  readonly directory?: string;
  readonly candidates?: (directory: string) => readonly WeztermSocketCandidate[];
  readonly alive?: (pid: number) => boolean;
  readonly run?: WeztermCommandRunner;
  readonly startup?: string;
  readonly stat?: (path: string) => NativeSocketStat;
}

export function createWeztermNativeTerminal(options: WeztermNativeTerminalOptions = {}): NativeTerminalProviderV1 {
  const socket = () => resolveWeztermSocket({ configured: options.socketPath, directory: options.directory, candidates: options.candidates, alive: options.alive });
  const run = options.run ?? commandRunner(options.binary || 'wezterm');
  const startup = options.startup ?? randomUUID();
  const sessionIdentity = createNativeSessionIdentity({ kind: 'wezterm', socket, startup, stat: options.stat });
  const socketIdentity = (socketPath: string) => createNativeSessionIdentity({ kind: 'wezterm', socket: () => socketPath, startup, stat: options.stat })();
  const command = async (args: readonly string[], signal?: AbortSignal, pinnedSocket?: string) => {
    const target = pinnedSocket ?? socket();
    if (!target) throw new Error('WezTerm is not running');
    return run(args, target, signal);
  };
  const focusedPane = async (signal?: AbortSignal, pinnedSocket?: string): Promise<number | null> => {
    try {
      const response = await command(['cli', 'list-clients', '--format', 'json'], signal, pinnedSocket);
      const value = response.code === 0 ? parseJson(response.stdout) : null;
      if (!Array.isArray(value)) return null;
      for (const item of value) {
        const client = record(item);
        if (client && Number.isSafeInteger(client.focused_pane_id)) return Number(client.focused_pane_id);
      }
    } catch {}
    return null;
  };
  const sendText = async (surface: string, text: string, signal?: AbortSignal, pinnedSocket?: string) => command(['cli', 'send-text', '--pane-id', surface, '--no-paste', '--', text], signal, pinnedSocket);
  return {
    metadata: { version: 1, label: 'WezTerm', browser: false },
    sessionIdentity,
    async listTabs(signal) {
      const target = socket();
      if (!target) return { connected: false, tabs: [] };
      try {
        const response = await command(['cli', 'list', '--format', 'json'], signal, target);
        if (response.code !== 0) return { connected: false, tabs: [] };
        const tabs = parsePanes(parseJson(response.stdout), await focusedPane(signal, target));
        return tabs ? { connected: true, tabs } : { connected: false, tabs: [] };
      } catch { return { connected: false, tabs: [] }; }
    },
    async readScreen(surfaceRef, lines, signal) {
      try {
        const pane = bounded(surfaceRef, REFERENCE_BYTES);
        if (!/^\d+$/.test(pane)) return { ok: false, error: `not a WezTerm pane id: ${pane}` };
        const target = socket();
        if (!target) throw new Error('WezTerm is not running');
        const response = await command(['cli', 'get-text', '--pane-id', pane, '--start-line', `-${lines}`], signal, target);
        if (response.code !== 0) return { ok: false, error: response.stderr || 'read failed' };
        if (Buffer.byteLength(response.stdout) > SCREEN_BYTES) return { ok: false, error: 'screen output exceeds the limit' };
        return { ok: true, text: response.stdout.replace(/\s+$/, '') };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'WezTerm unavailable' }; }
    },
    async send(surfaceRef, text, enter, signal) {
      try {
        const pane = bounded(surfaceRef, REFERENCE_BYTES);
        if (!/^\d+$/.test(pane)) return { ok: false, error: `not a WezTerm pane id: ${pane}` };
        const target = socket();
        if (!target) throw new Error('WezTerm is not running');
        const identity = socketIdentity(target);
        const response = await sendText(pane, bounded(text, 128 * 1024, true), signal, target);
        if (response.code !== 0) return { ok: false, error: response.stderr || 'send failed' };
        if (socketIdentity(target) !== identity) return { ok: false, error: 'WezTerm native session changed; text input outcome is uncertain' };
        if (enter) {
          const key = await sendText(pane, '\r', signal, target);
          if (key.code !== 0) return { ok: false, error: key.stderr || 'enter failed' };
          if (socketIdentity(target) !== identity) return { ok: false, error: 'WezTerm native session changed; Enter outcome is uncertain' };
        }
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'WezTerm unavailable' }; }
    },
    async sendKey(surfaceRef, key, signal) {
      try {
        const pane = bounded(surfaceRef, REFERENCE_BYTES);
        if (!/^\d+$/.test(pane)) return { ok: false, error: `not a WezTerm pane id: ${pane}` };
        const bytes = keyBytes(bounded(key, 128));
        if (bytes === null) return { ok: false, error: `unsupported key: ${key}` };
        const target = socket();
        if (!target) throw new Error('WezTerm is not running');
        const response = await sendText(pane, bytes, signal, target);
        return response.code === 0 ? { ok: true } : { ok: false, error: response.stderr || 'send-key failed' };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'WezTerm unavailable' }; }
    },
  };
}
