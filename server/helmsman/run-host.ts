import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolveSocket } from './wezterm/socket';
import { launchIdentity, processStartIdentity, readExitEvidence, readLaunchReceipt, type LaunchIdentity } from './host-evidence';
export { launchIdentity, readExitEvidence, readLaunchReceipt } from './host-evidence';

export interface LaunchSpec {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
  logPath: string;
  exitPath: string;
  specPath: string;
  launchId?: string;
  attempt?: number;
  receiptPath?: string;
}

export type HostRef = (
  | { kind: 'detached'; pid: number }
  | { kind: 'cmux'; workspace: string }
  | { kind: 'wezterm'; paneId: string; socket?: string | null }
  | { kind: 'docker'; containerId: string }) & { ownership?: LaunchIdentity & { processStart?: string; pid?: number } };

export type HostDiscovery =
  | { status: 'found'; ref: HostRef; evidence: { launchId: string; runId: string; attempt: number; state: 'running' | 'exited'; exitCode?: number } }
  | { status: 'absent'; evidence: string }
  | { status: 'unknown'; reason: string };

export interface RunHost {
  kind: HostRef['kind'];
  launch(spec: LaunchSpec): Promise<HostRef>;
  isAlive(ref: HostRef): Promise<boolean>;
  stop(ref: HostRef): Promise<void>;
  discover?(spec: LaunchSpec, ref?: HostRef): Promise<HostDiscovery>;
}

export async function discoverRunHost(host: RunHost, spec: LaunchSpec, ref?: HostRef): Promise<HostDiscovery> {
  if (!host.discover) return { status: 'unknown', reason: 'The retained host has no ownership discovery contract' };
  try { return await host.discover(spec, ref); }
  catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'Host discovery failed' }; }
}

async function receiptDiscovery(spec: LaunchSpec, ref?: HostRef): Promise<HostDiscovery> {
  const identity = launchIdentity(spec);
  if (!identity) return { status: 'unknown', reason: 'Legacy launch has no durable ownership receipt' };
  const receipt = await readLaunchReceipt(spec);
  if (!receipt) return { status: 'unknown', reason: 'Wrapper ownership receipt is missing; launch may still be in progress' };
  if (ref?.kind === 'detached' && ref.pid !== receipt.pid
    || ref?.ownership?.processStart && ref.ownership.processStart !== receipt.processStart) return { status: 'unknown', reason: 'Host reference does not match the wrapper receipt' };
  if (ref?.ownership && (ref.ownership.launchId !== identity.launchId || ref.ownership.runId !== identity.runId || ref.ownership.attempt !== identity.attempt)) {
    return { status: 'unknown', reason: 'Host reference belongs to another attempt' };
  }
  const owned: HostRef = ref ?? { kind: 'detached', pid: receipt.pid, ownership: { ...identity, pid: receipt.pid, ...(receipt.processStart ? { processStart: receipt.processStart } : {}) } };
  const exit = await readExitEvidence(spec);
  if (exit) return { status: 'found', ref: owned, evidence: { ...identity, state: 'exited', exitCode: exit.exitCode } };
  if (!receipt.processStart || await processStartIdentity(receipt.pid) !== receipt.processStart) {
    return { status: 'unknown', reason: 'Wrapper process ownership cannot be verified and no exit receipt exists' };
  }
  return { status: 'found', ref: owned, evidence: { ...identity, state: 'running' } };
}

async function stopOwnedWrapper(ref: HostRef): Promise<void> {
  if (!ref.ownership) throw new Error('Wrapper identity is unavailable');
  const receipt = await readLaunchReceipt({ ...ref.ownership, cmd: '', args: [], cwd: '', logPath: '', exitPath: '', specPath: '' });
  if (!receipt?.processStart || await processStartIdentity(receipt.pid) !== receipt.processStart) throw new Error('Refusing to stop an unverified wrapper process');
  process.kill(receipt.pid, 'SIGTERM');
}

export type ArgvRunner = (argv: string[]) => Promise<{ stdout: string; code: number }>;

function writeSpecFile(spec: LaunchSpec): void {
  const identity = launchIdentity(spec);
  writeFileSync(spec.specPath, JSON.stringify({ cmd: spec.cmd, args: spec.args, cwd: spec.cwd, logPath: spec.logPath, exitPath: spec.exitPath, ...(identity ?? {}) }));
}

export function detachedHost(wrapperPath: string): RunHost {
  return {
    kind: 'detached',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      const identity = launchIdentity(spec);
      if (identity && await readLaunchReceipt(spec)) {
        const prior = await receiptDiscovery(spec);
        if (prior.status === 'found') return prior.ref;
        throw new Error(prior.status === 'unknown' ? prior.reason : 'Existing launch requires reconciliation');
      }
      writeSpecFile(spec);
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.JIRA_API_TOKEN;
      delete env.JIRA_EMAIL;
      const child = spawn(process.execPath, [wrapperPath, spec.specPath], { detached: true, stdio: 'ignore', env });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      const processStart = identity ? await processStartIdentity(child.pid!) : null;
      return { kind: 'detached', pid: child.pid!, ...(identity ? { ownership: { ...identity, pid: child.pid!, ...(processStart ? { processStart } : {}) } } : {}) };
    },

    discover: (spec, ref) => ref && ref.kind !== 'detached' ? Promise.resolve({ status: 'unknown', reason: 'Host reference does not belong to detached execution' }) : receiptDiscovery(spec, ref),

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'detached') return false;
      if (ref.ownership) {
        if (!ref.ownership.processStart || await processStartIdentity(ref.pid) !== ref.ownership.processStart) throw new Error('Detached process ownership is unknown');
      }
      try {
        process.kill(ref.pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'detached') return;
      if (ref.ownership && (!ref.ownership.processStart || await processStartIdentity(ref.pid) !== ref.ownership.processStart)) throw new Error('Refusing to stop an unverified process');
      try {
        process.kill(-ref.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(ref.pid, 'SIGTERM');
        } catch {}
      }
    },
  };
}

const execFileAsync = promisify(execFile);

export const defaultRun: ArgvRunner = async (argv: string[]): Promise<{ stdout: string; code: number }> => {
  const [bin, ...args] = argv;
  const { stdout } = await execFileAsync(bin!, args, { env: { ...process.env, CMUX_QUIET: '1' } });
  return { stdout, code: 0 };
};

export function parseCmuxWorkspaceRef(stdout: string): string {
  const match = stdout.match(/workspace:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`could not parse a cmux workspace ref from: ${stdout}`);
  return match[0];
}

export function cmuxHost(wrapperPath: string, run: ArgvRunner = defaultRun): RunHost {
  return {
    kind: 'cmux',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      const identity = launchIdentity(spec);
      writeSpecFile(spec);
      const quoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
      const command = identity ? `node ${quoted(wrapperPath)} ${quoted(spec.specPath)}` : `node ${wrapperPath} ${spec.specPath}`;
      const { stdout, code } = await run(['cmux', 'new-workspace', '--cwd', spec.cwd, '--focus', 'false', '--name', `run-${identity?.launchId ?? spec.runId}`, '--command', command]);
      if (code !== 0) throw new Error('cmux launch returned an error; ownership requires discovery');
      return { kind: 'cmux', workspace: parseCmuxWorkspaceRef(stdout), ...(identity ? { ownership: identity } : {}) };
    },

    async discover(spec, ref) {
      const identity = launchIdentity(spec);
      if (!identity) return { status: 'unknown', reason: 'Legacy cmux launch has no ownership identity' };
      const { stdout, code } = await run(['cmux', 'list-workspaces']);
      if (code !== 0) return { status: 'unknown', reason: 'cmux inventory is unavailable' };
      const matches = stdout.split('\n').filter(line => line.split(/\s+/).includes(`run-${identity.launchId}`));
      if (matches.length !== 1) return { status: 'unknown', reason: 'cmux launch ownership cannot be uniquely resolved' };
      const workspace = parseCmuxWorkspaceRef(matches[0]!);
      if (ref && (ref.kind !== 'cmux' || ref.workspace !== workspace)) return { status: 'unknown', reason: 'cmux workspace identity changed' };
      return receiptDiscovery(spec, { kind: 'cmux', workspace, ownership: identity });
    },

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'cmux') return false;
      try {
        const { stdout } = await run(['cmux', 'list-workspaces']);
        return stdout.includes(ref.workspace);
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'cmux') return;
      if (ref.ownership) return stopOwnedWrapper(ref);
      try {
        await run(['cmux', 'close-workspace', '--workspace', ref.workspace]);
      } catch {}
    },
  };
}

/**
 * A wezterm runner is given the socket to use, rather than resolving one
 * itself: a pane id only means anything within the mux server that owns it.
 */
export type WezRunner = (argv: string[], socket: string | null) => Promise<{ stdout: string; code: number }>;

/**
 * argv[0] is the literal 'wezterm' so the built argv stays readable and
 * assertable; the configured binary is substituted here, because on Windows the
 * installer's PATH entry is not visible to an already-running shell.
 */
export const weztermRun: WezRunner = async (argv: string[], socket: string | null) => {
  const [, ...args] = argv;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(socket ? { WEZTERM_UNIX_SOCKET: socket } : {}) };
  const { stdout } = await execFileAsync(process.env.WEZTERM_BIN || 'wezterm', args, { env });
  return { stdout, code: 0 };
};

export function parseWezPaneId(stdout: string): string {
  const match = stdout.trim().match(/^\d+$/m);
  if (!match) throw new Error(`could not parse a wezterm pane id from: ${stdout}`);
  return match[0];
}

/** Keeps run windows out of the workspace the user is looking at. */
const RUN_WORKSPACE = (): string => process.env.WEZTERM_RUN_WORKSPACE || 'helmsman-runs';

export function weztermHost(
  wrapperPath: string,
  run: WezRunner = weztermRun,
  resolve: () => string | null = resolveSocket,
): RunHost {
  /**
   * Pane ids are only unique within one mux server, and they restart from 0 in
   * a new one. Resolving the socket per operation means a second GUI started
   * mid-run could become the discovered target: stop would then kill an
   * unrelated pane that happens to reuse the id, and isAlive would call a live
   * run dead, which lets recovery remove its worktree. So the socket is
   * resolved once, at launch, and travels with the ref.
   *
   * A ref persisted before this carries no socket; fall back to discovery for
   * those rather than refusing to manage them.
   */
  const socketFor = (ref: Extract<HostRef, { kind: 'wezterm' }>): string | null =>
    ref.socket ?? resolve();

  return {
    kind: 'wezterm',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      const identity = launchIdentity(spec);
      const socket = resolve();
      if (socket === null) throw new Error('wezterm is not running');
      writeSpecFile(spec);
      // --workspace requires --new-window; together they put the run in its own
      // window on a workspace the user is not currently viewing, which is the
      // closest wezterm gets to cmux's --focus false.
      const { stdout } = await run([
        'wezterm', 'cli', 'spawn',
        '--new-window', '--workspace', RUN_WORKSPACE(),
        '--cwd', spec.cwd,
        '--', 'node', wrapperPath, spec.specPath,
      ], socket);
      return { kind: 'wezterm', paneId: parseWezPaneId(stdout), socket, ...(identity ? { ownership: identity } : {}) };
    },

    async discover(spec, ref) {
      if (!ref || ref.kind !== 'wezterm' || !ref.socket) return { status: 'unknown', reason: 'A pinned WezTerm pane and socket are required' };
      return receiptDiscovery(spec, ref);
    },

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'wezterm') return false;
      try {
        const { stdout } = await run(['wezterm', 'cli', 'list', '--format', 'json'], socketFor(ref));
        const panes = JSON.parse(stdout) as Array<{ pane_id: number }>;
        return Array.isArray(panes) && panes.some((p) => String(p.pane_id) === ref.paneId);
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'wezterm') return;
      if (ref.ownership) return stopOwnedWrapper(ref);
      try {
        await run(['wezterm', 'cli', 'kill-pane', '--pane-id', ref.paneId], socketFor(ref));
      } catch {}
    },
  };
}

/**
 * Checks the socket before shelling out: `wezterm cli` with no reachable socket
 * silently daemonizes a headless wezterm-mux-server, and probing for
 * availability must not be the thing that creates it.
 */
export const hasWezTerm = async (run: WezRunner = weztermRun): Promise<boolean> => {
  const socket = resolveSocket();
  if (socket === null) return false;
  try {
    const { code } = await run(['wezterm', 'cli', 'list', '--format', 'json'], socket);
    return code === 0;
  } catch {
    return false;
  }
};

export const hasCmux = async (run: ArgvRunner = defaultRun): Promise<boolean> => {
  try {
    const { code } = await run(['cmux', 'list-workspaces']);
    return code === 0;
  } catch {
    return false;
  }
};

export interface PickHostDeps {
  hasCmux: () => Promise<boolean>;
  hasWezTerm?: () => Promise<boolean>;
  hasDocker?: () => Promise<boolean>;
  dockerHost?: () => RunHost;
  wrapperPath: string;
  /** RUN_HOST. Anything else, or a terminal that isn't there, means detached. */
  prefer: HostRef['kind'] | null;
}

export async function pickHost(deps: PickHostDeps): Promise<RunHost> {
  if (deps.prefer === 'docker') {
    if (!deps.hasDocker || !deps.dockerHost || !await deps.hasDocker()) throw new Error('Docker execution was requested but Docker Engine is unavailable');
    return deps.dockerHost();
  }
  if (deps.prefer === 'cmux' && (await deps.hasCmux())) return cmuxHost(deps.wrapperPath);
  if (deps.prefer === 'wezterm' && (await (deps.hasWezTerm ?? hasWezTerm)())) return weztermHost(deps.wrapperPath);
  return detachedHost(deps.wrapperPath);
}
