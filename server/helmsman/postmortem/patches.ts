import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { protocolRecord } from '../agent-protocol';

export type PatchRepo = 'helmsman' | 'target';
export interface PostmortemPatch {
  file: string; path: string; number: number; repo: PatchRepo; baseSha: string | null; summary: string; valid: boolean; reason: string | null; applyCommand: string | null;
}
export const PATCH_SIZE_LIMIT = 1_048_576;
export const PATCH_COUNT_LIMIT = 100;
const PATCH_NAME = /^([1-9]\d{0,5})-(helmsman|target)\.patch$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const SIDECAR_LIMIT = 16_384;
const execute = promisify(execFile);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export async function validatePatch(repoPath: string, baseSha: string, patchPath: string, git = 'git'): Promise<string | null> {
  try { await execute(git, ['-C', repoPath, 'cat-file', '-e', `${baseSha}^{commit}`], { timeout: 10_000 }); }
  catch { return 'base not found'; }
  const index = await mkdtemp(join(tmpdir(), 'hm-pm-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(index, 'index') };
  try {
    await execute(git, ['-C', repoPath, 'read-tree', baseSha], { env, timeout: 10_000 });
    await execute(git, ['-C', repoPath, 'apply', '--check', '--cached', patchPath], { env, timeout: 10_000 });
    return null;
  } catch (error) {
    const detail = String((error as { stderr?: unknown })?.stderr ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? 'patch does not apply';
    return `does not apply: ${detail.slice(0, 200)}`;
  } finally { await rm(index, { recursive: true, force: true }); }
}

async function sidecar(path: string, repo: PatchRepo): Promise<{ baseSha: string; summary: string } | 'missing' | 'invalid'> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 'missing';
  if (!info.isFile() || info.size > SIDECAR_LIMIT) return 'invalid';
  let value: Record<string, unknown> | undefined;
  try { value = protocolRecord(JSON.parse(await readFile(path, 'utf8'))); } catch { return 'invalid'; }
  if (!value || value.repo !== repo || typeof value.baseSha !== 'string' || !SHA.test(value.baseSha) || typeof value.summary !== 'string' || value.summary.length > 500) return 'invalid';
  return { baseSha: value.baseSha, summary: value.summary };
}

export async function listPatches(directory: string, repos: Record<PatchRepo, string | null>, git = 'git'): Promise<PostmortemPatch[]> {
  const folder = join(directory, 'patches');
  let names: string[];
  try { names = await readdir(folder); } catch { return []; }
  const candidates = names.flatMap(name => { const match = name.match(PATCH_NAME); return match ? [{ name, number: Number(match[1]), repo: match[2] as PatchRepo }] : []; })
    .sort((a, b) => a.number - b.number || a.repo.localeCompare(b.repo)).slice(0, PATCH_COUNT_LIMIT);
  const patches: PostmortemPatch[] = [];
  for (const { name, number, repo } of candidates) {
    const path = join(folder, name); const repoPath = repos[repo];
    const base = { file: name, path, number, repo, baseSha: null, summary: '', applyCommand: repoPath ? `git -C ${shellQuote(repoPath)} apply ${shellQuote(path)}` : null };
    const invalid = (reason: string, extra: Partial<PostmortemPatch> = {}): PostmortemPatch => ({ ...base, ...extra, valid: false, reason });
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) { patches.push(invalid('not a regular file')); continue; }
    if (info.size > PATCH_SIZE_LIMIT) { patches.push(invalid('patch too large')); continue; }
    const meta = await sidecar(path.replace(/\.patch$/, '.json'), repo);
    if (meta === 'missing') { patches.push(invalid('missing sidecar')); continue; }
    if (meta === 'invalid') { patches.push(invalid('invalid sidecar')); continue; }
    if (!repoPath) { patches.push(invalid('repository not available', meta)); continue; }
    const reason = await validatePatch(repoPath, meta.baseSha, path, git);
    patches.push({ ...base, ...meta, valid: reason === null, reason });
  }
  return patches;
}
