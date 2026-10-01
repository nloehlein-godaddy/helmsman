import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const held = new AsyncLocalStorage<ReadonlySet<string>>();
export function commonGitDirectory(repoDir: string): string {
  return realpathSync(execFileSync('git', ['-C', repoDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 }).trim());
}
export async function withWorktreeMaintenance<T>(repoDir: string, work: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const common = commonGitDirectory(repoDir);
  if (held.getStore()?.has(common)) return work();
  const lock = join(common, 'helmsman-maintenance.lock'); const token = randomUUID();
  const owner = JSON.stringify({ version: 1, token, pid: process.pid, commonDirectory: common });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      try {
        const entry = lstatSync(lock);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Git maintenance lock identity changed');
      } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue; throw error; }
      if (Date.now() >= deadline) throw new Error(`Git maintenance is still owned; recovery must verify the owner before clearing ${lock}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await writeFile(join(lock, 'owner.json'), owner, { flag: 'wx', mode: 0o600 });
  try { return await held.run(new Set([...(held.getStore() ?? []), common]), work); }
  finally {
    // A crashed owner leaves its lock intact; elapsed time never authorizes a new Git mutation.
    if (await readFile(join(lock, 'owner.json'), 'utf8') !== owner) throw new Error('Git maintenance owner changed; lock retained for recovery');
    await rm(lock, { recursive: true });
  }
}
