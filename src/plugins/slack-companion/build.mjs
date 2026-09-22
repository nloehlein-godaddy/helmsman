import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const dist = join(root, 'dist');

async function copySdkRuntime(entry, destination) {
  const sourceRoot = dirname(entry);
  const queued = [entry];
  const copied = new Set();
  for (const source of queued) {
    if (copied.has(source)) continue;
    copied.add(source);
    const local = relative(sourceRoot, source);
    if (!local || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local) || !source.endsWith('.js')) {
      throw new Error(`Invalid browser SDK runtime module: ${source}`);
    }
    const contents = await readFile(source, 'utf8');
    const target = join(destination, local);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    for (const imported of ts.preProcessFile(contents, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const resolved = resolve(dirname(source), imported.fileName);
      const dependency = extname(resolved) ? resolved : `${resolved}.js`;
      const dependencyLocal = relative(sourceRoot, dependency);
      if (dependencyLocal === '..' || dependencyLocal.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(dependencyLocal) || !dependency.endsWith('.js')) {
        throw new Error(`Browser SDK runtime import escapes the package: ${imported.fileName}`);
      }
      queued.push(dependency);
    }
  }
}

async function rewriteSdkImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewriteSdkImports(path);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const output = await readFile(path, 'utf8');
      const relativeSdk = relative(dirname(path), join(dist, 'sdk', 'index.js')).replaceAll('\\', '/');
      const specifier = relativeSdk.startsWith('.') ? relativeSdk : `./${relativeSdk}`;
      const rewritten = output.replaceAll("'@helmsman/plugin-sdk'", `'${specifier}'`).replaceAll('"@helmsman/plugin-sdk"', `"${specifier}"`);
      if (rewritten !== output) await writeFile(path, rewritten);
    }
  }
}

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', root], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
let sdkEntry;
try { sdkEntry = require.resolve('@helmsman/plugin-sdk'); }
catch { sdkEntry = fileURLToPath(await import.meta.resolve('@helmsman/plugin-sdk')); }
await copySdkRuntime(sdkEntry, join(dist, 'sdk'));
await rewriteSdkImports(dist);
await copyFile(new URL('./plugin-package.json', import.meta.url), new URL('./dist/plugin-package.json', import.meta.url));
