import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { LaunchSpec } from './run-host';

const exec = promisify(execFile);
export interface LaunchIdentity { launchId: string; runId: string; attempt: number; receiptPath: string; }
export interface LaunchReceipt extends LaunchIdentity { version: 1; pid: number; processStart: string | null; }
export interface ProcessExitEvidence extends LaunchReceipt { exitCode: number; }

export function launchIdentity(spec: LaunchSpec): LaunchIdentity | null {
  if (spec.launchId === undefined && spec.attempt === undefined && spec.receiptPath === undefined) return null;
  if (typeof spec.launchId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(spec.launchId)
    || !/^[a-z\d_-]{1,128}$/i.test(spec.runId) || !Number.isSafeInteger(spec.attempt) || Number(spec.attempt) < 1
    || spec.receiptPath !== undefined && (typeof spec.receiptPath !== 'string' || !spec.receiptPath)) throw new Error('Invalid durable launch identity');
  return { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt!, receiptPath: spec.receiptPath ?? `${spec.specPath}.receipt` };
}

export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return started && /^\d+$/.test(started) ? `linux:${boot.trim()}:${started}` : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
      return stdout.trim() ? `darwin:${stdout.trim()}` : null;
    }
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { timeout: 5000 });
      return /^\d+$/.test(stdout.trim()) ? `win32:${stdout.trim()}` : null;
    }
  } catch { return null; }
  return null;
}

async function readEvidence(path: string, identity: LaunchIdentity): Promise<LaunchReceipt | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid launch evidence');
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.launchId !== identity.launchId || row.runId !== identity.runId || row.attempt !== identity.attempt
    || !Number.isSafeInteger(row.pid) || Number(row.pid) < 1 || row.processStart !== null && (typeof row.processStart !== 'string' || !row.processStart)) {
    throw new Error('Launch evidence does not match this attempt');
  }
  return { ...row, ...identity } as unknown as LaunchReceipt;
}

export async function readLaunchReceipt(spec: LaunchSpec): Promise<LaunchReceipt | null> {
  const identity = launchIdentity(spec);
  return identity ? readEvidence(identity.receiptPath, identity) : null;
}

export async function readExitEvidence(spec: LaunchSpec): Promise<ProcessExitEvidence | null> {
  const identity = launchIdentity(spec);
  if (!identity) return null;
  const value = await readEvidence(spec.exitPath, identity) as ProcessExitEvidence | null;
  if (!value) return null;
  if (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) throw new Error('Invalid attempt exit code');
  const receipt = await readLaunchReceipt(spec);
  if (!receipt || receipt.pid !== value.pid || receipt.processStart !== value.processStart) throw new Error('Exit evidence has no matching ownership receipt');
  return value;
}
