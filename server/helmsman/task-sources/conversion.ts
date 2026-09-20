import type { PluginJson } from '../../../src/plugins/backend';
import { assertMaintenanceAvailable, persistedJson, persistenceHash, stableJson, PersistenceConflictError, PersistenceValidationError } from '../persistence';
import { readTaskSource, writeTaskSource, type TaskSourceStore, type WorkClaimRecord } from './store';

export interface LegacySourceObligation {
  readonly runId: string;
  readonly source: 'todos' | 'jira' | 'unknown';
  readonly externalId: string | null;
  readonly displayKey: string | null;
  readonly evidence: PluginJson;
}
export interface SourceConversionAudit { readonly hash: string; readonly obligations: readonly LegacySourceObligation[]; readonly baseline: PluginJson }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try { return object(persistedJson(JSON.parse(value))); } catch { return null; }
}
export function createSourceConversionCoordinator(store: TaskSourceStore) {
  const { sql } = store.persistence;
  function rows(table: string): Record<string, unknown>[] {
    return sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[] : [];
  }
  function audit(): SourceConversionAudit {
    const tables = ['runs', 'todos', 'execution_admissions', 'execution_attempts', 'execution_snapshots', 'execution_checkpoints', 'execution_reservations', 'operations', 'legacy_execution_obligations'] as const;
    const baseline = Object.fromEntries(tables.map(table => [table, rows(table)]));
    const reasons = new Map<string, { kind: string; evidence: Record<string, unknown> }[]>();
    function retain(runId: unknown, kind: string, evidence: Record<string, unknown>): void {
      if (typeof runId !== 'string' || !runId) throw new PersistenceValidationError('Legacy source ownership has no valid run identity');
      const prior = reasons.get(runId) ?? []; prior.push({ kind, evidence }); reasons.set(runId, prior);
    }
    for (const row of baseline.execution_admissions ?? []) if (row.state === 'pending' || row.state === 'blocked') retain(row.runId, 'admission', row);
    for (const row of baseline.execution_attempts ?? []) { const value = parsed(row.json); if (!value || !value.outcome) retain(row.runId, 'execution', row); }
    for (const row of baseline.execution_checkpoints ?? []) if (row.state !== 'retired') retain(row.runId, 'checkpoint', row);
    for (const row of baseline.execution_reservations ?? []) retain(row.runId, 'reservation', row);
    for (const row of baseline.operations ?? []) if (row.status !== 'completed' && row.runId !== null) retain(row.runId, 'operation', row);
    for (const row of baseline.legacy_execution_obligations ?? []) if (row.protected !== 0) retain(row.runId, 'legacy', row);
    for (const row of baseline.runs ?? []) if (row.status === 'running') retain(row.id, 'run', row);
    for (const row of baseline.todos ?? []) if (row.state === 'in_progress') retain(typeof row.runId === 'string' && row.runId ? row.runId : `unowned-todo-${row.sequence}`, 'todo-link', row);
    const obligations: LegacySourceObligation[] = [];
    for (const [runId, evidence] of reasons) {
      if (store.claims().some(claim => claim.runId === runId && !claim.id.startsWith('legacy-'))) continue;
      const run = baseline.runs?.find(row => row.id === runId); const admission = baseline.execution_admissions?.find(row => row.runId === runId);
      const snapshotRow = baseline.execution_snapshots?.filter(row => row.runId === runId).at(-1);
      const snapshot = parsed(snapshotRow?.json); const request = object(parsed(admission?.json)?.request);
      const task = object(snapshot?.task) ?? parsed(run?.taskJson) ?? request;
      const linked = baseline.todos?.filter(row => row.runId === runId || `unowned-todo-${row.sequence}` === runId) ?? [];
      const todoId = typeof task?.todoId === 'string' ? task.todoId : request?.mode === 'todo' && typeof request.todoId === 'string' ? request.todoId : null;
      if (linked.length > 1) throw new PersistenceConflictError('Several legacy Todos claim the same run');
      if (todoId || linked.length) {
        const externalId = todoId ?? `TODO-${linked[0]!.sequence}`;
        if (!/^TODO-[1-9]\d*$/.test(externalId) || linked.length && externalId !== `TODO-${linked[0]!.sequence}`) throw new PersistenceConflictError('Legacy Todo ownership identity is inconsistent');
        obligations.push({ runId, source: 'todos', externalId, displayKey: externalId, evidence: persistedJson(evidence.map(item => ({ kind: item.kind, rowHash: persistenceHash(item.evidence) }))) }); continue;
      }
      if (task?.review === true || typeof task?.task === 'string' || ['review', 'rerun', 'task'].includes(String(request?.mode))) continue;
      const jiraTargets = (baseline.operations ?? []).filter(row => row.runId === runId).map(row => parsed(row.draft)).filter(draft => draft?.kind === 'jira.assign' || draft?.kind === 'jira.transition').map(draft => object(draft?.target));
      const canonicalIds = new Set(jiraTargets.map(target => target?.issueId).filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)));
      if (canonicalIds.size > 1) throw new PersistenceConflictError('Legacy Jira ownership has conflicting immutable identities');
      const displayKey = typeof task?.ticketId === 'string' ? task.ticketId : typeof run?.ticketId === 'string' ? run.ticketId : null;
      const classified = canonicalIds.size || task && typeof task.jiraBaseUrl === 'string' && task.jiraBaseUrl || request?.mode === 'ticket' || object(snapshot?.logicalWork)?.source === 'jira';
      obligations.push({ runId, source: classified ? 'jira' : 'unknown', externalId: [...canonicalIds][0] ?? null, displayKey, evidence: persistedJson(evidence.map(item => ({ kind: item.kind, rowHash: persistenceHash(item.evidence) }))) });
    }
    const sanitized = persistedJson(Object.fromEntries(Object.entries(baseline).map(([table, entries]) => [table, entries.map(row => persistenceHash(row))]))); return { hash: persistenceHash(sanitized), obligations, baseline: sanitized };
  }
  return {
    audit(): SourceConversionAudit { return store.persistence.transaction(() => { assertMaintenanceAvailable(sql); return audit(); }); },
    convert(input: { expectedAuditHash: string; todoSourceId: string; jiraSourceId?: string | null }): SourceConversionAudit {
      return store.persistence.transaction(() => {
        assertMaintenanceAvailable(sql); const current = audit(); if (current.hash !== input.expectedAuditHash) throw new PersistenceConflictError('Legacy source ownership changed during conversion');
        const sourceIds = [input.todoSourceId, ...(input.jiraSourceId ? [input.jiraSourceId] : [])];
        for (const sourceId of sourceIds) readTaskSource(store, sourceId);
        for (const obligation of current.obligations) {
          const applicable = obligation.source === 'todos' ? [input.todoSourceId] : obligation.source === 'jira' ? input.jiraSourceId ? [input.jiraSourceId] : [] : sourceIds;
          for (const sourceId of applicable) {
            const source = readTaskSource(store, sourceId); const instance = store.instance(source.currentInstanceId); if (!instance) throw new PersistenceConflictError('Converted source has no current instance');
            const externalId = obligation.externalId ?? (obligation.source === 'jira' && obligation.displayKey ? store.alias(sourceId, obligation.displayKey) : null);
            const id = `legacy-${persistenceHash({ sourceId, runId: obligation.runId })}`;
            const existing = store.claim(id);
            if (externalId && !existing) {
              const conflict = store.activeClaim({ sourceId, externalId });
              if (!conflict) {
                const claim: WorkClaimRecord = { id, ref: { sourceId, externalId }, admissionId: id, runId: obligation.runId, instance, sourceRevision: source.revision, revision: 1, state: 'settling', taskSnapshotHash: null, receipt: null, settlement: { version: 1, claimId: id, claimRevision: 1, disposition: 'retained-for-operator', reason: 'Pre-D ownership is retained by the original execution protocol', localRecordRevision: null, operations: [] } };
                sql.prepare('INSERT INTO work_claims VALUES (?,?,?,?,?,?)').run(id, sourceId, externalId, id, claim.state, stableJson(claim));
              }
            }
            const quarantine = { id, sourceId, externalId, displayKey: externalId ? obligation.displayKey : null, reason: externalId ? 'Historical execution still owns this work item' : 'Historical Jira identity or source ownership cannot be proven', evidence: { runId: obligation.runId, auditHash: current.hash } };
            const prior = store.quarantines(sourceId).find(item => item.id === id);
            if (!prior) store.quarantine(quarantine);
          }
        }
        for (const row of rows('todos')) {
          if (typeof row.runId !== 'string' || !row.runId || row.state === 'in_progress') continue;
          const run = rows('runs').find(item => item.id === row.runId);
          if (!run || !['succeeded', 'failed', 'stopped'].includes(String(run.status))) continue;
          const id = `legacy-${persistenceHash({ sourceId: input.todoSourceId, runId: row.runId })}`;
          if (store.claim(id) || store.claims().some(claim => claim.runId === row.runId)) continue;
          const source = readTaskSource(store, input.todoSourceId); const instance = store.instance(source.currentInstanceId)!;
          const externalId = `TODO-${row.sequence}`;
          const claim: WorkClaimRecord = { id, ref: { sourceId: source.id, externalId }, admissionId: id, runId: row.runId, instance, sourceRevision: source.revision, revision: 1, state: 'settled', taskSnapshotHash: null, receipt: null,
            settlement: { version: 1, claimId: id, claimRevision: 1, disposition: 'released', reason: 'Historical local run relationship preserved without active ownership', localRecordRevision: null, operations: [] } };
          sql.prepare('INSERT INTO work_claims VALUES (?,?,?,?,?,?)').run(id, source.id, externalId, id, claim.state, stableJson(claim));
        }
        for (const sourceId of sourceIds) {
          const source = readTaskSource(store, sourceId); if (!source.conversionReady) writeTaskSource(store, { ...source, conversionReady: true, revision: source.revision + 1 });
        }
        sql.prepare('INSERT OR IGNORE INTO source_conversions VALUES (?,?)').run(persistenceHash({ auditHash: current.hash, sources: sourceIds }), stableJson({ version: 1, auditHash: current.hash, obligations: current.obligations, sources: sourceIds, pendingJira: !input.jiraSourceId && current.obligations.some(item => item.source === 'jira') }));
        return current;
      });
    },
    reconcile(input: { sourceIds: readonly string[] }): void {
      store.persistence.transaction(() => {
        const current = audit(); const active = new Set(current.obligations.map(item => item.runId));
        for (const sourceId of input.sourceIds) {
          for (const quarantine of store.quarantines(sourceId)) {
            if (!quarantine.id.startsWith('legacy-')) continue;
            const evidence = object(quarantine.evidence); if (typeof evidence?.runId !== 'string' || active.has(evidence.runId)) continue;
            const claim = store.claim(quarantine.id);
            if (claim && claim.state !== 'settled') store.settleWork({ claimId: claim.id, expectedRevision: claim.revision, disposition: 'released', reason: 'Original execution protocol has no retained ownership obligation', localRecordRevision: null, operations: [] });
            sql.prepare('DELETE FROM source_quarantines WHERE id=?').run(quarantine.id);
          }
        }
      });
    },
  };
}
