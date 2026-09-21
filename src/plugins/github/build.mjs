import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(root, 'dist');

async function copySdkRuntime(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await copySdkRuntime(from, to);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
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
await copySdkRuntime(dirname(sdkEntry), join(dist, 'sdk'));
await rewriteSdkImports(dist);
await copyFile(new URL('./plugin-package.json', import.meta.url), new URL('./dist/plugin-package.json', import.meta.url));
