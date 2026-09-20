import { describe, expect, it } from 'vitest';
import { openDb, type RunRow } from './db';
import { openTodoStore } from './todos';
import { openUsageStore } from './usage-store';
import { openPersistence, registerPersistenceWriter } from './persistence';

const row: RunRow = { id: 'voyage', repo: 'owner/repo', ticketId: 'TODO-1', adapter: 'codex', status: 'running',
  attempt: 1, prNumber: null, startedAt: '2026-09-20T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: null };

describe('shared store connections', () => {
  it('rolls back source claims and run admission together and borrowers never close the connection', () => {
    const persistence = openPersistence(':memory:');
    try {
      const db = openDb(persistence.sql);
      const todos = openTodoStore(persistence.sql);
      const todo = todos.create({ title: 'Atomic admission', repo: row.repo, description: 'Persist before dispatch' });
      expect(() => persistence.transaction(() => {
        todos.claim(todo.id, row.id);
        db.insertRun(row);
        throw new Error('crash before admission commit');
      })).toThrow('crash before admission commit');
      expect(todos.get(todo.id)?.state).toBe('todo');
      expect(db.getRun(row.id)).toBeNull();
      persistence.transaction(() => { todos.claim(todo.id, row.id); db.insertRun(row); });
      expect(todos.get(todo.id)?.runId).toBe(row.id);
      expect(db.getRun(row.id)?.status).toBe('running');
      todos.close(); db.close();
      expect(persistence.sql.open).toBe(true);
      expect(openDb(persistence.sql).getRun(row.id)?.id).toBe(row.id);
    } finally { persistence.close(); }
  });

  it('rejects unknown partial schemas without recording an owned baseline or closing borrowed connections', () => {
    const persistence = openPersistence(':memory:');
    try {
      persistence.sql.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)');
      expect(() => openDb(persistence.sql)).toThrow('Unrecognized legacy schema');
      expect(persistence.sql.open).toBe(true);
      expect(persistence.sql.prepare('SELECT * FROM migration_ledger').all()).toEqual([]);
      expect(persistence.sql.prepare("SELECT name FROM sqlite_master WHERE name = 'run_events'").get()).toBeUndefined();
    } finally { persistence.close(); }
  });

  it('permits reopening migrated stores while a writer is active but blocks new schema ownership', () => {
    const persistence = openPersistence(':memory:');
    try {
      openDb(persistence.sql);
      const release = registerPersistenceWriter(persistence, 'application');
      try {
        expect(() => openDb(persistence.sql)).not.toThrow();
        expect(() => openUsageStore(persistence.sql)).toThrow('active database writer');
        expect(persistence.sql.open).toBe(true);
      } finally { release(); }
      expect(() => openUsageStore(persistence.sql)).not.toThrow();
    } finally { persistence.close(); }
  });

  it('rejects a table with missing uniqueness even when column types match', () => {
    const persistence = openPersistence(':memory:');
    try {
      openTodoStore(persistence.sql);
      persistence.sql.exec('DELETE FROM migration_ledger');
      const original = persistence.sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as { sql: string };
      persistence.sql.exec('DROP TABLE todos');
      persistence.sql.exec(original.sql.replace('runId TEXT UNIQUE', 'runId TEXT'));
      expect(() => openTodoStore(persistence.sql)).toThrow('Unrecognized table constraints');
    } finally { persistence.close(); }
  });
});
