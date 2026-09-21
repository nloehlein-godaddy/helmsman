import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginArchive } from './artifacts';

export async function materializePluginBackend(root: string, archive: PluginArchive): Promise<{ href: string; dispose(): Promise<void> }> {
  if (!archive.package.backend) throw new Error('Plugin has no backend entry');
  const parent = join(root, 'runtime'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, `${archive.hash}-`));
  try {
    for (const [path, bytes] of archive.files) {
      const target = join(directory, path); await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!archive.files.has('package.json')) await writeFile(join(directory, 'package.json'), '{"type":"module"}', { flag: 'wx' });
    return { href: pathToFileURL(join(directory, archive.package.backend.entry)).href, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
