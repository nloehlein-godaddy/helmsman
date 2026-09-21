import { init, parse } from 'es-module-lexer';
import { posix } from 'node:path';
import { isBuiltin } from 'node:module';
import type { PluginArchive } from './artifacts';

export async function validatePluginImports(archive: PluginArchive): Promise<void> {
  await init;
  const graph = new Map<string, string[]>();
  const builtins = new Set<string>();
  for (const [path, bytes] of archive.files) {
    if (!/\.m?js$/.test(path)) continue;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const [imports] = parse(source, path);
    const targets: string[] = [];
    for (const entry of imports) {
      if (entry.d === -2) continue;
      const name = entry.n;
      if (name?.startsWith('node:') && isBuiltin(name)) { builtins.add(path); continue; }
      if (!name || !/^\.\.?\//.test(name) || /[\\%?#]/.test(name)) {
        throw new Error(`${path}: bundle dependencies; only literal relative JavaScript imports are supported.`);
      }
      const target = posix.normalize(posix.join(posix.dirname(path), name));
      if (target.startsWith('../') || !/\.m?js$/.test(target) || !archive.files.has(target)) {
        throw new Error(`${path}: imported module is outside the package or missing: ${name}`);
      }
      targets.push(target);
    }
    graph.set(path, targets);
  }
  const reachable = (entries: string[]) => {
    const visited = new Set(entries);
    for (const path of visited) for (const target of graph.get(path) ?? []) visited.add(target);
    return visited;
  };
  const browser = reachable([...Object.values(archive.package.entries), ...Object.values(archive.package.panelEntries ?? {})]);
  const backend = reachable(archive.package.backend ? [archive.package.backend.entry] : []);
  for (const path of builtins) if (!backend.has(path) || browser.has(path)) throw new Error(`${path}: Node built-ins are restricted to backend modules.`);
  if (archive.package.backend) {
    for (const [path, bytes] of archive.files) {
      if (posix.basename(path) !== 'package.json') continue;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'module') throw new Error('Backend package.json files must declare type module.');
    }
  }
}
