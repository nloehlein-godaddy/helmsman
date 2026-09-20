import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PluginJson } from '../../src/plugins/backend';
import { assertMaintenanceAvailable, persistedJson, PersistenceConflictError, stableJson } from './persistence';

export interface PersistenceBackupInput {
  databases: { main: string; catalog: string; data: string };
  destination: string;
  metadata: PluginJson;
}

export async function backupPersistenceSet(input: PersistenceBackupInput): Promise<void> {
  const destination = resolve(input.destination);
  const paths = Object.entries(input.databases).map(([name, path]) => ({ name, path: resolve(path) }));
  if (new Set(paths.map(item => item.path)).size !== paths.length || paths.some(item => item.path === destination)) throw new PersistenceConflictError('Backup databases must have separate paths');
  const metadata = persistedJson(input.metadata);
  const staging = join(dirname(destination), `.helmsman-backup-${randomUUID()}`);
  const locks: Database.Database[] = [];
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const item of paths) {
      const stat = await lstat(item.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new PersistenceConflictError('Backup source must be a regular SQLite database');
      const lock = new Database(item.path, { fileMustExist: true });
      locks.push(lock);
      lock.pragma('busy_timeout = 5000');
      lock.exec('BEGIN IMMEDIATE');
      if (item.name === 'main' || lock.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='persistence_writers'").get()) assertMaintenanceAvailable(lock);
    }
    const files: Array<{ name: string; sha256: string; bytes: number }> = [];
    for (const item of paths) {
      const name = `${item.name}.sqlite`;
      const source = new Database(item.path, { readonly: true, fileMustExist: true });
      try {
        await source.backup(join(staging, name));
      } finally { source.close(); }
      await chmod(join(staging, name), 0o600);
      const bytes = await readFile(join(staging, name));
      files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
    await writeFile(join(staging, 'manifest.json'), stableJson({ version: 1, createdAt: new Date().toISOString(), files, metadata }), { mode: 0o600 });
    try { await lstat(destination); throw new PersistenceConflictError('Backup destination already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    await rename(staging, destination);
  } finally {
    for (const lock of locks.reverse()) {
      try { if (lock.inTransaction) lock.exec('ROLLBACK'); } finally { lock.close(); }
    }
    await rm(staging, { recursive: true, force: true });
  }
}
