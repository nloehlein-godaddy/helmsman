// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistence, registerPersistenceWriter } from './persistence';
import { backupPersistenceSet } from './persistence-backup';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-backup-')); directories.push(root);
  const databases = { main: join(root, 'main.sqlite'), catalog: join(root, 'catalog.sqlite'), data: join(root, 'data.sqlite') };
  const connections = Object.values(databases).map(path => openPersistence(path));
  for (const connection of connections) {
    connection.sql.pragma('wal_autocheckpoint = 0');
    connection.sql.exec('CREATE TABLE accepted (generation INTEGER NOT NULL)');
    connection.sql.prepare('INSERT INTO accepted VALUES (?)').run(7);
  }
  return { root, databases, connections };
}

describe('consistent persistence backup', () => {
  it('includes acknowledged WAL writes from every database without modifying source state', async () => {
    const { root, databases, connections } = setup();
    try {
      const destination = join(root, 'backup');
      await backupPersistenceSet({ databases, destination, metadata: { retainedArtifacts: ['abc'] } });
      for (const name of Object.keys(databases)) {
        const restored = new Database(join(destination, `${name}.sqlite`), { readonly: true });
        try { expect(restored.prepare('SELECT * FROM accepted').all()).toEqual([{ generation: 7 }]); }
        finally { restored.close(); }
      }
      expect(JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')).files).toHaveLength(3);
      expect(connections[0]?.sql.prepare('SELECT * FROM accepted').all()).toEqual([{ generation: 7 }]);
      await expect(backupPersistenceSet({ databases, destination, metadata: {} })).rejects.toThrow('already exists');
    } finally { connections.forEach(connection => connection.close()); }
  });

  it.each([0, 1, 2])('rejects a live writer in database %i and leaves no partial backup', async index => {
    const { root, databases, connections } = setup();
    const release = registerPersistenceWriter(connections[index]!, 'application');
    try {
      await expect(backupPersistenceSet({ databases, destination: join(root, 'backup'), metadata: {} })).rejects.toThrow('active database writer');
      connections[0]?.sql.prepare('INSERT INTO accepted VALUES (?)').run(8);
      expect(connections[0]?.sql.prepare('SELECT COUNT(*) AS n FROM accepted').get()).toEqual({ n: 2 });
    } finally { release(); connections.forEach(connection => connection.close()); }
  });
});
