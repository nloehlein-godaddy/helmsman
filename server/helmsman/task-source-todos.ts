import type { Todo } from '../../src/data/todos';
import type { PluginJson } from '../../src/plugins/backend';
import { parseLocalTaskDocumentV1, type LocalSourceRecordV1 } from '../../src/plugins/tasks';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import { pluginJson } from './plugins/data';
import { migrateOwned, validateTableColumns } from './migrations';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceStore } from './task-sources/store';

export interface TodoApi {
  list(): Todo[] | Promise<Todo[]>;
  get(id: string): Todo | null | Promise<Todo | null>;
  create(input: unknown, requestId?: string): Todo | Promise<Todo>;
  update(id: string, input: unknown, requestId?: string): Todo | null | Promise<Todo | null>;
  remove(id: string, requestId?: string): boolean | Promise<boolean>;
}

export function createSourceTodoApi(options: { sourceId: string; store: TaskSourceStore; service: TaskSourceService }): TodoApi {
  const { store, service, sourceId } = options;
  const sql = store.persistence.sql;
  const ddl = 'CREATE TABLE source_todo_commands (id TEXT PRIMARY KEY,inputHash TEXT NOT NULL,intent TEXT NOT NULL,result TEXT)';
  migrateOwned(sql, { owner: 'core.source-todo-commands', version: 1, checksum: persistenceHash(ddl), tables: ['source_todo_commands'],
    validateLegacy: () => null, apply: database => database.exec(ddl),
    validateCurrent: database => validateTableColumns(database, 'source_todo_commands', ['id', 'inputHash', 'intent', 'result']) });
  function context() {
    const source = store.source(sourceId);
    const instance = source && store.instance(source.currentInstanceId);
    if (!instance) throw new PersistenceConflictError('Local task source is unavailable');
    const signal = AbortSignal.timeout(30_000);
    const records = service.context(instance, null, signal).local;
    if (!records) throw new PersistenceConflictError('Selected local task source does not expose the compatible record schema');
    return { instance, signal, records };
  }
  function todo(record: LocalSourceRecordV1): Todo {
    if (record.ref.sourceId !== sourceId || record.schema !== 'helmsman.local-task/v1') throw new PersistenceConflictError('Incompatible local task source record');
    const data = parseLocalTaskDocumentV1(record.data);
    return { id: record.ref.externalId, repo: record.repo, title: data.title, description: data.description,
      acceptanceCriteria: data.acceptanceCriteria, priority: data.priority, state: data.state,
      createdAt: data.createdAt, updatedAt: data.updatedAt, completedAt: data.completedAt,
      runId: record.lastRunId };
  }
  function request(value: string | undefined): string {
    if (!value || !value.trim() || value.length > 240) throw new PersistenceValidationError('A stable Todo request ID is required');
    return value;
  }
  function data(input: unknown): Readonly<Record<string, PluginJson>> {
    const value = pluginJson(input, { maxBytes: 256 * 1024, maxNodes: 1024 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistenceValidationError('Todo must be an object');
    return value as Readonly<Record<string, PluginJson>>;
  }
  async function command(commandId: string, rawInput: PluginJson, requestId: string | undefined,
    prepare: (scope: ReturnType<typeof context>) => Promise<{ repo: string; input: PluginJson } | null>): Promise<LocalSourceRecordV1 | null> {
    const id = request(requestId);
    const inputHash = persistenceHash({ sourceId, commandId, rawInput });
    const scope = context();
    type Intent = { instanceId: string; instanceRevision: number; repo: string; input: PluginJson } | null;
    const read = () => {
      const row = sql.prepare('SELECT inputHash,intent,result FROM source_todo_commands WHERE id=?').get(id) as { inputHash: string; intent: string; result: string | null } | undefined;
      if (row && row.inputHash !== inputHash) throw new PersistenceConflictError('Todo request identity changed');
      return row;
    };
    let saved = read();
    if (!saved) {
      const value = await prepare(scope);
      scope.signal.throwIfAborted();
      const intent: Intent = value ? { instanceId: scope.instance.id, instanceRevision: scope.instance.revision, ...value } : null;
      saved = store.persistence.transaction(() => {
        service.assertScope(scope.instance, null, 'admission');
        sql.prepare('INSERT OR IGNORE INTO source_todo_commands VALUES (?,?,?,?)').run(id, inputHash, stableJson(intent), intent === null ? 'null' : null);
        return read()!;
      });
    }
    if (saved.result !== null) return persistedJson(JSON.parse(saved.result)) as unknown as LocalSourceRecordV1 | null;
    const intent = persistedJson(JSON.parse(saved.intent)) as unknown as Intent;
    if (!intent) return null;
    const result = await service.command({ ...intent, commandId, requestId: id }, scope.signal);
    store.persistence.transaction(() => { sql.prepare('UPDATE source_todo_commands SET result=? WHERE id=? AND inputHash=?').run(stableJson(result), id, inputHash); });
    return result;
  }
  return {
    async list() {
      const { instance, signal, records } = context();
      const result: Todo[] = [];
      for (const repo of [...instance.allowedRepos].sort()) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const page = await service.list({ instanceId: instance.id, instanceRevision: instance.revision, repo, cursor, state: null, limit: 100 }, signal);
          for (const task of page.items) {
            const record = await records.get(task.ref.externalId);
            if (!record || record.revision !== task.revision) throw new PersistenceConflictError('Task list changed while loading; refresh');
            result.push(todo(record));
          }
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (cursors.has(cursor) || cursors.size > 10_000) throw new PersistenceConflictError('Task source pagination did not advance');
            cursors.add(cursor);
          }
        } while (cursor !== null);
      }
      return result;
    },
    async get(id) {
      const { records } = context();
      const record = await records.get(id); return record ? todo(record) : null;
    },
    async create(input, requestId) {
      const value = data(input);
      if (typeof value.repo !== 'string') throw new PersistenceValidationError('Galleon is required');
      const repo = value.repo;
      const record = await command('create', value, requestId, async () => ({ repo, input: value }));
      if (!record) throw new PersistenceConflictError('Task source did not create a Todo');
      return todo(record);
    },
    async update(id, input, requestId) {
      const value = data(input);
      const updated = await command('update', { id, patch: value }, requestId, async ({ records }) => {
        const record = await records.get(id);
        return record ? { repo: record.repo, input: { ref: { ...record.ref }, expectedRevision: record.revision, patch: value } } : null;
      });
      return updated ? todo(updated) : null;
    },
    async remove(id, requestId) {
      await command('delete', { id }, requestId, async ({ records }) => {
        const record = await records.get(id);
        return record ? { repo: record.repo, input: { ref: { ...record.ref }, expectedRevision: record.revision } } : null;
      });
      const saved = sql.prepare('SELECT intent FROM source_todo_commands WHERE id=?').get(request(requestId)) as { intent: string } | undefined;
      return saved?.intent !== undefined && saved.intent !== 'null';
    },
  };
}
