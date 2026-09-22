import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginArchive } from './artifacts';
import { assertPluginNodeCompatibility } from './compatibility';

interface Materialization {
  directory: string;
  references: number;
  materialized: boolean;
  pending: Promise<void>;
}
const processIdentity = randomUUID();
const materializations = new Map<string, Materialization>();

export async function materializePluginBackend(root: string, archive: PluginArchive): Promise<{ href: string; dispose(): Promise<void> }> {
  if (!archive.package.backend) throw new Error('Plugin has no backend entry');
  assertPluginNodeCompatibility(archive.package);
  // Node retains ESM URLs after disposal, so rematerializing identical code must reuse its URL.
  const directory = join(resolve(root), 'runtime', `${archive.hash}-${processIdentity}`);
  let entry = materializations.get(directory);
  if (!entry) {
    entry = { directory, references: 0, materialized: false, pending: Promise.resolve() };
    materializations.set(directory, entry);
  }
  const current = entry;
  current.references++;
  let disposal: Promise<void> | undefined;
  function dispose(): Promise<void> {
    return disposal ??= (() => {
      current.references--;
      const removal = current.pending.then(async () => {
        if (current.references) return;
        current.materialized = false;
        await rm(current.directory, { recursive: true, force: true });
      });
      current.pending = removal.catch(() => {});
      return removal;
    })();
  }
  const ready = current.pending.then(async () => {
    if (current.materialized) return;
    await mkdir(dirname(directory), { recursive: true });
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    try {
      for (const [path, bytes] of archive.files) {
        const target = join(directory, path); await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      if (!archive.files.has('package.json')) await writeFile(join(directory, 'package.json'), '{"type":"module"}', { flag: 'wx', mode: 0o600 });
      current.materialized = true;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  });
  current.pending = ready.catch(() => {});
  try {
    await ready;
    return { href: pathToFileURL(join(directory, archive.package.backend.entry)).href, dispose };
  } catch (error) { await dispose(); throw error; }
}
