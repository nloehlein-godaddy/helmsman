import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import type { RunRow } from './db';

export type LegacyTerminalProcessProof =
  | { inactive: true; kind: 'detached-exited' | 'historical-no-runtime'; pid: number | null; exitCode: number | null }
  | { inactive: false; reason: string };

export interface LegacyProcessProofDependencies {
  probePid(pid: number): void;
  readExit(path: string): Promise<string>;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const path = (value: unknown): value is string => text(value) && isAbsolute(value) && normalize(value) === value;
const blocked = (reason: string): LegacyTerminalProcessProof => ({ inactive: false, reason });

async function readExit(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128) throw new Error('Invalid legacy exit evidence');
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128) throw new Error('Invalid legacy exit evidence');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export async function proveLegacyTerminalProcessInactive(row: RunRow, dependencies: Partial<LegacyProcessProofDependencies> = {}): Promise<LegacyTerminalProcessProof> {
  if (!row || !['succeeded', 'failed', 'stopped'].includes(row.status) || !text(row.endedAt) || !Number.isFinite(Date.parse(row.endedAt))) {
    return blocked('Legacy run has no valid terminal record');
  }
  if (row.hostRef == null && row.hostKind == null && row.taskJson == null
    && row.logPath == null && row.exitPath == null && row.specPath == null && row.logOffset == null && row.launchJson == null) {
    return { inactive: true, kind: 'historical-no-runtime', pid: null, exitCode: null };
  }
  if (!text(row.hostRef) || typeof row.taskJson !== 'string' || !row.taskJson.length || Buffer.byteLength(row.taskJson, 'utf8') > 1024 * 1024 || row.hostKind !== 'detached'
    || [row.logPath, row.exitPath, row.specPath].some(value => value != null && !path(value))) {
    return blocked('Legacy runtime metadata is incomplete or unsupported');
  }
  let host: unknown;
  let task: unknown;
  try { host = JSON.parse(row.hostRef); task = JSON.parse(row.taskJson); }
  catch { return blocked('Legacy runtime metadata is malformed'); }
  if (!object(host) || host.kind !== 'detached' || !Number.isSafeInteger(host.pid) || Number(host.pid) < 1
    || Object.keys(host).some(key => key !== 'kind' && key !== 'pid')) return blocked('Legacy detached host reference is invalid');
  if (!object(task) || task.repo !== row.repo || task.ticketId !== row.ticketId || !text(task.title) || typeof task.jiraBaseUrl !== 'string'
    || task.todoId !== undefined && !text(task.todoId) || task.task !== undefined && !text(task.task)
    || task.review !== undefined && typeof task.review !== 'boolean'
    || task.prNumber !== undefined && (!Number.isSafeInteger(task.prNumber) || Number(task.prNumber) < 1)
    || task.review === true && (!Number.isSafeInteger(task.prNumber) || !text(task.prBranch))
    || ['executionHost', 'hostIsolation', 'dockerExecution'].some(key => Object.hasOwn(task, key))) {
    return blocked('Legacy task metadata is invalid or uses an isolated or plugin host');
  }
  const pid = Number(host.pid);
  try { (dependencies.probePid ?? (value => { process.kill(value, 0); }))(pid); return blocked('Legacy process remains present'); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') return blocked('Legacy process inactivity could not be verified'); }
  let exitCode: number | null = null;
  if (row.exitPath != null) {
    try {
      const value = await (dependencies.readExit ?? readExit)(row.exitPath);
      if (typeof value !== 'string' || value.length > 128 || !/^\d{1,3}$/.test(value.trim())) return blocked('Legacy exit evidence is invalid');
      exitCode = Number(value.trim());
      if (exitCode > 255) return blocked('Legacy exit evidence is invalid');
    } catch { return blocked('Legacy exit evidence could not be verified'); }
  }
  return { inactive: true, kind: 'detached-exited', pid, exitCode };
}
