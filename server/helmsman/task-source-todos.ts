import type { LegacyTodoCommandQuery, LegacyTodoCommandReceipt } from '../../src/plugins/todo-legacy-recovery';
import type { Todo } from '../../src/data/todos';
import type { PluginJson } from '../../src/plugins/backend';
import { parseLocalTaskDocumentV1, type LocalSourceRecordV1 } from '../../src/plugins/tasks';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import { pluginJson } from './plugins/data';
import { migrateOwned, validateTableColumns } from './migrations';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceStore } from './task-sources/store';

export class SourceTodoRejectedError extends PersistenceConflictError {
  readonly requestId: string;
  readonly commandId: string;
  constructor(message: string, requestId: string, commandId: string) { super(message); this.requestId = requestId; this.commandId = commandId; }
}
interface RejectedTodoCommand { version: 1; kind: 'todo-command-rejected'; requestId: string; commandId: string; message: string }
function rejectedCommand(value: unknown): RejectedTodoCommand | null {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'todo-command-rejected') return null;
  const receipt = value as RejectedTodoCommand;
  if (receipt.version !== 1 || typeof receipt.requestId !== 'string' || typeof receipt.commandId !== 'string' || typeof receipt.message !== 'string') throw new PersistenceValidationError('Invalid rejected Todo command receipt');
  return receipt;
}
function rejectedError(receipt: RejectedTodoCommand): SourceTodoRejectedError { return new SourceTodoRejectedError(receipt.message, receipt.requestId, receipt.commandId); }

export type { LegacyTodoCommandQuery, LegacyTodoCommandReceipt } from '../../src/plugins/todo-legacy-recovery';
export interface TodoApi {
  legacyReceipt?(input: LegacyTodoCommandQuery): LegacyTodoCommandReceipt;
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
    if (!record || record.ref?.sourceId !== sourceId || record.schema !== 'helmsman.local-task/v1') throw new PersistenceConflictError('Incompatible local task source record');
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
    if (saved.result !== null) {
      const result = persistedJson(JSON.parse(saved.result)); const rejection = rejectedCommand(result);
      if (rejection) throw rejectedError(rejection);
      return result as unknown as LocalSourceRecordV1 | null;
    }
    const intent = persistedJson(JSON.parse(saved.intent)) as unknown as Intent;
    if (!intent) return null;
    try {
      const result = await service.command({ ...intent, commandId, requestId: id }, scope.signal, () => {
        const current = read();
        if (!current) throw new PersistenceConflictError('Todo command intent is unavailable');
        const rejection = current.result === null ? null : rejectedCommand(persistedJson(JSON.parse(current.result)));
        if (rejection) throw rejectedError(rejection);
      });
      store.persistence.transaction(() => { sql.prepare('UPDATE source_todo_commands SET result=? WHERE id=? AND inputHash=?').run(stableJson(result), id, inputHash); });
      return result;
    } catch (error) {
      const rejection = store.persistence.transaction(() => {
        if (sql.prepare('SELECT id FROM source_commands WHERE id=?').get(id)) return null;
        const current = read();
        if (!current) return null;
        if (current.result !== null) return rejectedCommand(persistedJson(JSON.parse(current.result)));
        const receipt: RejectedTodoCommand = { version: 1, kind: 'todo-command-rejected', requestId: id, commandId,
          message: error instanceof PersistenceConflictError || error instanceof PersistenceValidationError ? error.message : 'Todo change was not applied. Refresh the Todo and try again.' };
        sql.prepare('UPDATE source_todo_commands SET result=? WHERE id=? AND inputHash=? AND result IS NULL').run(stableJson(receipt), id, inputHash);
        return receipt;
      });
      if (rejection) throw rejectedError(rejection);
      throw error;
    }
  }
  return {
    legacyReceipt(query) {
      const value = persistedJson(query) as unknown as LegacyTodoCommandQuery;
      if (!value || Object.keys(value).some(key => !['requestId', 'path', 'method', 'input'].includes(key))
        || !Object.hasOwn(value, 'input') || typeof value.path !== 'string') throw new PersistenceValidationError('Invalid legacy Todo receipt query');
      const requestId = request(value.requestId);
      const match = /^\/api\/todos\/(TODO-[1-9]\d*)$/.exec(value.path);
      const commandId = value.method === 'POST' && value.path === '/api/todos' ? 'create'
        : value.method === 'PUT' && match ? 'update' : value.method === 'DELETE' && match && value.input === null ? 'delete' : null;
      if (!commandId) throw new PersistenceValidationError('Invalid legacy Todo operation');
      const externalId = match?.[1] ?? null;
      const rawInput = commandId === 'create' ? data(value.input) : commandId === 'update' ? { id: externalId, patch: data(value.input) } : { id: externalId };
      const inputHash = persistenceHash({ sourceId, commandId, rawInput });
      const base: LegacyTodoCommandReceipt = { version: 1, requestId, commandId, repo: null, status: 'unrecorded', reason: 'not-recorded', message: null, result: null };
      return store.persistence.transaction(() => {
        const saved = sql.prepare('SELECT inputHash,intent,result FROM source_todo_commands WHERE id=?').get(requestId) as { inputHash: string; intent: string; result: string | null } | undefined;
        if (!saved) return base;
        if (saved.inputHash !== inputHash) throw new PersistenceConflictError('Legacy Todo request identity changed');
        const intent = persistedJson(JSON.parse(saved.intent)) as unknown as { instanceId: string; instanceRevision: number; repo: string; input: PluginJson } | null;
        const scoped = { ...base, repo: intent?.repo ?? null };
        let result = saved.result;
        if (result === null) {
          const applied = sql.prepare('SELECT inputHash,json FROM source_commands WHERE id=?').get(requestId) as { inputHash: string; json: string } | undefined;
          if (!applied) return { ...scoped, status: 'pending', reason: 'mutation-unconfirmed' };
          const original = intent ? store.instance(intent.instanceId) : null;
          if (!intent || !original || original.sourceId !== sourceId || original.revision !== intent.instanceRevision) return { ...scoped, status: 'blocked', reason: 'original-authority-unavailable' };
          if (applied.inputHash !== persistenceHash({ instance: original, repo: intent.repo, commandId, input: intent.input })) return { ...scoped, status: 'blocked', reason: 'mutation-proof-mismatch' };
          result = applied.json;
        }
        const recorded = persistedJson(JSON.parse(result)); const rejection = rejectedCommand(recorded);
        let receipt: LegacyTodoCommandReceipt;
        if (rejection) {
          if (rejection.requestId !== requestId || rejection.commandId !== commandId) throw new PersistenceValidationError('Legacy Todo rejection identity changed');
          receipt = { ...scoped, status: 'rejected', reason: null, message: rejection.message };
        } else if (recorded === null) {
          if (commandId === 'create' || !externalId) throw new PersistenceValidationError('Legacy creation result is unavailable');
          receipt = { ...scoped, status: 'succeeded', reason: null, result: intent
            ? { kind: 'deleted', ref: { sourceId, externalId }, repo: intent.repo }
            : { kind: 'not-found', ref: { sourceId, externalId } } };
          if (intent && commandId !== 'delete') throw new PersistenceValidationError('Legacy update result is unavailable');
        } else {
          const local = recorded as unknown as LocalSourceRecordV1; const task = todo(local);
          if (commandId === 'delete' || externalId !== null && task.id !== externalId || typeof local.revision !== 'string' || !local.revision) throw new PersistenceValidationError('Legacy task result changed');
          receipt = { ...scoped, repo: intent?.repo ?? task.repo, status: 'succeeded', reason: null, result: { kind: 'changed', ref: { sourceId, externalId: task.id }, repo: task.repo, revision: local.revision } };
        }
        if (saved.result === null) sql.prepare('UPDATE source_todo_commands SET result=? WHERE id=? AND inputHash=? AND result IS NULL').run(result, requestId, inputHash);
        return receipt;
      });
    },
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
