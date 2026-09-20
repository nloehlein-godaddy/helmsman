import { init, parse } from 'es-module-lexer';
import { posix } from 'node:path';
import type { PluginArchive } from './artifacts';

export async function validatePluginImports(archive: PluginArchive): Promise<void> {
  await init;
  for (const [path, bytes] of archive.files) {
    if (!/\.m?js$/.test(path)) continue;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const [imports] = parse(source, path);
    for (const entry of imports) {
      if (entry.d === -2) continue;
      const name = entry.n;
      if (!name || !/^\.\.?\//.test(name) || /[\\%?#]/.test(name)) {
        throw new Error(`${path}: bundle dependencies; only literal relative JavaScript imports are supported.`);
      }
      const target = posix.normalize(posix.join(posix.dirname(path), name));
      if (target.startsWith('../') || !/\.m?js$/.test(target) || !archive.files.has(target)) {
        throw new Error(`${path}: imported module is outside the package or missing: ${name}`);
      }
    }
  }
}
