import { parseTaskRepo } from '../../src/plugins/tasks';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { TaskSourceStore } from './task-sources/store';
import type { TaskSourceService } from './task-source-service';
import type { BacklogItem } from './scheduler';

interface SourceSchedule { repo: string; instanceIds: readonly string[]; lastInstanceId: string | null; revision: number; cursorRevision: number; }
export function openTaskSourceSchedule(store: TaskSourceStore, service: TaskSourceService, onUnavailable: (instanceId: string) => void = () => {}) {
  const { sql } = store.persistence;
  const ddl = 'CREATE TABLE source_schedules (repo TEXT PRIMARY KEY,json TEXT NOT NULL)';
  migrateOwned(sql, { owner: 'core.source-schedules', version: 1, checksum: persistenceHash(ddl), tables: ['source_schedules'],
    validateLegacy: () => null, apply: database => database.exec(ddl), validateCurrent: database => validateTableColumns(database, 'source_schedules', ['repo', 'json']) });
  function selection(repo: string): SourceSchedule | null {
    parseTaskRepo(repo);
    const row = sql.prepare('SELECT json FROM source_schedules WHERE repo=?').get(repo) as { json: string } | undefined;
    if (!row) return null;
    const value = persistedJson(JSON.parse(row.json)) as unknown as SourceSchedule;
    if (!value || value.repo !== repo || !Array.isArray(value.instanceIds) || value.instanceIds.length > 32
      || value.instanceIds.some(id => typeof id !== 'string' || !id || id.length > 160) || new Set(value.instanceIds).size !== value.instanceIds.length
      || value.cursorRevision !== undefined && (!Number.isSafeInteger(value.cursorRevision) || value.cursorRevision < 0)
      || value.lastInstanceId !== null && !value.instanceIds.includes(value.lastInstanceId) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new PersistenceValidationError('Invalid task source scheduling selection');
    return { ...value, cursorRevision: value.cursorRevision ?? 0 };
  }
  const write = (value: SourceSchedule) => sql.prepare('INSERT INTO source_schedules VALUES (?,?) ON CONFLICT(repo) DO UPDATE SET json=excluded.json').run(value.repo, stableJson(value));
  return {
    initialize(input: { repos: readonly string[]; defaultSourceId: string | null }) {
      store.persistence.transaction(() => {
        const source = input.defaultSourceId ? store.source(input.defaultSourceId) : null;
        const instance = source ? store.instance(source.currentInstanceId) : null;
        for (const repo of input.repos) if (!selection(repo)) write({ repo, instanceIds: instance?.allowedRepos.includes(repo) ? [instance.id] : [], lastInstanceId: null, revision: 1, cursorRevision: 0 });
      });
    },
    selections(repo: string) { return selection(repo) ?? { repo, instanceIds: [], lastInstanceId: null, revision: 0, cursorRevision: 0 }; },
    select(repo: string, instanceIds: readonly string[], expectedRevision: number) {
      return store.persistence.transaction(() => {
        const current = selection(repo);
        if ((current?.revision ?? 0) !== expectedRevision) throw new PersistenceConflictError('Task source schedule changed');
        if (!Array.isArray(instanceIds) || instanceIds.length > 32 || new Set(instanceIds).size !== instanceIds.length) throw new PersistenceValidationError('Select distinct task source instances');
        const sources = new Set<string>();
        for (const id of instanceIds) {
          const instance = typeof id === 'string' ? store.instance(id) : null;
          if (!instance || !instance.allowedRepos.includes(repo)) throw new PersistenceConflictError('Task source is outside this galleon');
          service.assertScope(instance, repo, 'admission');
          if (sources.has(instance.sourceId)) throw new PersistenceConflictError('Select one instance per logical source');
          sources.add(instance.sourceId);
        }
        const next = { repo, instanceIds: [...instanceIds].sort(), lastInstanceId: null, revision: expectedRevision + 1, cursorRevision: 0 };
        write(next); return next;
      });
    },
    async next(repo: string, signal: AbortSignal): Promise<BacklogItem | null> {
      const selected = selection(repo);
      if (!selected?.instanceIds.length) return null;
      const ids = [...selected.instanceIds].sort();
      const offset = selected.lastInstanceId === null ? 0 : (ids.indexOf(selected.lastInstanceId) + 1) % ids.length;
      const ordered = [...ids.slice(offset), ...ids.slice(0, offset)];
      for (const id of ordered) {
        signal.throwIfAborted();
        const instance = store.instance(id);
        if (!instance) continue;
        try { service.assertScope(instance, repo, 'admission'); } catch { continue; }
        let cursor: string | null = null;
        const visited = new Set<string>();
        try { do {
          const page = await service.list({ instanceId: id, instanceRevision: instance.revision, repo, state: 'ready', cursor, limit: 100 }, signal);
          signal.throwIfAborted();
          if (selection(repo)?.revision !== selected.revision || selection(repo)?.cursorRevision !== selected.cursorRevision) throw new PersistenceConflictError('Task source scheduling selection changed during discovery');
          for (const task of page.items) {
            if (task.state !== 'ready' || store.activeClaim(task.ref)) continue;
            try { store.assertUnquarantined(task.ref, task.displayKey); } catch { continue; }
            store.persistence.transaction(() => {
              if (selection(repo)?.revision !== selected.revision || selection(repo)?.cursorRevision !== selected.cursorRevision) throw new PersistenceConflictError('Task source scheduling selection changed during discovery');
              service.assertScope(instance, repo, 'admission');
              write({ ...selected, lastInstanceId: id, cursorRevision: selected.cursorRevision + 1 });
            });
            return { mode: 'source', ticketId: task.displayKey, title: task.title, workRef: task.ref, sourceInstanceId: id, sourceInstanceRevision: instance.revision };
          }
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (visited.has(cursor) || visited.size >= 100) throw new PersistenceConflictError('Task source pagination did not advance within its limit');
            visited.add(cursor);
          }
        } while (cursor !== null); } catch {
          signal.throwIfAborted();
          if (selection(repo)?.revision !== selected.revision || selection(repo)?.cursorRevision !== selected.cursorRevision) throw new PersistenceConflictError('Task source scheduling selection changed during discovery');
          onUnavailable(id);
        }
      }
      return null;
    },
  };
}
export type TaskSourceSchedule = ReturnType<typeof openTaskSourceSchedule>;
