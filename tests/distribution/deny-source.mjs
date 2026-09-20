import fs from 'node:fs';
import promises from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbidden = process.env.HELMSMAN_TEST_SOURCE;
if (!forbidden) throw new Error('The source-denial test needs its checkout path.');
function check(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const path = resolve(value);
  if (path === forbidden || path.startsWith(`${forbidden}${sep}`)) throw new Error(`Source checkout is unavailable: ${path}`);
}

for (const target of [fs, promises]) {
  for (const name of ['access', 'accessSync', 'existsSync', 'readFile', 'readFileSync', 'open', 'openSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'readdir', 'readdirSync', 'realpath', 'realpathSync', 'createReadStream']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = Object.assign(function(path, ...args) { check(path); return original.call(this, path, ...args); }, original);
  }
}
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('file:')) check(new URL(specifier));
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('file:')) check(new URL(result.url));
    return result;
  },
});
