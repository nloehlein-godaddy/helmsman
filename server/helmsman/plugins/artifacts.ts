import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { isPluginAssetPath, parsePluginPackage, type PluginPackage } from '../../../src/plugins/package';

const MAX_FILES = 128;
const MAX_DECODED = 10 * 1024 * 1024;
const MAX_SERIALIZED = 15 * 1024 * 1024;

export interface PluginArchive {
  readonly package: PluginPackage;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly hash: string;
  readonly bytes: Buffer;
}

export class PluginArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginArtifactError';
  }
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new PluginArtifactError(`${label} contains missing or unsupported fields.`);
  }
  return value as Record<string, unknown>;
}

function json(bytes: Uint8Array | string): unknown {
  if ((typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength) > MAX_SERIALIZED) {
    throw new PluginArtifactError('Plugin archive exceeds the serialized size limit.');
  }
  try {
    return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new PluginArtifactError('Plugin archive must contain valid UTF-8 JSON.'); }
}

export function parsePluginArchive(bytes: Uint8Array | string): PluginArchive {
  const archive = record(json(bytes), ['format', 'version', 'package', 'files'], 'Archive');
  if (archive.format !== 'helmsman-plugin' || archive.version !== 1) throw new PluginArtifactError('Unsupported plugin archive format.');
  const descriptor = parsePluginPackage(archive.package);
  if (!Array.isArray(archive.files) || archive.files.length > MAX_FILES) throw new PluginArtifactError('Plugin archive may contain at most 128 files.');
  const files = new Map<string, Uint8Array>();
  let size = 0;
  for (const input of archive.files) {
    const file = record(input, ['path', 'base64'], 'Archive file');
    if (!isPluginAssetPath(file.path) || files.has(file.path)) throw new PluginArtifactError('Archive file paths must be safe and unique.');
    if (typeof file.base64 !== 'string' || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) {
      throw new PluginArtifactError('Archive file must contain canonical base64.');
    }
    const content = Buffer.from(file.base64, 'base64');
    if (content.toString('base64') !== file.base64) throw new PluginArtifactError('Archive file must contain canonical base64.');
    size += content.byteLength;
    if (size > MAX_DECODED) throw new PluginArtifactError('Plugin archive exceeds the decoded size limit.');
    files.set(file.path, content);
  }
  for (const entry of [...Object.values(descriptor.entries), ...(descriptor.backend ? [descriptor.backend.entry] : [])]) {
    if (!files.has(entry)) throw new PluginArtifactError(`Missing page entry: ${entry}`);
  }
  const sorted = [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonical = Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor,
    files: sorted.map(([path, content]) => ({ path, base64: Buffer.from(content).toString('base64') })) }));
  if (canonical.byteLength > MAX_SERIALIZED) throw new PluginArtifactError('Plugin archive exceeds the serialized size limit.');
  return Object.freeze({ package: descriptor, files: new Map(sorted),
    hash: createHash('sha256').update(canonical).digest('hex'), bytes: canonical });
}

async function assertAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = absolute;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PluginArtifactError('Plugin paths must use real directories without symlinks.');
    if (current === root) return;
    current = dirname(current);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try { await assertAncestors(path); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    await ensureDirectory(dirname(path));
    try { await mkdir(path); }
    catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST')) throw cause;
    }
    await assertAncestors(path);
  }
}

async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  await assertAncestors(dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new PluginArtifactError('Plugin files must be regular files without symlinks.');
  if (info.size > limit) throw new PluginArtifactError('Plugin file exceeds the size limit.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || actual.size > limit) {
      throw new PluginArtifactError('Plugin file changed while being read.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new PluginArtifactError('Plugin file exceeds the size limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}

export async function packPluginDirectory(directory: string): Promise<PluginArchive> {
  const root = resolve(directory);
  await assertAncestors(root);
  const descriptor = parsePluginPackage(json(await readRegularFile(join(root, 'plugin-package.json'), MAX_SERIALIZED)));
  const files: { path: string; base64: string }[] = [];
  let size = 0;
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative);
    await assertAncestors(path);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const asset = relative ? `${relative}/${entry.name}` : entry.name;
      if (asset === 'plugin-package.json') continue;
      if (!isPluginAssetPath(asset)) throw new PluginArtifactError('Plugin directory contains an unsafe asset path.');
      if (entry.isDirectory()) { await walk(asset); continue; }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new PluginArtifactError('Plugin directory contains a symlink or special file.');
      if (files.length >= MAX_FILES) throw new PluginArtifactError('Plugin archive may contain at most 128 files.');
      const content = await readRegularFile(join(root, asset), MAX_DECODED - size);
      size += content.byteLength;
      files.push({ path: asset, base64: content.toString('base64') });
    }
  }
  await walk('');
  return parsePluginArchive(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor, files }));
}

function validHash(hash: string): void {
  if (typeof hash !== 'string' || hash.length !== 64 || !/^[a-f0-9]{64}$/.test(hash)) throw new PluginArtifactError('Invalid plugin artifact hash.');
}

export async function readPluginArtifact(root: string, hash: string): Promise<PluginArchive> {
  validHash(hash);
  const bytes = await readRegularFile(join(resolve(root), 'artifacts', `${hash}.json`), MAX_SERIALIZED);
  const archive = parsePluginArchive(bytes);
  if (archive.hash !== hash || !archive.bytes.equals(bytes)) throw new PluginArtifactError('Plugin artifact integrity check failed.');
  return archive;
}

export async function readPluginArchiveFile(path: string): Promise<PluginArchive> {
  return parsePluginArchive(await readRegularFile(resolve(path), MAX_SERIALIZED));
}

export async function installPluginArtifact(root: string, archiveBytes: Uint8Array): Promise<PluginArchive> {
  const archive = parsePluginArchive(archiveBytes);
  const directory = join(resolve(root), 'artifacts');
  await ensureDirectory(directory);
  const temporary = join(directory, `.stage-${randomUUID()}`);
  const destination = join(directory, `${archive.hash}.json`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(archive.bytes);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, destination); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    return await readPluginArtifact(root, archive.hash);
  } finally { await unlink(temporary); }
}
