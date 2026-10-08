import { spawnSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', root], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const panel = new URL('./dist/panel.js', import.meta.url);
const output = await readFile(panel, 'utf8');
const bundled = output.replace(/from ['"]@helmsman\/plugin-sdk['"]/g, "from './loading-wheel.js'");
if (bundled === output) throw new Error('Loading wheel import was not bundled.');
await writeFile(panel, bundled);
await copyFile(new URL('./loading-wheel.js', import.meta.resolve('@helmsman/plugin-sdk')), new URL('./dist/loading-wheel.js', import.meta.url));
for (const asset of ['phosphor-regular.woff2', 'phosphor-LICENSE.txt']) await copyFile(new URL(asset, import.meta.url), new URL(`./dist/${asset}`, import.meta.url));
await copyFile(new URL('./plugin-package.json', import.meta.url), new URL('./dist/plugin-package.json', import.meta.url));
