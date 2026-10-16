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
const page = new URL('./dist/page.js', import.meta.url);
const output = await readFile(page, 'utf8');
const bundled = output.replace(/from ['"]@helmsman\/plugin-sdk['"]/g, "from './agent-prompt-editor.js'");
if (bundled === output) throw new Error('Agent prompt editor import was not bundled.');
await writeFile(page, bundled);
for (const module of ['agent-prompt-editor', 'agent-prompt-editor-state', 'agent-prompt-editor-styles']) {
  await copyFile(new URL(`./${module}.js`, import.meta.resolve('@helmsman/plugin-sdk')), new URL(`./dist/${module}.js`, import.meta.url));
}
await copyFile(new URL('./plugin-package.json', import.meta.url), new URL('./dist/plugin-package.json', import.meta.url));
