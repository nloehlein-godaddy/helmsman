import { randomUUID } from 'node:crypto';
import type { PluginJson } from '../../../src/plugins/backend';
import { parseSourceBindingV1, parseSourceClaimReceiptV1, parseSourceSettlementReceiptV1, parseSourceIdentityEvidenceV1, parseSourceInstanceV1, parseTaskSnapshotV1, parseWorkRefV1, type SourceBindingV1, type SourceIdentityEvidenceV1, type SourceInstanceV1, type SourceClaimReceiptV1, type SourceSettlementReceiptV1, type TaskSnapshotV1, type WorkRefV1 } from '../../../src/plugins/tasks';
import { migrateOwned, validateTableColumns } from '../migrations';
import { type Persistence, persistedJson, persistenceHash, stableJson, PersistenceConflictError, PersistenceValidationError } from '../persistence';

export interface TaskSourceRecord {
  readonly id: string;
  readonly provisioningKey: string;
  readonly revision: number;
  readonly currentInstanceId: string;
  readonly identityEvidence: SourceIdentityEvidenceV1;
  readonly storageLayout: 'legacy-todos' | 'documents' | 'remote';
  readonly collectionId: string | null;
  readonly collectionRevision: number;
  readonly conversionReady: boolean;
}
export interface WorkClaimRecord {
  readonly id: string;
  readonly ref: WorkRefV1;
  readonly admissionId: string;
  readonly runId: string;
  readonly instance: SourceInstanceV1;
  readonly sourceRevision: number;
  readonly retryOf?: string | null;
  readonly revision: number;
  readonly state: 'reserved' | 'claimed' | 'settling' | 'settled';
  readonly taskSnapshotHash: string | null;
  readonly receipt: SourceClaimReceiptV1 | null;
  readonly settlement: SourceSettlementReceiptV1 | null;
}
export interface SourceQuarantine {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string | null;
  readonly displayKey: string | null;
  readonly reason: string;
  readonly evidence: PluginJson;
}
export interface StoredTaskSnapshot { readonly hash: string; readonly task: TaskSnapshotV1; readonly instance: SourceInstanceV1 }
export interface TaskSourceStore {
  readonly persistence: Persistence;
  sources(): TaskSourceRecord[];
  source(id: string): TaskSourceRecord | null;
  instances(sourceId?: string): SourceInstanceV1[];
  instance(id: string): SourceInstanceV1 | null;
  provision(input: { provisioningKey: string; label: string; identityEvidence: SourceIdentityEvidenceV1; storageLayout: TaskSourceRecord['storageLayout']; binding: SourceBindingV1; settings: Readonly<Record<string, PluginJson>>; allowedRepos: readonly string[]; desiredEnabled?: boolean; collectionId?: string; distinctUnverifiedSource?: boolean }): { source: TaskSourceRecord; instance: SourceInstanceV1 };
  configureInstance(input: { instanceId: string; expectedRevision: number; label?: string; desiredEnabled?: boolean; settings?: Readonly<Record<string, PluginJson>>; allowedRepos?: readonly string[] }): SourceInstanceV1;
  recordAlias(input: { sourceId: string; displayKey: string; externalId: string; evidence: PluginJson }): void;
  alias(sourceId: string, displayKey: string): string | null;
  retainTaskSnapshot(task: TaskSnapshotV1, instance: SourceInstanceV1): StoredTaskSnapshot;
  taskSnapshot(hash: string): StoredTaskSnapshot | null;
  reserveWork(input: { ref: WorkRefV1; admissionId: string; runId: string; instanceId: string; expectedSourceRevision: number; expectedInstanceRevision: number; retryOf?: string | null; displayKey?: string }): WorkClaimRecord;
  claim(id: string): WorkClaimRecord | null;
  activeClaim(ref: WorkRefV1): WorkClaimRecord | null;
  latestClaim(ref: WorkRefV1): WorkClaimRecord | null;
  claims(): WorkClaimRecord[];
  acknowledgeClaim(input: { claimId: string; expectedRevision: number; taskSnapshotHash: string; localRecordRevision: string | null; operations: SourceClaimReceiptV1['operations'] }): WorkClaimRecord;
  beginSettlement(claimId: string, expectedRevision: number): WorkClaimRecord;
  settleWork(input: { claimId: string; expectedRevision: number; disposition: SourceSettlementReceiptV1['disposition']; reason: string; localRecordRevision: string | null; operations: SourceSettlementReceiptV1['operations'] }): WorkClaimRecord;
  quarantine(input: Omit<SourceQuarantine, 'id'> & { id?: string }): SourceQuarantine;
  quarantines(sourceId: string): SourceQuarantine[];
  assertUnquarantined(ref: WorkRefV1, displayKey?: string): void;
}
const tables = ['task_sources', 'task_source_instances', 'source_provisioning', 'source_aliases', 'source_task_snapshots', 'work_claims', 'source_quarantines', 'source_documents', 'source_commands', 'source_settlements', 'source_adoption_validations', 'source_adoptions', 'source_conversions', 'source_effect_plans'] as const;
const schema = `
CREATE TABLE task_sources (id TEXT PRIMARY KEY, authorityKey TEXT UNIQUE, json TEXT NOT NULL);
CREATE TABLE task_source_instances (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES task_sources(id), json TEXT NOT NULL);
CREATE TABLE source_provisioning (key TEXT PRIMARY KEY, sourceId TEXT NOT NULL, instanceId TEXT NOT NULL, identityHash TEXT NOT NULL);
CREATE TABLE source_aliases (sourceId TEXT NOT NULL, displayKey TEXT NOT NULL, externalId TEXT NOT NULL, revision INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(sourceId,displayKey));
CREATE TABLE source_task_snapshots (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE work_claims (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, externalId TEXT NOT NULL, admissionId TEXT NOT NULL UNIQUE, state TEXT NOT NULL, json TEXT NOT NULL);
CREATE UNIQUE INDEX active_source_work ON work_claims(sourceId,externalId) WHERE state != 'settled';
CREATE TABLE source_quarantines (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE source_documents (sourceId TEXT NOT NULL, externalId TEXT NOT NULL, repo TEXT NOT NULL, revision INTEGER NOT NULL, schema TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(sourceId,externalId));
CREATE TABLE source_commands (id TEXT PRIMARY KEY, inputHash TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE source_settlements (id TEXT PRIMARY KEY, inputHash TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE source_adoption_validations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE source_adoptions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE source_conversions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE source_effect_plans (id TEXT PRIMARY KEY, json TEXT NOT NULL);
`;
function text(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new PersistenceValidationError(`Invalid ${label}`); }
function decode<T>(row: { json: string } | undefined): T | null { return row ? persistedJson(JSON.parse(row.json)) as unknown as T : null; }
function validRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
function sourceValue(input: unknown): TaskSourceRecord {
  const value = persistedJson(input) as unknown as TaskSourceRecord;
  if (!value) throw new PersistenceValidationError('Invalid task source record');
  parseWorkRefV1({ sourceId: value.id, externalId: value.currentInstanceId }); text(value.provisioningKey, 'source provisioning key');
  parseSourceIdentityEvidenceV1(value.identityEvidence);
  if (!validRevision(value.revision) || !validRevision(value.collectionRevision) || typeof value.conversionReady !== 'boolean' || !['legacy-todos', 'documents', 'remote'].includes(value.storageLayout)
    || value.storageLayout === 'remote' && value.collectionId !== null || value.storageLayout !== 'remote' && (typeof value.collectionId !== 'string' || !value.collectionId)) throw new PersistenceValidationError('Invalid task source record');
  return value;
}
function claimValue(input: unknown): WorkClaimRecord {
  const value = persistedJson(input) as unknown as WorkClaimRecord;
  if (!value) throw new PersistenceValidationError('Invalid source work claim');
  text(value.id, 'claim ID'); text(value.admissionId, 'admission ID'); text(value.runId, 'claim run ID'); if (value.retryOf !== undefined && value.retryOf !== null) text(value.retryOf, 'retry owner');
  parseWorkRefV1(value.ref); parseSourceInstanceV1(value.instance);
  if (value.instance.sourceId !== value.ref.sourceId || !validRevision(value.revision) || !validRevision(value.sourceRevision) || !['reserved', 'claimed', 'settling', 'settled'].includes(value.state)
    || value.taskSnapshotHash !== null && !/^[a-f\d]{64}$/.test(value.taskSnapshotHash) || value.state === 'claimed' && !value.receipt || value.state === 'settled' && (!value.settlement || value.settlement.disposition === 'retained-for-operator')) throw new PersistenceValidationError('Invalid source work claim');
  if (value.receipt) {
    const receipt = parseSourceClaimReceiptV1(value.receipt);
    if (receipt.version !== 1 || receipt.claimId !== value.id || receipt.admissionId !== value.admissionId || receipt.runId !== value.runId || receipt.taskSnapshotHash !== value.taskSnapshotHash || stableJson(receipt.ref) !== stableJson(value.ref) || stableJson(receipt.binding) !== stableJson(value.instance.binding) || !validRevision(receipt.revision) || receipt.revision > value.revision || !Array.isArray(receipt.operations)) throw new PersistenceValidationError('Invalid source claim receipt');
  }
  if (value.settlement) parseSourceSettlementReceiptV1(value.settlement);
  if (value.settlement && (value.settlement.version !== 1 || value.settlement.claimId !== value.id || !validRevision(value.settlement.claimRevision) || value.settlement.claimRevision > value.revision || !['released', 'completed', 'retained-for-operator'].includes(value.settlement.disposition))) throw new PersistenceValidationError('Invalid source settlement receipt');
  return value;
}
export function readTaskSource(store: TaskSourceStore, id: string): TaskSourceRecord { const source = store.source(id); if (!source) throw new PersistenceConflictError('Unknown task source'); return source; }
export function writeTaskSource(store: TaskSourceStore, source: TaskSourceRecord): void {
  const result = store.persistence.sql.prepare('UPDATE task_sources SET json=? WHERE id=?').run(stableJson(sourceValue(source)), source.id);
  if (!result.changes) throw new PersistenceConflictError('Unknown task source');
}
export function openTaskSourceStore(persistence: Persistence): TaskSourceStore {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.task-sources', version: 1, checksum: persistenceHash(schema), tables,
    validateLegacy: () => null,
    apply: database => database.exec(schema),
    validateCurrent(database) { for (const table of tables) validateTableColumns(database, table, table === 'source_documents' ? ['sourceId', 'externalId', 'repo', 'revision', 'schema', 'data'] : table === 'source_aliases' ? ['sourceId', 'displayKey', 'externalId', 'revision', 'evidence'] : table === 'source_provisioning' ? ['key', 'sourceId', 'instanceId', 'identityHash'] : ['json']); },
  });
  const source = (id: string) => { const found = decode<TaskSourceRecord>(sql.prepare('SELECT json FROM task_sources WHERE id=?').get(id) as { json: string } | undefined); if (!found) return null; const parsed = sourceValue(found); if (parsed.id !== id) throw new PersistenceValidationError('Source identity integrity failed'); return parsed; };
  const instance = (id: string) => { const found = decode<SourceInstanceV1>(sql.prepare('SELECT json FROM task_source_instances WHERE id=?').get(id) as { json: string } | undefined); return found ? parseSourceInstanceV1(found) : null; };
  const claim = (id: string) => { const row = sql.prepare('SELECT * FROM work_claims WHERE id=?').get(id) as { id: string; sourceId: string; externalId: string; admissionId: string; state: string; json: string } | undefined; if (!row) return null; const value = claimValue(JSON.parse(row.json)); if (value.id !== row.id || value.ref.sourceId !== row.sourceId || value.ref.externalId !== row.externalId || value.admissionId !== row.admissionId || value.state !== row.state) throw new PersistenceValidationError('Source work claim integrity failed'); return value; };
  const saveClaim = (value: WorkClaimRecord) => { sql.prepare('UPDATE work_claims SET state=?,json=? WHERE id=?').run(value.state, stableJson(claimValue(value)), value.id); return value; };
  function checkedClaim(id: string, revision: number): WorkClaimRecord { const value = claim(id); if (!value || value.revision !== revision) throw new PersistenceConflictError('Source claim revision changed'); return value; }
  const store: TaskSourceStore = {
    persistence, source, instance, claim,
    sources() { return (sql.prepare('SELECT json FROM task_sources ORDER BY id').all() as { json: string }[]).map(row => sourceValue(decode<TaskSourceRecord>(row))); },
    instances(sourceId) { return (sourceId ? sql.prepare('SELECT json FROM task_source_instances WHERE sourceId=? ORDER BY id').all(sourceId) : sql.prepare('SELECT json FROM task_source_instances ORDER BY id').all()).map(row => parseSourceInstanceV1(decode(row as { json: string }))); },
    provision(input) { return persistence.transaction(() => {
      text(input.provisioningKey, 'provisioning key'); const evidence = parseSourceIdentityEvidenceV1(input.identityEvidence); const binding = parseSourceBindingV1(input.binding);
      if (!['legacy-todos', 'documents', 'remote'].includes(input.storageLayout)) throw new PersistenceValidationError('Invalid source storage layout');
      const identityHash = persistenceHash({ authority: evidence.authority, level: evidence.level, binding: { connectionId: binding.connectionId, credentialHandle: binding.credentialHandle }, storageLayout: input.storageLayout });
      const prior = sql.prepare('SELECT sourceId,instanceId,identityHash FROM source_provisioning WHERE key=?').get(input.provisioningKey) as { sourceId: string; instanceId: string; identityHash: string } | undefined;
      if (prior) { if (prior.identityHash !== identityHash) throw new PersistenceConflictError('Provisioned source identity changed'); return { source: readTaskSource(store, prior.sourceId), instance: instance(prior.instanceId)! }; }
      const authorityKey = evidence.level === 'verified' ? persistenceHash(evidence.authority) : null;
      const existing = authorityKey ? decode<TaskSourceRecord>(sql.prepare('SELECT json FROM task_sources WHERE authorityKey=?').get(authorityKey) as { json: string } | undefined) : null;
      if (existing && existing.storageLayout !== input.storageLayout) throw new PersistenceConflictError('Verified source storage layout differs');
      if (!authorityKey && !input.distinctUnverifiedSource && store.sources().some(item => item.identityEvidence.level === 'operator-seeded')) throw new PersistenceConflictError('An additional unverified source requires an explicit distinct-source decision');
      const sourceId = existing?.id ?? randomUUID(); const instanceId = randomUUID();
      const nextInstance = parseSourceInstanceV1({ version: 1, id: instanceId, sourceId, label: input.label, revision: 1, desiredEnabled: input.desiredEnabled ?? true, identityLevel: evidence.level, authority: evidence.authority, binding, settings: input.settings, allowedRepos: input.allowedRepos });
      const nextSource: TaskSourceRecord = existing ?? { id: sourceId, provisioningKey: input.provisioningKey, revision: 1, currentInstanceId: instanceId, identityEvidence: evidence, storageLayout: input.storageLayout, collectionId: input.storageLayout === 'remote' ? null : input.collectionId ?? (evidence.authority?.protocol === 'helmsman.local-collection/v1' ? evidence.authority.authorityId : randomUUID()), collectionRevision: 1, conversionReady: false };
      if (nextSource.storageLayout !== 'remote' && nextSource.identityEvidence.authority?.protocol === 'helmsman.local-collection/v1' && nextSource.collectionId !== nextSource.identityEvidence.authority.authorityId) throw new PersistenceConflictError('Local collection identity evidence differs from its storage identity');
      if (!existing) sql.prepare('INSERT INTO task_sources VALUES (?,?,?)').run(sourceId, authorityKey, stableJson(sourceValue(nextSource)));
      sql.prepare('INSERT INTO task_source_instances VALUES (?,?,?)').run(instanceId, sourceId, stableJson(nextInstance));
      sql.prepare('INSERT INTO source_provisioning VALUES (?,?,?,?)').run(input.provisioningKey, sourceId, instanceId, identityHash);
      return { source: nextSource, instance: nextInstance };
    }); },
    configureInstance(input) { return persistence.transaction(() => {
      const prior = instance(input.instanceId); if (!prior || prior.revision !== input.expectedRevision) throw new PersistenceConflictError('Source instance revision changed');
      const next = parseSourceInstanceV1({ ...prior, ...(input.label === undefined ? {} : { label: input.label }), ...(input.desiredEnabled === undefined ? {} : { desiredEnabled: input.desiredEnabled }), ...(input.settings === undefined ? {} : { settings: input.settings }), ...(input.allowedRepos === undefined ? {} : { allowedRepos: input.allowedRepos }), revision: prior.revision + 1 });
      sql.prepare('UPDATE task_source_instances SET json=? WHERE id=?').run(stableJson(next), next.id); return next;
    }); },
    recordAlias(input) { persistence.transaction(() => {
      readTaskSource(store, input.sourceId); parseWorkRefV1({ sourceId: input.sourceId, externalId: input.externalId }); text(input.displayKey, 'display key');
      const previous = sql.prepare('SELECT externalId,revision FROM source_aliases WHERE sourceId=? AND displayKey=?').get(input.sourceId, input.displayKey) as { externalId: string; revision: number } | undefined;
      if (previous && previous.externalId !== input.externalId) throw new PersistenceConflictError('Source alias points to another immutable item');
      sql.prepare('INSERT INTO source_aliases VALUES (?,?,?,?,?) ON CONFLICT(sourceId,displayKey) DO UPDATE SET revision=excluded.revision,evidence=excluded.evidence').run(input.sourceId, input.displayKey, input.externalId, (previous?.revision ?? 0) + 1, stableJson(input.evidence));
    }); },
    alias(sourceId, displayKey) { return (sql.prepare('SELECT externalId FROM source_aliases WHERE sourceId=? AND displayKey=?').get(sourceId, displayKey) as { externalId: string } | undefined)?.externalId ?? null; },
    retainTaskSnapshot(input, inputInstance) { return persistence.transaction(() => {
      const pinned = parseSourceInstanceV1(inputInstance); const task = parseTaskSnapshotV1(input, { sourceId: pinned.sourceId });
      if (!pinned.allowedRepos.includes(task.repo)) throw new PersistenceConflictError('Source task galleon is not authorized');
      const content = { task, instance: pinned }; const hash = persistenceHash(content);
      sql.prepare('INSERT OR IGNORE INTO source_task_snapshots VALUES (?,?)').run(hash, stableJson(content)); return { hash, ...content };
    }); },
    taskSnapshot(hash) {
      const value = decode<{ task: TaskSnapshotV1; instance: SourceInstanceV1 }>(sql.prepare('SELECT json FROM source_task_snapshots WHERE hash=?').get(hash) as { json: string } | undefined);
      if (!value) return null; if (persistenceHash(value) !== hash) throw new PersistenceValidationError('Task snapshot integrity failed');
      return { hash, task: parseTaskSnapshotV1(value.task, { sourceId: value.instance?.sourceId }), instance: parseSourceInstanceV1(value.instance) };
    },
    reserveWork(input) { return persistence.transaction(() => {
      const ref = parseWorkRefV1(input.ref); text(input.admissionId, 'admission ID'); text(input.runId, 'run ID');
      const prior = decode<WorkClaimRecord>(sql.prepare('SELECT json FROM work_claims WHERE admissionId=?').get(input.admissionId) as { json: string } | undefined);
      if (prior) { if (prior.ref.sourceId !== ref.sourceId || prior.ref.externalId !== ref.externalId || prior.runId !== input.runId || prior.instance.id !== input.instanceId || (prior.retryOf ?? null) !== (input.retryOf ?? null)) throw new PersistenceConflictError('Admission source identity changed'); return prior; }
      const sourceRecord = readTaskSource(store, ref.sourceId); const sourceInstance = instance(input.instanceId);
      if (!sourceRecord.conversionReady) throw new PersistenceConflictError('Task source ownership conversion is incomplete');
      if (!sourceInstance || sourceInstance.sourceId !== ref.sourceId || !sourceInstance.desiredEnabled || sourceInstance.revision !== input.expectedInstanceRevision || sourceRecord.revision !== input.expectedSourceRevision) throw new PersistenceConflictError('Task source selection changed');
      const selected = instance(sourceRecord.currentInstanceId);
      if (!selected || selected.binding.providerId !== sourceInstance.binding.providerId || selected.binding.pluginId !== sourceInstance.binding.pluginId || selected.binding.artifactHash !== sourceInstance.binding.artifactHash) throw new PersistenceConflictError('Task source instance conflicts with current binding');
      store.assertUnquarantined(ref, input.displayKey);
      if (store.activeClaim(ref)) throw new PersistenceConflictError('Work is already reserved');
      const previous = store.latestClaim(ref); if (input.retryOf && previous?.runId !== input.retryOf) throw new PersistenceConflictError('Source retry owner changed');
      const value: WorkClaimRecord = { id: randomUUID(), ref, admissionId: input.admissionId, runId: input.runId, instance: sourceInstance, sourceRevision: sourceRecord.revision, retryOf: input.retryOf ?? null, revision: 1, state: 'reserved', taskSnapshotHash: null, receipt: null, settlement: null };
      sql.prepare('INSERT INTO work_claims VALUES (?,?,?,?,?,?)').run(value.id, ref.sourceId, ref.externalId, value.admissionId, value.state, stableJson(value)); return value;
    }); },
    activeClaim(ref) { parseWorkRefV1(ref); const row = sql.prepare("SELECT id FROM work_claims WHERE sourceId=? AND externalId=? AND state!='settled'").get(ref.sourceId, ref.externalId) as { id: string } | undefined; return row ? claim(row.id) : null; },
    latestClaim(ref) { parseWorkRefV1(ref); const row = sql.prepare('SELECT id FROM work_claims WHERE sourceId=? AND externalId=? ORDER BY rowid DESC LIMIT 1').get(ref.sourceId, ref.externalId) as { id: string } | undefined; return row ? claim(row.id) : null; },
    claims() { return (sql.prepare('SELECT json FROM work_claims ORDER BY rowid').all() as { json: string }[]).map(row => claimValue(decode<WorkClaimRecord>(row))); },
    acknowledgeClaim(input) { return persistence.transaction(() => {
      const prior = checkedClaim(input.claimId, input.expectedRevision); const snapshot = store.taskSnapshot(input.taskSnapshotHash);
      if (prior.state !== 'reserved' || !snapshot || snapshot.task.ref.sourceId !== prior.ref.sourceId || snapshot.task.ref.externalId !== prior.ref.externalId || stableJson(snapshot.instance) !== stableJson(prior.instance)) throw new PersistenceConflictError('Source claim preparation changed');
      const revision = prior.revision + 1; const receipt: SourceClaimReceiptV1 = { version: 1, claimId: prior.id, ref: prior.ref, admissionId: prior.admissionId, runId: prior.runId, revision, binding: prior.instance.binding, taskSnapshotHash: snapshot.hash, localRecordRevision: input.localRecordRevision, operations: input.operations };
      return saveClaim({ ...prior, revision, state: 'claimed', taskSnapshotHash: snapshot.hash, receipt });
    }); },
    beginSettlement(claimId, expectedRevision) { return persistence.transaction(() => {
      const prior = checkedClaim(claimId, expectedRevision); if (prior.state === 'settled') throw new PersistenceConflictError('Source claim is already settled');
      return prior.state === 'settling' ? prior : saveClaim({ ...prior, state: 'settling', revision: prior.revision + 1 });
    }); },
    settleWork(input) { return persistence.transaction(() => {
      const prior = checkedClaim(input.claimId, input.expectedRevision); if (prior.state !== 'settling') throw new PersistenceConflictError('Source settlement was not prepared');
      if (!['released', 'completed', 'retained-for-operator'].includes(input.disposition)) throw new PersistenceValidationError('Invalid source settlement disposition'); text(input.reason, 'settlement reason');
      const revision = prior.revision + 1;
      const settlement: SourceSettlementReceiptV1 = { version: 1, claimId: prior.id, claimRevision: revision, disposition: input.disposition, reason: input.reason, localRecordRevision: input.localRecordRevision, operations: input.operations };
      return saveClaim({ ...prior, revision, state: input.disposition === 'retained-for-operator' ? 'settling' : 'settled', settlement });
    }); },
    quarantine(input) { return persistence.transaction(() => {
      readTaskSource(store, input.sourceId); text(input.reason, 'quarantine reason');
      if (input.externalId !== null) parseWorkRefV1({ sourceId: input.sourceId, externalId: input.externalId }); if (input.displayKey !== null) text(input.displayKey, 'quarantine display key');
      const value: SourceQuarantine = { ...input, id: input.id ?? randomUUID() }; const previous = decode<SourceQuarantine>(sql.prepare('SELECT json FROM source_quarantines WHERE id=?').get(value.id) as { json: string } | undefined);
      if (previous && stableJson(previous) !== stableJson(value)) throw new PersistenceConflictError('Source quarantine evidence changed');
      sql.prepare('INSERT OR IGNORE INTO source_quarantines VALUES (?,?,?)').run(value.id, value.sourceId, stableJson(value)); return value;
    }); },
    quarantines(sourceId) { return (sql.prepare('SELECT json FROM source_quarantines WHERE sourceId=? ORDER BY id').all(sourceId) as { json: string }[]).map(row => decode<SourceQuarantine>(row)!); },
    assertUnquarantined(ref, displayKey) {
      const aliases = (sql.prepare('SELECT displayKey FROM source_aliases WHERE sourceId=? AND externalId=?').all(ref.sourceId, ref.externalId) as { displayKey: string }[]).map(row => row.displayKey);
      if (store.quarantines(ref.sourceId).some(item => item.externalId === ref.externalId || item.externalId === null && item.displayKey === null || item.displayKey !== null && (item.displayKey === displayKey || aliases.includes(item.displayKey)))) throw new PersistenceConflictError('Historical source ownership is quarantined');
    },
  };
  return store;
}
