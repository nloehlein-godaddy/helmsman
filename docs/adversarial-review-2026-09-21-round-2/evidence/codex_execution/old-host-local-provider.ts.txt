import { execFile, spawn } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ExecutionHostDiscoveryV1,
  ExecutionHostIdentityV1,
  ExecutionHostLaunchSpecV1,
  ExecutionHostProviderV1,
  ExecutionHostReferenceV1,
} from '@helmsman/plugin-sdk';
import {
  executionHostProcessStartIdentity,
  isExecutionHostIdentityMatch,
  isExecutionHostProcessOwned,
  readExecutionHostExitReceipt,
  readExecutionHostLaunchReceipt,
  type ExecutionHostLaunchReceiptV1,
} from '@helmsman/plugin-sdk/node';

const exec = promisify(execFile);
const detachedEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.JIRA_API_TOKEN;
  delete environment.JIRA_EMAIL;
  return environment;
};
const metadata = (label: string): ExecutionHostProviderV1['metadata'] => ({
  version: 1,
  label,
  workspace: 'worktree',
  stageExecution: 'local',
});

type DetachedState = { readonly kind: 'detached'; readonly pid: number; readonly processStart: string };
type CmuxState = { readonly kind: 'cmux'; readonly workspace: string; readonly pid: number; readonly processStart: string };
type WeztermState = { readonly kind: 'wezterm'; readonly paneId: string; readonly socket: string; readonly pid: number; readonly processStart: string };
type LocalState = DetachedState | CmuxState | WeztermState;
export type LocalCommandRunner = (args: readonly string[], socket?: string | null) => Promise<{ readonly stdout: string; readonly code: number }>;

function reference(identity: ExecutionHostIdentityV1, state: LocalState): ExecutionHostReferenceV1 {
  return {
    version: 1,
    identity: {
      runId: identity.runId,
      launchId: identity.launchId,
      attempt: identity.attempt,
      receiptPath: identity.receiptPath,
    },
    state,
  };
}

function objectState(ref: ExecutionHostReferenceV1): Record<string, unknown> {
  if (!ref.state || typeof ref.state !== 'object' || Array.isArray(ref.state)) throw new Error('Execution host ownership state is invalid');
  return ref.state as Record<string, unknown>;
}

function ownedState(ref: ExecutionHostReferenceV1, kind: LocalState['kind']): LocalState {
  const state = objectState(ref);
  if (state.kind !== kind
    || !Number.isSafeInteger(state.pid)
    || Number(state.pid) < 1
    || typeof state.processStart !== 'string'
    || !state.processStart) {
    throw new Error(`${kind} execution host ownership is unknown`);
  }
  if (kind === 'detached') {
    if (Object.keys(state).some(key => !['kind', 'pid', 'processStart'].includes(key))) throw new Error('Detached execution host ownership is unknown');
    return state as DetachedState;
  }
  if (kind === 'cmux') {
    if (typeof state.workspace !== 'string' || !state.workspace
      || Object.keys(state).some(key => !['kind', 'workspace', 'pid', 'processStart'].includes(key))) {
      throw new Error('cmux execution host ownership is unknown');
    }
    return state as CmuxState;
  }
  if (typeof state.paneId !== 'string' || !/^\d+$/.test(state.paneId)
    || typeof state.socket !== 'string' || !state.socket
    || Object.keys(state).some(key => !['kind', 'paneId', 'socket', 'pid', 'processStart'].includes(key))) {
    throw new Error('WezTerm execution host ownership is unknown');
  }
  return state as WeztermState;
}

function matchingRef(spec: ExecutionHostLaunchSpecV1, ref: ExecutionHostReferenceV1 | undefined): boolean {
  return ref === undefined || ref.version === 1 && isExecutionHostIdentityMatch(spec, ref.identity);
}

async function matchingReceipt(ref: ExecutionHostReferenceV1, kind: LocalState['kind']): Promise<{ state: LocalState; receipt: ExecutionHostLaunchReceiptV1 }> {
  const state = ownedState(ref, kind);
  const receipt = await readExecutionHostLaunchReceipt(ref.identity);
  if (!receipt || receipt.pid !== state.pid || receipt.processStart !== state.processStart) {
    throw new Error(`${kind} execution host ownership is unknown`);
  }
  return { state, receipt };
}

async function waitForReceipt(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostLaunchReceiptV1> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = await readExecutionHostLaunchReceipt(spec);
    if (receipt?.processStart) return receipt;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Execution wrapper did not publish verifiable ownership');
}

async function writeSpec(spec: ExecutionHostLaunchSpecV1): Promise<void> {
  await writeFile(spec.specPath, JSON.stringify({
    version: 1,
    runId: spec.runId,
    launchId: spec.launchId,
    attempt: spec.attempt,
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
    logPath: spec.logPath,
    exitPath: spec.exitPath,
    receiptPath: spec.receiptPath,
  }), { mode: 0o600 });
}

async function receiptDiscovery(
  spec: ExecutionHostLaunchSpecV1,
  ref: ExecutionHostReferenceV1 | undefined,
  makeState: (receipt: ExecutionHostLaunchReceiptV1) => LocalState,
): Promise<ExecutionHostDiscoveryV1> {
  if (!matchingRef(spec, ref)) return { status: 'unknown', reason: 'Execution host reference belongs to another attempt' };
  let receipt: ExecutionHostLaunchReceiptV1 | null;
  try {
    receipt = await readExecutionHostLaunchReceipt(spec);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Execution host receipt is invalid' };
  }
  if (!receipt?.processStart) return { status: 'unknown', reason: 'Execution wrapper ownership receipt is unavailable' };
  const owned = ref ?? reference(spec, makeState(receipt));
  let state: LocalState;
  try {
    state = ownedState(owned, makeState(receipt).kind);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Execution host state is invalid' };
  }
  if (state.pid !== receipt.pid || state.processStart !== receipt.processStart) {
    return { status: 'unknown', reason: 'Execution host reference does not match the wrapper receipt' };
  }
  try {
    const exit = await readExecutionHostExitReceipt(spec);
    if (exit) return { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } };
    if (!await isExecutionHostProcessOwned(receipt.pid, receipt.processStart)) {
      const completed = await readExecutionHostExitReceipt(spec);
      return completed
        ? { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: completed.exitCode } }
        : { status: 'unknown', reason: 'Wrapper process ownership cannot be verified and no exit receipt exists' };
    }
    return { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'running' } };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Execution host evidence is invalid' };
  }
}

async function isAlive(ref: ExecutionHostReferenceV1, kind: LocalState['kind']): Promise<boolean> {
  const { state } = await matchingReceipt(ref, kind);
  return isExecutionHostProcessOwned(state.pid, state.processStart);
}

async function stop(ref: ExecutionHostReferenceV1, kind: LocalState['kind']): Promise<void> {
  const { state } = await matchingReceipt(ref, kind);
  if (!await isExecutionHostProcessOwned(state.pid, state.processStart)) {
    throw new Error(`Refusing to stop an unverified ${kind} wrapper process`);
  }
  process.kill(state.pid, 'SIGTERM');
}

export function createDetachedExecutionHost(): ExecutionHostProviderV1 {
  return {
    metadata: metadata('Detached'),
    async prepareRun() { return null; },
    async launch(spec) {
      const prior = await readExecutionHostLaunchReceipt(spec);
      if (prior) {
        const discovered = await receiptDiscovery(spec, undefined, receipt => ({ kind: 'detached', pid: receipt.pid, processStart: receipt.processStart ?? '' }));
        if (discovered.status === 'found') return discovered.ref;
        throw new Error(discovered.status === 'unknown' ? discovered.reason : 'Existing detached launch requires reconciliation');
      }
      await writeSpec(spec);
      const child = spawn(process.execPath, [spec.wrapperPath, spec.specPath], { detached: true, stdio: 'ignore', env: detachedEnvironment() });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error('Detached execution did not return a process identity');
      const processStart = await executionHostProcessStartIdentity(pid);
      if (!processStart) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
        throw new Error('Detached execution process ownership is unavailable');
      }
      return reference(spec, { kind: 'detached', pid, processStart });
    },
    discover(spec, ref) {
      return receiptDiscovery(spec, ref, receipt => ({ kind: 'detached', pid: receipt.pid, processStart: receipt.processStart ?? '' }));
    },
    isAlive(ref) { return isAlive(ref, 'detached'); },
    stop(ref) { return stop(ref, 'detached'); },
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseCmuxWorkspace(stdout: string): string {
  const match = stdout.match(/workspace:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error('cmux did not return a workspace identity');
  return match[0];
}

export interface CmuxExecutionHostOptions {
  readonly socketPath?: string;
  readonly run?: LocalCommandRunner;
}

export function createCmuxExecutionHost(options: CmuxExecutionHostOptions = {}): ExecutionHostProviderV1 {
  const run = options.run ?? (async args => {
    const [bin = 'cmux', ...rest] = args;
    const { stdout } = await exec(bin, rest, {
      env: { ...process.env, CMUX_QUIET: '1', ...(options.socketPath ? { CMUX_SOCKET_PATH: options.socketPath } : {}) },
    });
    return { stdout, code: 0 };
  });
  return {
    metadata: metadata('cmux'),
    async prepareRun() { return null; },
    async launch(spec) {
      if (await readExecutionHostLaunchReceipt(spec)) throw new Error('Existing cmux launch requires ownership reconciliation');
      await writeSpec(spec);
      const command = `${quote(process.execPath)} ${quote(spec.wrapperPath)} ${quote(spec.specPath)}`;
      const result = await run(['cmux', 'new-workspace', '--cwd', spec.cwd, '--focus', 'false', '--name', `run-${spec.launchId}`, '--command', command]);
      if (result.code !== 0) throw new Error('cmux launch returned an error; ownership requires discovery');
      const workspace = parseCmuxWorkspace(result.stdout);
      const receipt = await waitForReceipt(spec);
      return reference(spec, { kind: 'cmux', workspace, pid: receipt.pid, processStart: receipt.processStart! });
    },
    async discover(spec, ref) {
      if (!matchingRef(spec, ref)) return { status: 'unknown', reason: 'Execution host reference belongs to another attempt' };
      let listed;
      try { listed = await run(['cmux', 'list-workspaces']); }
      catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'cmux inventory is unavailable' }; }
      if (listed.code !== 0) return { status: 'unknown', reason: 'cmux inventory is unavailable' };
      const matches = listed.stdout.split('\n').filter(line => line.split(/\s+/).includes(`run-${spec.launchId}`));
      if (matches.length > 1) return { status: 'unknown', reason: 'cmux launch ownership cannot be uniquely resolved' };
      if (matches.length === 0) {
        try {
          const receipt = await readExecutionHostLaunchReceipt(spec);
          const exit = receipt ? await readExecutionHostExitReceipt(spec) : null;
          if (ref && exit) return { status: 'found', ref, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } };
          if (receipt && await isExecutionHostProcessOwned(receipt.pid, receipt.processStart)) return { status: 'unknown', reason: 'cmux workspace is absent while its wrapper process is running' };
          return { status: 'absent', evidence: `cmux reports no workspace for run-${spec.launchId}` };
        } catch (error) {
          return { status: 'unknown', reason: error instanceof Error ? error.message : 'cmux ownership evidence is invalid' };
        }
      }
      const workspace = parseCmuxWorkspace(matches[0] ?? '');
      if (ref) {
        try { if ((ownedState(ref, 'cmux') as CmuxState).workspace !== workspace) return { status: 'unknown', reason: 'cmux workspace identity changed' }; }
        catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'cmux state is invalid' }; }
      }
      return receiptDiscovery(spec, ref, receipt => ({ kind: 'cmux', workspace, pid: receipt.pid, processStart: receipt.processStart ?? '' }));
    },
    async isAlive(ref) {
      const alive = await isAlive(ref, 'cmux');
      if (!alive) return false;
      const state = ownedState(ref, 'cmux') as CmuxState;
      const listed = await run(['cmux', 'list-workspaces']);
      if (listed.code !== 0) throw new Error('cmux ownership inventory is unavailable');
      return listed.stdout.includes(state.workspace);
    },
    stop(ref) { return stop(ref, 'cmux'); },
  };
}

async function resolveWeztermSocket(): Promise<string | null> {
  const configured = process.env.WEZTERM_UNIX_SOCKET || process.env.WEZTERM_SOCKET;
  if (configured) return configured;
  let names: string[];
  const directory = join(homedir(), '.local', 'share', 'wezterm');
  try { names = await readdir(directory); }
  catch { return null; }
  const candidates = (await Promise.all(names.flatMap(name => {
    const match = /^gui-sock-(\d+)$/.exec(name);
    if (!match) return [];
    const path = join(directory, name);
    const pid = Number(match[1]);
    return [stat(path).then(value => ({ path, pid, mtime: value.mtimeMs })).catch(() => ({ path, pid, mtime: null }))];
  }))).filter(candidate => {
    try { process.kill(candidate.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM'; }
  });
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => (right.mtime ?? right.pid) - (left.mtime ?? left.pid))[0]?.path ?? null;
}

function parseWeztermPane(stdout: string): string {
  const match = stdout.trim().match(/^\d+$/m);
  if (!match) throw new Error('WezTerm did not return a pane identity');
  return match[0];
}

export interface WeztermExecutionHostOptions {
  readonly bin?: string;
  readonly workspace?: string;
  readonly resolveSocket?: () => Promise<string | null> | string | null;
  readonly run?: LocalCommandRunner;
}

export function createWeztermExecutionHost(options: WeztermExecutionHostOptions = {}): ExecutionHostProviderV1 {
  const bin = options.bin || 'wezterm';
  const workspace = options.workspace || 'helmsman-runs';
  const socket = options.resolveSocket ?? resolveWeztermSocket;
  const run = options.run ?? (async (args, selectedSocket) => {
    const { stdout } = await exec(bin, [...args], { env: { ...process.env, ...(selectedSocket ? { WEZTERM_UNIX_SOCKET: selectedSocket } : {}) } });
    return { stdout, code: 0 };
  });
  return {
    metadata: metadata('WezTerm'),
    async prepareRun() { return null; },
    async launch(spec) {
      if (await readExecutionHostLaunchReceipt(spec)) throw new Error('Existing WezTerm launch requires ownership reconciliation');
      const selectedSocket = await socket();
      if (!selectedSocket) throw new Error('WezTerm is not running');
      await writeSpec(spec);
      const result = await run(['cli', 'spawn', '--new-window', '--workspace', workspace, '--cwd', spec.cwd, '--', process.execPath, spec.wrapperPath, spec.specPath], selectedSocket);
      if (result.code !== 0) throw new Error('WezTerm launch returned an error; ownership requires discovery');
      const paneId = parseWeztermPane(result.stdout);
      const receipt = await waitForReceipt(spec);
      return reference(spec, { kind: 'wezterm', paneId, socket: selectedSocket, pid: receipt.pid, processStart: receipt.processStart! });
    },
    async discover(spec, ref) {
      if (!ref || !matchingRef(spec, ref)) return { status: 'unknown', reason: 'A pinned WezTerm pane and socket are required' };
      let state: WeztermState;
      try { state = ownedState(ref, 'wezterm') as WeztermState; }
      catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'WezTerm state is invalid' }; }
      let listed;
      try { listed = await run(['cli', 'list', '--format', 'json'], state.socket); }
      catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'WezTerm inventory is unavailable' }; }
      if (listed.code !== 0) return { status: 'unknown', reason: 'WezTerm inventory is unavailable' };
      let present = false;
      try {
        const panes: unknown = JSON.parse(listed.stdout);
        present = Array.isArray(panes) && panes.some(pane => pane && typeof pane === 'object' && String((pane as { pane_id?: unknown }).pane_id) === state.paneId);
      } catch { return { status: 'unknown', reason: 'WezTerm returned an invalid pane inventory' }; }
      if (!present) {
        try {
          const exit = await readExecutionHostExitReceipt(spec);
          if (exit) return { status: 'found', ref, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } };
          if (await isExecutionHostProcessOwned(state.pid, state.processStart)) return { status: 'unknown', reason: 'WezTerm pane is absent while its wrapper process is running' };
          return { status: 'absent', evidence: `WezTerm reports no pane ${state.paneId} on the retained socket` };
        } catch (error) {
          return { status: 'unknown', reason: error instanceof Error ? error.message : 'WezTerm ownership evidence is invalid' };
        }
      }
      return receiptDiscovery(spec, ref, receipt => ({ kind: 'wezterm', paneId: state.paneId, socket: state.socket, pid: receipt.pid, processStart: receipt.processStart ?? '' }));
    },
    async isAlive(ref) {
      const alive = await isAlive(ref, 'wezterm');
      if (!alive) return false;
      const state = ownedState(ref, 'wezterm') as WeztermState;
      const listed = await run(['cli', 'list', '--format', 'json'], state.socket);
      if (listed.code !== 0) throw new Error('WezTerm ownership inventory is unavailable');
      const panes: unknown = JSON.parse(listed.stdout);
      if (!Array.isArray(panes)) throw new Error('WezTerm ownership inventory is invalid');
      return panes.some(pane => pane && typeof pane === 'object' && String((pane as { pane_id?: unknown }).pane_id) === state.paneId);
    },
    stop(ref) { return stop(ref, 'wezterm'); },
  };
}
