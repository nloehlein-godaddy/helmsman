import type { PluginJson } from '../../../src/plugins/backend';
import { parseLocalTaskDocumentV1, parseLocalTaskInputV1, parseTaskRepo, parseWorkRefV1, TASK_SOURCE_LIMITS, type LocalSourceCommandPlanV1, type LocalSourceRecordV1, type LocalSourceRecordsV1, type LocalTaskDocumentV1, type SourceInstanceV1, type SourceMutationPlanV1 } from '../../../src/plugins/tasks';
import { persistenceHash, stableJson, PersistenceConflictError, PersistenceValidationError } from '../persistence';
import { openTodoStore, type TodoStore } from '../todos';
import { readTaskSource, writeTaskSource, type TaskSourceStore, type WorkClaimRecord } from './store';

export interface LocalSourceAdapter {
  forContext(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal): LocalSourceRecordsV1;
  get(sourceId: string, externalId: string): LocalSourceRecordV1 | null;
  hasCommandResult(requestId: string): boolean;
  recordedCommandResult(input: { requestId: string; instance: SourceInstanceV1; repo: string; commandId: string; commandInput: PluginJson }): { found: false } | { found: true; result: LocalSourceRecordV1 | null };
  commandResult(input: { requestId: string; instance: SourceInstanceV1; repo: string; commandId: string; commandInput: PluginJson }): { found: false } | { found: true; result: LocalSourceRecordV1 | null };
  applyCommand(input: { requestId: string; instance: SourceInstanceV1; repo: string; commandId: string; commandInput: PluginJson; plan: LocalSourceCommandPlanV1 }): LocalSourceRecordV1 | null;
  applyMutation(input: { claim: WorkClaimRecord; plan: SourceMutationPlanV1; purpose: 'claim' | 'completion' | 'abort' }): LocalSourceRecordV1 | null;
}
export const LOCAL_TASK_SCHEMA = 'helmsman.local-task/v1';
function sequence(id: string): number {
  if (!/^TODO-[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(5)))) throw new PersistenceValidationError('Invalid local task identifier');
  return Number(id.slice(5));
}
function sameRef(a: { sourceId: string; externalId: string }, b: { sourceId: string; externalId: string }): boolean { return a.sourceId === b.sourceId && a.externalId === b.externalId; }
export function openLocalSourceAdapter(store: TaskSourceStore, now: () => string = () => new Date().toISOString()): LocalSourceAdapter {
  const { sql } = store.persistence;
  let todos: TodoStore | undefined;
  const legacy = () => todos ??= openTodoStore(sql, now);
  function envelope(sourceId: string, externalId: string, repo: string, revision: string, data: LocalTaskDocumentV1, lastRunId?: string | null): LocalSourceRecordV1 {
    const ref = { sourceId, externalId }; const latest = store.activeClaim(ref) ?? store.latestClaim(ref);
    let receipt = latest?.settlement?.disposition === 'released' ? null : latest?.receipt ?? null;
    let recordedOwner = latest?.settlement?.disposition === 'released' ? null : latest?.runId ?? null;
    if (latest?.state === 'reserved' && !receipt) {
      const previous = store.claims().filter(item => sameRef(item.ref, ref) && item.id !== latest.id && item.state === 'settled').at(-1);
      receipt = previous?.settlement?.disposition === 'released' ? null : previous?.receipt ?? null;
      recordedOwner = previous?.settlement?.disposition === 'released' ? null : previous?.runId ?? null;
    }
    return { ref, repo, revision, schema: LOCAL_TASK_SCHEMA, data: data as unknown as PluginJson, claim: receipt, lastRunId: lastRunId === undefined ? recordedOwner : lastRunId, claimState: latest?.state ?? null };
  }
  function get(sourceId: string, externalId: string): LocalSourceRecordV1 | null {
    const source = readTaskSource(store, sourceId); parseWorkRefV1({ sourceId, externalId });
    if (source.storageLayout === 'remote') throw new PersistenceConflictError('Remote source has no local records');
    if (source.storageLayout === 'legacy-todos') {
      const todo = legacy().get(externalId); if (!todo) return null;
      const data = parseLocalTaskDocumentV1({ version: 1, title: todo.title, description: todo.description, acceptanceCriteria: todo.acceptanceCriteria, priority: todo.priority, state: todo.state, createdAt: todo.createdAt, updatedAt: todo.updatedAt, completedAt: todo.completedAt ?? null });
      return envelope(sourceId, externalId, todo.repo, persistenceHash(todo), data, todo.runId);
    }
    const row = sql.prepare('SELECT * FROM source_documents WHERE sourceId=? AND externalId=?').get(sourceId, externalId) as { repo: string; revision: number; schema: string; data: string } | undefined;
    if (!row) return null; if (row.schema !== LOCAL_TASK_SCHEMA) throw new PersistenceConflictError('Unsupported local source schema');
    return envelope(sourceId, externalId, row.repo, String(row.revision), parseLocalTaskDocumentV1(JSON.parse(row.data)));
  }
  function changed(sourceId: string): void { const source = readTaskSource(store, sourceId); writeTaskSource(store, { ...source, collectionRevision: source.collectionRevision + 1 }); }
  function scope(instance: SourceInstanceV1, repo: string): void {
    parseTaskRepo(repo); const current = store.instance(instance.id); const source = readTaskSource(store, instance.sourceId); const selected = store.instance(source.currentInstanceId);
    if (!current || current.revision !== instance.revision || !current.desiredEnabled || !current.allowedRepos.includes(repo) || !selected || selected.binding.providerId !== instance.binding.providerId || selected.binding.artifactHash !== instance.binding.artifactHash) throw new PersistenceConflictError('Local source scope is unavailable');
  }
  function document(input: PluginJson, previous?: LocalTaskDocumentV1): LocalTaskDocumentV1 {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, PluginJson> : null;
    const parsed = raw && Object.hasOwn(raw, 'createdAt') ? parseLocalTaskDocumentV1(input) : parseLocalTaskInputV1(input);
    const timestamp = now();
    return parseLocalTaskDocumentV1({ version: 1, title: parsed.title, description: parsed.description, acceptanceCriteria: parsed.acceptanceCriteria, priority: parsed.priority, state: parsed.state, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, completedAt: parsed.state === 'done' ? previous?.completedAt ?? timestamp : null });
  }
  function write(sourceId: string, id: string | null, repo: string, data: LocalTaskDocumentV1, runId: string | null | undefined): LocalSourceRecordV1 {
    const source = readTaskSource(store, sourceId);
    if (source.storageLayout === 'legacy-todos') {
      legacy();
      if (id === null) {
        const result = sql.prepare('INSERT INTO todos (title,repo,description,acceptanceCriteria,priority,state,createdAt,updatedAt,completedAt,runId) VALUES (?,?,?,?,?,?,?,?,?,?)').run(data.title, repo, data.description, data.acceptanceCriteria, data.priority, data.state, data.createdAt, data.updatedAt, data.completedAt, runId ?? null);
        id = `TODO-${result.lastInsertRowid}`;
      } else {
        const prior = legacy().get(id); if (!prior) throw new PersistenceConflictError('Local task disappeared');
        sql.prepare('UPDATE todos SET title=?,repo=?,description=?,acceptanceCriteria=?,priority=?,state=?,createdAt=?,updatedAt=?,completedAt=?,runId=? WHERE sequence=?').run(data.title, repo, data.description, data.acceptanceCriteria, data.priority, data.state, data.createdAt, data.updatedAt, data.completedAt, runId === undefined ? prior.runId : runId, sequence(id));
      }
    } else if (source.storageLayout === 'documents') {
      if (id === null) id = `TODO-${source.collectionRevision}`;
      sql.prepare('INSERT INTO source_documents VALUES (?,?,?,1,?,?) ON CONFLICT(sourceId,externalId) DO UPDATE SET repo=excluded.repo,revision=source_documents.revision+1,schema=excluded.schema,data=excluded.data').run(sourceId, id, repo, LOCAL_TASK_SCHEMA, stableJson(data));
    } else throw new PersistenceConflictError('Remote source has no local records');
    changed(sourceId); return get(sourceId, id)!;
  }
  const adapter: LocalSourceAdapter = {
    get,
    forContext(instance, repo, signal) {
      const sourceId = instance.sourceId;
      function check(requestedRepo?: string): void {
        signal.throwIfAborted(); const allowed = requestedRepo ?? repo;
        if (requestedRepo && repo !== null && requestedRepo !== repo || allowed && !instance.allowedRepos.includes(allowed)) throw new PersistenceConflictError('Local source read is outside the authorized galleon');
      }
      return Object.freeze({
        async describeCollection() { check(); const source = readTaskSource(store, sourceId); if (!source.collectionId) throw new PersistenceConflictError('Local collection unavailable'); return { sourceId, collectionId: source.collectionId, schema: LOCAL_TASK_SCHEMA, revision: source.collectionRevision, evidenceId: persistenceHash({ sourceId, collectionId: source.collectionId }) }; },
        async get(externalId: string) { check(); const record = get(sourceId, externalId); if (record) { check(record.repo); } return record; },
        async list(input: { repo: string; cursor: string | null; limit: number }) {
          check(input?.repo); parseTaskRepo(input.repo); if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new PersistenceValidationError('Invalid local source page size');
          const source = readTaskSource(store, sourceId); let offset = 0;
          if (input.cursor !== null) {
            if (typeof input.cursor !== 'string' || input.cursor.length > 1024) throw new PersistenceValidationError('Invalid local record cursor');
            const parsed = JSON.parse(input.cursor) as { sourceId?: unknown; repo?: unknown; revision?: unknown; offset?: unknown } | null;
            if (!parsed || parsed.sourceId !== sourceId || parsed.repo !== input.repo || parsed.revision !== source.collectionRevision || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > TASK_SOURCE_LIMITS.collectionRecords) throw new PersistenceConflictError('Local collection cursor changed'); offset = Number(parsed.offset);
          }
          const ids = source.storageLayout === 'legacy-todos' ? legacy().list().filter(todo => todo.repo === input.repo).map(todo => todo.id)
            : (sql.prepare('SELECT externalId FROM source_documents WHERE sourceId=? AND repo=? ORDER BY externalId').all(sourceId, input.repo) as { externalId: string }[]).map(row => row.externalId);
          if (ids.length > TASK_SOURCE_LIMITS.collectionRecords) throw new PersistenceConflictError('Local collection exceeds quota');
          const records = ids.slice(offset, offset + input.limit).map(id => get(sourceId, id)!);
          return { records, nextCursor: offset + records.length < ids.length ? JSON.stringify({ sourceId, repo: input.repo, revision: source.collectionRevision, offset: offset + records.length }) : null };
        },
      });
    },
    hasCommandResult(requestId) { return Boolean(sql.prepare('SELECT 1 FROM source_commands WHERE id=?').get(requestId)); },
    commandResult(input) { scope(input.instance, input.repo); return adapter.recordedCommandResult(input); },
    recordedCommandResult(input) {
      const previous = sql.prepare('SELECT inputHash,json FROM source_commands WHERE id=?').get(input.requestId) as { inputHash: string; json: string } | undefined;
      if (!previous) return { found: false };
      const inputHash = persistenceHash({ instance: input.instance, repo: input.repo, commandId: input.commandId, input: input.commandInput });
      if (previous.inputHash !== inputHash) throw new PersistenceConflictError('Source command request identity changed');
      return { found: true, result: JSON.parse(previous.json) as LocalSourceRecordV1 | null };
    },
    applyCommand(input) { return store.persistence.transaction(() => {
      if (!input.requestId?.trim() || input.requestId.length > 240) throw new PersistenceValidationError('Source command request ID is required');
      scope(input.instance, input.repo); const source = readTaskSource(store, input.instance.sourceId);
      if (!source.conversionReady) throw new PersistenceConflictError('Source conversion is incomplete');
      const inputHash = persistenceHash({ instance: input.instance, repo: input.repo, commandId: input.commandId, input: input.commandInput });
      const previous = sql.prepare('SELECT inputHash,json FROM source_commands WHERE id=?').get(input.requestId) as { inputHash: string; json: string } | undefined;
      if (previous) { if (previous.inputHash !== inputHash) throw new PersistenceConflictError('Source command request identity changed'); return JSON.parse(previous.json) as LocalSourceRecordV1 | null; }
      const plan = input.plan; let result: LocalSourceRecordV1 | null;
      if (plan.kind === 'create') {
        if (plan.repo !== input.repo || plan.schema !== LOCAL_TASK_SCHEMA) throw new PersistenceValidationError('Invalid source command target');
        const count = source.storageLayout === 'legacy-todos' ? legacy().list().length : (sql.prepare('SELECT count(*) AS count FROM source_documents WHERE sourceId=?').get(source.id) as { count: number }).count;
        if (count >= TASK_SOURCE_LIMITS.collectionRecords) throw new PersistenceConflictError('Local source collection quota reached');
        const data = document(plan.data); if (data.state === 'in_progress') throw new PersistenceConflictError('Only admission can claim local work'); result = write(source.id, null, input.repo, data, null);
      } else {
        parseWorkRefV1(plan.ref); if (plan.ref.sourceId !== source.id) throw new PersistenceConflictError('Source command targets another collection');
        const current = get(source.id, plan.ref.externalId);
        if (!current || current.repo !== input.repo || current.revision !== plan.expectedRevision) throw new PersistenceConflictError('Local record revision changed');
        store.assertUnquarantined(current.ref); if (store.activeClaim(current.ref) || parseLocalTaskDocumentV1(current.data).state === 'in_progress') throw new PersistenceConflictError('Claimed work cannot be edited');
        if (plan.kind === 'delete') {
          if (source.storageLayout === 'legacy-todos') sql.prepare('DELETE FROM todos WHERE sequence=?').run(sequence(plan.ref.externalId)); else sql.prepare('DELETE FROM source_documents WHERE sourceId=? AND externalId=?').run(source.id, plan.ref.externalId);
          changed(source.id); result = null;
        } else if (plan.kind === 'update') {
          if (plan.next.schema !== LOCAL_TASK_SCHEMA || !input.instance.allowedRepos.includes(parseTaskRepo(plan.next.repo))) throw new PersistenceConflictError('Source command destination galleon is unauthorized');
          const data = document(plan.next.data, parseLocalTaskDocumentV1(current.data)); if (data.state === 'in_progress') throw new PersistenceConflictError('Only admission can claim local work'); result = write(source.id, current.ref.externalId, plan.next.repo, data, undefined);
        } else throw new PersistenceValidationError('Invalid local source command');
      }
      sql.prepare('INSERT INTO source_commands VALUES (?,?,?)').run(input.requestId, inputHash, stableJson(result)); return result;
    }); },
    applyMutation(input) { return store.persistence.transaction(() => {
      const currentClaim = store.claim(input.claim.id); if (!currentClaim || currentClaim.revision !== input.claim.revision || currentClaim.state === 'settled') throw new PersistenceConflictError('Source mutation claim changed');
      if (input.plan.kind === 'none') return get(input.claim.ref.sourceId, input.claim.ref.externalId);
      if (input.plan.kind !== 'local-record' || !sameRef(input.plan.ref, currentClaim.ref)) throw new PersistenceValidationError('Invalid local source mutation');
      const current = get(currentClaim.ref.sourceId, currentClaim.ref.externalId);
      if (!current || current.revision !== input.plan.expectedRevision || current.repo !== input.plan.next.repo || input.plan.next.schema !== LOCAL_TASK_SCHEMA) throw new PersistenceConflictError('Local source mutation revision changed');
      const previous = parseLocalTaskDocumentV1(current.data); const data = document(input.plan.next.data, previous);
      if (input.purpose === 'claim' && (currentClaim.state !== 'reserved' || data.state !== 'in_progress' || !previous.description.trim() || !['todo', 'blocked'].includes(previous.state))) throw new PersistenceConflictError('Invalid local source claim transition');
      if (input.purpose === 'claim' && (previous.state === 'blocked' && !currentClaim.retryOf || currentClaim.retryOf && (current.claim?.runId ?? current.lastRunId) !== currentClaim.retryOf)) throw new PersistenceConflictError('Local retry must match the retained previous owner');
      if (input.purpose === 'completion' && (currentClaim.state !== 'settling' || previous.state !== 'in_progress' || !['in_review', 'blocked'].includes(data.state))) throw new PersistenceConflictError('Invalid local source completion transition');
      if (input.purpose === 'abort' && (currentClaim.state !== 'settling' || !['in_progress', 'todo', 'blocked'].includes(previous.state) || data.state !== 'todo')) throw new PersistenceConflictError('Invalid local source abort transition');
      const priorFields = { ...previous, state: data.state, updatedAt: data.updatedAt, completedAt: data.completedAt };
      if (stableJson(priorFields) !== stableJson(data)) throw new PersistenceConflictError('Lifecycle mutation cannot edit task content');
      return write(currentClaim.ref.sourceId, currentClaim.ref.externalId, current.repo, data, input.purpose === 'abort' ? null : currentClaim.runId);
    }); },
  };
  return adapter;
}
