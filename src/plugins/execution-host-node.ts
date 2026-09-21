import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionHostIdentityV1, ExecutionHostLaunchSpecV1 } from './execution-host';

const exec = promisify(execFile);
const RECEIPT_BYTES = 64 * 1024;

export interface ExecutionHostLaunchReceiptV1 extends ExecutionHostIdentityV1 {
  readonly version: 1;
  readonly pid: number;
  readonly processStart: string | null;
}

export interface ExecutionHostExitReceiptV1 extends ExecutionHostLaunchReceiptV1 {
  readonly exitCode: number;
}

function validIdentity(identity: ExecutionHostIdentityV1): boolean {
  return /^[a-z\d_-]{1,128}$/i.test(identity.runId)
    && /^[a-z\d_-]{1,128}$/i.test(identity.launchId)
    && Number.isSafeInteger(identity.attempt)
    && identity.attempt > 0
    && typeof identity.receiptPath === 'string'
    && identity.receiptPath.length > 0
    && identity.receiptPath.length <= 4096
    && isAbsolute(identity.receiptPath);
}

function sameIdentity(left: ExecutionHostIdentityV1, right: ExecutionHostIdentityV1): boolean {
  return left.runId === right.runId
    && left.launchId === right.launchId
    && left.attempt === right.attempt
    && left.receiptPath === right.receiptPath;
}

export async function executionHostProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return started && /^\d+$/.test(started) ? `linux:${boot.trim()}:${started}` : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 5000,
      });
      return stdout.trim() ? `darwin:${stdout.trim()}` : null;
    }
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { timeout: 5000 });
      return /^\d+$/.test(stdout.trim()) ? `win32:${stdout.trim()}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

interface ParsedExecutionHostReceipt {
  readonly receipt: ExecutionHostLaunchReceiptV1;
  readonly row: Readonly<Record<string, unknown>>;
}

async function readReceipt(path: string, identity: ExecutionHostIdentityV1): Promise<ParsedExecutionHostReceipt | null> {
  if (!validIdentity(identity)) throw new TypeError('Invalid execution host identity');
  let text: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const bytes = Buffer.alloc(RECEIPT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > RECEIPT_BYTES) throw new Error('Execution host receipt exceeds the size limit');
    text = bytes.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid execution host receipt');
  const row = value as Record<string, unknown>;
  if (row.version !== 1
    || row.runId !== identity.runId
    || row.launchId !== identity.launchId
    || row.attempt !== identity.attempt
    || !Number.isSafeInteger(row.pid)
    || Number(row.pid) < 1
    || row.processStart !== null && (typeof row.processStart !== 'string' || row.processStart.length === 0)) {
    throw new Error('Execution host receipt does not match this attempt');
  }
  const receipt = Object.freeze({
    version: 1,
    runId: identity.runId,
    launchId: identity.launchId,
    attempt: identity.attempt,
    receiptPath: identity.receiptPath,
    pid: Number(row.pid),
    processStart: row.processStart as string | null,
  });
  return { receipt, row };
}

export function isExecutionHostIdentityMatch(left: ExecutionHostIdentityV1, right: ExecutionHostIdentityV1): boolean {
  return validIdentity(left) && validIdentity(right) && sameIdentity(left, right);
}

export async function readExecutionHostLaunchReceipt(identity: ExecutionHostIdentityV1): Promise<ExecutionHostLaunchReceiptV1 | null> {
  return (await readReceipt(identity.receiptPath, identity))?.receipt ?? null;
}

export async function readExecutionHostExitReceipt(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostExitReceiptV1 | null> {
  const evidence = await readReceipt(spec.exitPath, spec);
  if (!evidence) return null;
  const { receipt, row } = evidence;
  const exitCode = row.exitCode;
  if (!Number.isSafeInteger(exitCode) || Number(exitCode) < 0 || Number(exitCode) > 255) {
    throw new Error('Invalid execution host exit code');
  }
  const launch = await readExecutionHostLaunchReceipt(spec);
  if (!launch || launch.pid !== receipt.pid || launch.processStart !== receipt.processStart) {
    throw new Error('Execution host exit receipt has no matching launch receipt');
  }
  return Object.freeze({ ...receipt, exitCode: Number(exitCode) });
}

export async function isExecutionHostProcessOwned(pid: number, processStart: string | null): Promise<boolean> {
  return typeof processStart === 'string'
    && processStart.length > 0
    && await executionHostProcessStartIdentity(pid) === processStart;
}
