import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ArtifactBinding } from './execution-store';
import { persistenceHash, PersistenceValidationError, stableJson } from './persistence';

const MARKER = '.helmsman-runtime.json';
const HASH = /^[a-f\d]{64}$/;
const PACKAGE = /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i;
const omittedDirectories = new Set(['.git', '.cache', '.helmsman', 'node_modules', 'test', 'tests', '__tests__', '__snapshots__', 'test-support', 'coverage']);
const secretOrState = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.DS_Store|id_(?:rsa|ed25519)|credentials(?:\.json)?|.*\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|p12))$/i;
const ignoredSource = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.d\.ts)$/;

interface RuntimeFile { path: string; size: number; sha256: string; executable: boolean }
interface RuntimeManifest {
  version: 1;
  applicationVersion: string;
  mode: 'source' | 'compiled';
  platform: string;
  arch: string;
  nodeMajor: number;
  nodeAbi: string;
  files: readonly RuntimeFile[];
}
export interface RetainedLegacyRuntime { artifact: ArtifactBinding; root: string; mode: RuntimeManifest['mode']; entry: string }

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
async function regularDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PersistenceValidationError('Runtime artifacts require real directories');
}
function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.includes('\\')
    && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
function packageObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistenceValidationError('Invalid runtime package metadata');
  return value as Record<string, unknown>;
}
function dependencies(value: unknown): string[] {
  if (value === undefined) return [];
  const names = Object.keys(packageObject(value));
  if (names.some(name => !PACKAGE.test(name))) throw new PersistenceValidationError('Invalid runtime dependency name');
  return names.sort();
}
function summary(root: string, hash: string, manifest: RuntimeManifest): RetainedLegacyRuntime {
  return { root, mode: manifest.mode, entry: join(root, 'server', 'helmsman', manifest.mode === 'source' ? 'main.ts' : 'main.js'),
    artifact: { pluginId: 'helmsman.legacy-runtime', artifactHash: hash, packageVersion: manifest.applicationVersion, requires: [] } };
}

async function inventory(root: string): Promise<RuntimeFile[]> {
  const result: RuntimeFile[] = [];
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const local = relative(root, path).split(sep).join('/');
      if (local === MARKER) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new PersistenceValidationError('Runtime artifact contains a symlink or special file');
      if (stat.isDirectory()) await walk(path);
      else result.push({ path: local, size: stat.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), executable: (stat.mode & 0o111) !== 0 });
    }
  }
  await regularDirectory(root); await walk(root);
  return result;
}

export async function verifyLegacyRuntime(artifactRoot: string, hash: string): Promise<RetainedLegacyRuntime | null> {
  if (!HASH.test(hash)) throw new PersistenceValidationError('Invalid retained runtime hash');
  const destination = join(resolve(artifactRoot), hash);
  try {
    await regularDirectory(resolve(artifactRoot)); await regularDirectory(destination);
    const marker = join(destination, MARKER);
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000) return null;
    const value = packageObject(JSON.parse(await readFile(marker, 'utf8')));
    if (value.version !== 1 || typeof value.applicationVersion !== 'string' || !value.applicationVersion
      || !['source', 'compiled'].includes(String(value.mode)) || value.platform !== process.platform || value.arch !== process.arch
      || value.nodeMajor !== Number(process.versions.node.split('.')[0]) || value.nodeAbi !== process.versions.modules || !Array.isArray(value.files)) return null;
    const files = value.files as unknown[];
    if (files.length > 100_000 || files.some(item => {
      if (!item || typeof item !== 'object') return true;
      const file = item as RuntimeFile;
      return !localPath(file.path) || file.path === MARKER || !Number.isSafeInteger(file.size) || file.size < 0 || !HASH.test(file.sha256) || typeof file.executable !== 'boolean';
    })) return null;
    const manifest = value as unknown as RuntimeManifest;
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || persistenceHash(manifest) !== hash) return null;
    if (stableJson(await inventory(destination)) !== stableJson(manifest.files)) return null;
    const retained = summary(destination, hash, manifest);
    if (!await exists(retained.entry) || !await exists(join(destination, 'package.json'))) return null;
    return retained;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || error instanceof PersistenceValidationError || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function retainLegacyRuntime(root: string, artifactRoot: string): Promise<RetainedLegacyRuntime> {
  const source = resolve(root);
  const retainedRoot = resolve(artifactRoot);
  await regularDirectory(source);
  const localArtifactRoot = relative(source, retainedRoot).split(sep)[0];
  if (source === retainedRoot || localArtifactRoot && ['server', 'src', 'docker', 'scripts', 'node_modules'].includes(localArtifactRoot)) throw new PersistenceValidationError('Runtime artifact directory conflicts with source');
  await mkdir(retainedRoot, { recursive: true, mode: 0o700 }); await regularDirectory(retainedRoot);
  const staging = join(retainedRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const packageJson = packageObject(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
    if (typeof packageJson.version !== 'string' || !packageJson.version || packageJson.type !== 'module') throw new PersistenceValidationError('Runtime package version and module type are required');
    const mode = await exists(join(source, 'server', 'helmsman', 'main.ts')) ? 'source' : 'compiled';
    if (!await exists(join(source, 'server', 'helmsman', mode === 'source' ? 'main.ts' : 'main.js'))) throw new PersistenceValidationError('Runtime entry is missing');
    const sources = new Map<string, { digest: string; executable: boolean }>();
    async function copyFile(from: string, to: string): Promise<void> {
      const stat = await lstat(from);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new PersistenceValidationError('Runtime source contains a symlink or special file');
      const bytes = await readFile(from);
      sources.set(from, { digest: createHash('sha256').update(bytes).digest('hex'), executable: (stat.mode & 0o111) !== 0 });
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await writeFile(to, bytes, { mode: stat.mode & 0o111 ? 0o700 : 0o600 });
    }
    async function copyTree(from: string, to: string, sourceCode = false): Promise<void> {
      await regularDirectory(from);
      for (const name of (await readdir(from)).sort()) {
        if (omittedDirectories.has(name) || secretOrState.test(name) || sourceCode && ignoredSource.test(name)) continue;
        const path = join(from, name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new PersistenceValidationError('Runtime source contains an unretained symlink');
        if (stat.isDirectory()) await copyTree(path, join(to, name), sourceCode);
        else await copyFile(path, join(to, name));
      }
    }
    for (const directory of ['server', 'src', 'docker']) if (await exists(join(source, directory))) await copyTree(join(source, directory), join(staging, directory), true);
    for (const name of ['cmux-codex-cost.mjs', 'install-cmux-codex-cost.mjs']) if (await exists(join(source, 'scripts', name))) await copyFile(join(source, 'scripts', name), join(staging, 'scripts', name));
    await copyFile(join(source, 'package.json'), join(staging, 'package.json'));
    if (mode === 'source' && await exists(join(source, 'tsconfig.json'))) await copyFile(join(source, 'tsconfig.json'), join(staging, 'tsconfig.json'));
    const copied = new Map<string, string>();
    async function copyPackage(name: string, from: string, destination: string, ancestors = new Map<string, string>()): Promise<void> {
      const resolver = createRequire(join(from, 'package.json'));
      let packageRoot: string;
      try { packageRoot = dirname(resolver.resolve(`${name}/package.json`)); }
      catch {
        packageRoot = dirname(resolver.resolve(name));
        while (packageRoot !== dirname(packageRoot)) {
          if (await exists(join(packageRoot, 'package.json'))) {
            const candidate = packageObject(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
            if (candidate.name === name) break;
          }
          packageRoot = dirname(packageRoot);
        }
      }
      const metadata = packageObject(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
      if (metadata.name !== name) throw new PersistenceValidationError(`Cannot resolve runtime dependency ${name}`);
      if (ancestors.get(name) === packageRoot) return;
      const target = join(destination, name);
      if (copied.get(target) === packageRoot) return;
      if (copied.has(target)) throw new PersistenceValidationError(`Conflicting retained runtime dependency ${name}`);
      copied.set(target, packageRoot);
      await copyTree(packageRoot, target);
      const next = new Map(ancestors).set(name, packageRoot);
      const optional = new Set(dependencies(metadata.optionalDependencies));
      for (const dependency of dependencies(metadata.dependencies)) if (!optional.has(dependency)) await copyPackage(dependency, packageRoot, join(target, 'node_modules'), next);
      const peerMetadata = metadata.peerDependenciesMeta === undefined ? {} : packageObject(metadata.peerDependenciesMeta);
      for (const dependency of dependencies(metadata.peerDependencies)) {
        const meta = peerMetadata[dependency];
        const isOptional = !!meta && typeof meta === 'object' && 'optional' in meta && meta.optional === true;
        try { await copyPackage(dependency, packageRoot, join(target, 'node_modules'), next); }
        catch (error) { if (!isOptional || errorCode(error) !== 'MODULE_NOT_FOUND') throw error; }
      }
      for (const dependency of optional) {
        try { await copyPackage(dependency, packageRoot, join(target, 'node_modules'), next); }
        catch (error) { if (errorCode(error) !== 'MODULE_NOT_FOUND') throw error; }
      }
    }
    const required = new Set(dependencies(packageJson.dependencies));
    if (mode === 'source') required.add('tsx');
    for (const name of [...required].sort()) await copyPackage(name, source, join(staging, 'node_modules'));
    for (const [path, initial] of sources) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || createHash('sha256').update(await readFile(path)).digest('hex') !== initial.digest || ((stat.mode & 0o111) !== 0) !== initial.executable) throw new PersistenceValidationError('Runtime source changed during retention');
    }
    const manifest: RuntimeManifest = { version: 1, applicationVersion: packageJson.version, mode, platform: process.platform, arch: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]), nodeAbi: process.versions.modules, files: await inventory(staging) };
    const hash = persistenceHash(manifest);
    await writeFile(join(staging, MARKER), stableJson(manifest), { mode: 0o600 });
    const destination = join(retainedRoot, hash);
    if (await exists(destination)) {
      const prior = await verifyLegacyRuntime(retainedRoot, hash);
      if (!prior) throw new PersistenceValidationError('Existing retained runtime artifact is corrupted');
      await rm(staging, { recursive: true, force: true });
      return prior;
    }
    try { await rename(staging, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
      const prior = await verifyLegacyRuntime(retainedRoot, hash);
      if (!prior) throw new PersistenceValidationError('Concurrent runtime artifact installation is corrupted');
      await rm(staging, { recursive: true, force: true });
      return prior;
    }
    await chmod(destination, 0o700);
    const verified = await verifyLegacyRuntime(retainedRoot, hash);
    if (!verified) throw new PersistenceValidationError('Retained runtime artifact verification failed');
    return verified;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
