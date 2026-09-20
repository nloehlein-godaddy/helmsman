import type { PluginJson } from '../../../src/plugins/backend';
import { createExecutionSnapshot, validateExecutionSnapshot, type ArtifactBinding, type ExecutionCheckpoint, type ExecutionSnapshot, type ExecutionSnapshotInput, type ExecutionStore, type ProviderBinding, type RecoveryDiagnostic } from '../execution-store';
import { assertSchemaRanges, migrateOwned, validateTableColumns, type SchemaRange } from '../migrations';
import { pendingPersistenceIntents, persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, writePersistenceIntent, type Persistence } from '../persistence';

export interface LifecycleChange {
  id: string;
  pluginId: string;
  expectedRevision: number;
  desiredEnabled: boolean;
  artifactHash: string;
  drainDependents: readonly string[];
}
export interface LifecycleBlocker { kind: 'consumer' | 'execution' | 'checkpoint' | 'operation' | 'schema'; ownerId: string; reason: string }
export interface LifecycleArtifact { artifact: ArtifactBinding; schemas: readonly SchemaRange[] }
export interface PluginLifecycleRecord {
  pluginId: string;
  artifactHash: string;
  desiredEnabled: boolean;
  health: 'inactive' | 'active' | 'failed';
  diagnostic: RecoveryDiagnostic | null;
  revision: number;
  state: 'installed' | 'active' | 'draining' | 'disabled' | 'failed';
  obligationsOnly: boolean;
}
export interface CheckpointMigrationValidation {
  checkpointId: string;
  expectedSnapshotId: string;
  next: ExecutionSnapshotInput;
  provider: ProviderBinding;
}
export interface CheckpointMigrationValidator {
  provider: ProviderBinding;
  validate(input: { checkpoint: ExecutionCheckpoint; previous: ExecutionSnapshot; next: ExecutionSnapshotInput }): Promise<PluginJson | null>;
}
export interface PluginLifecycle {
  registerArtifact(artifact: LifecycleArtifact): void;
  list(): readonly PluginLifecycleRecord[];
  recordHealth(pluginId: string, artifactHash: string, health: PluginLifecycleRecord['health'], diagnostic: RecoveryDiagnostic | null): void;
  assertAdmission(snapshot: ExecutionSnapshotInput): void;
  assertObligation(snapshot: ExecutionSnapshotInput): void;
  plan(change: LifecycleChange): { blockers: readonly LifecycleBlocker[] };
  apply(change: LifecycleChange): void;
  uninstall(pluginId: string, expectedRevision: number, changeId: string): void;
  canCollect(pluginId: string, artifactHash: string): { allowed: boolean; blockers: readonly LifecycleBlocker[] };
  validateCheckpointMigration(input: CheckpointMigrationValidation): Promise<{ validationId: string; receipt: PluginJson }>;
  migrateCheckpoint(input: {
    checkpointId: string;
    expectedSnapshotId: string;
    next: ExecutionSnapshotInput;
    validation: { provider: ProviderBinding; receipt: PluginJson; validationId: string };
    actor: string;
    reason: string;
  }): void;
}

const HASH = /^[a-f\d]{64}$/;
const ID = /^[a-z\d][a-z\d_.:/@-]{0,255}$/i;
const DDL = `
  CREATE TABLE plugin_artifacts (pluginId TEXT NOT NULL,artifactHash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(pluginId,artifactHash));
  CREATE TABLE plugin_lifecycle (pluginId TEXT PRIMARY KEY,artifactHash TEXT NOT NULL,desiredEnabled INTEGER NOT NULL,health TEXT NOT NULL,diagnostic TEXT,revision INTEGER NOT NULL);
  CREATE TABLE binding_migrations (id TEXT PRIMARY KEY,checkpointId TEXT NOT NULL,oldSnapshotId TEXT NOT NULL,newSnapshotId TEXT NOT NULL,validationId TEXT NOT NULL UNIQUE,actor TEXT NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL);
  CREATE TABLE checkpoint_migration_validations (id TEXT PRIMARY KEY,checkpointId TEXT NOT NULL,oldSnapshotId TEXT NOT NULL,newSnapshotHash TEXT NOT NULL,provider TEXT NOT NULL,receipt TEXT NOT NULL,checkpointHash TEXT NOT NULL);
  CREATE TABLE plugin_lifecycle_tombstones (pluginId TEXT PRIMARY KEY,revision INTEGER NOT NULL);
`;
const TABLES = {
  plugin_artifacts: ['pluginId', 'artifactHash', 'json'],
  plugin_lifecycle: ['pluginId', 'artifactHash', 'desiredEnabled', 'health', 'diagnostic', 'revision'],
  binding_migrations: ['id', 'checkpointId', 'oldSnapshotId', 'newSnapshotId', 'validationId', 'actor', 'reason', 'createdAt'],
  checkpoint_migration_validations: ['id', 'checkpointId', 'oldSnapshotId', 'newSnapshotHash', 'provider', 'receipt', 'checkpointHash'],
  plugin_lifecycle_tombstones: ['pluginId', 'revision'],
};
interface Row { pluginId: string; artifactHash: string; desiredEnabled: number; health: PluginLifecycleRecord['health']; diagnostic: string | null; revision: number }

export function openPluginLifecycle(persistence: Persistence, executions: ExecutionStore, validators: readonly CheckpointMigrationValidator[] = []): PluginLifecycle {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.plugins.lifecycle', version: 1, checksum: persistenceHash(DDL), tables: Object.keys(TABLES),
    validateLegacy: () => null, apply: () => sql.exec(DDL), validateCurrent: () => {
      for (const [table, columns] of Object.entries(TABLES)) validateTableColumns(sql, table, columns);
    },
  });
  function artifact(pluginId: string, artifactHash: string): LifecycleArtifact | null {
    const row = sql.prepare('SELECT json FROM plugin_artifacts WHERE pluginId=? AND artifactHash=?').get(pluginId, artifactHash) as { json: string } | undefined;
    if (!row) return null;
    const result = persistedJson(JSON.parse(row.json)) as unknown as LifecycleArtifact;
    validateArtifact(result);
    if (result.artifact.pluginId !== pluginId || result.artifact.artifactHash !== artifactHash) throw new PersistenceValidationError('Installed artifact identity mismatch');
    return result;
  }
  function validateArtifact(value: LifecycleArtifact): void {
    if (!value?.artifact || !ID.test(value.artifact.pluginId) || !HASH.test(value.artifact.artifactHash)
      || typeof value.artifact.packageVersion !== 'string' || !value.artifact.packageVersion
      || !Array.isArray(value.artifact.requires) || value.artifact.requires.some(id => typeof id !== 'string' || !ID.test(id) || id === value.artifact.pluginId)
      || new Set(value.artifact.requires).size !== value.artifact.requires.length || !Array.isArray(value.schemas)
      || value.schemas.some(range => !range?.owner || !Number.isSafeInteger(range.minimum) || !Number.isSafeInteger(range.maximum) || range.minimum < 0 || range.maximum < range.minimum)) throw new PersistenceValidationError('Invalid installed lifecycle artifact');
  }
  function current(pluginId: string): Row | null {
    const row = sql.prepare('SELECT * FROM plugin_lifecycle WHERE pluginId=?').get(pluginId) as Row | undefined;
    if (!row) return null;
    if (!ID.test(row.pluginId) || !HASH.test(row.artifactHash) || ![0, 1].includes(row.desiredEnabled) || !['inactive', 'active', 'failed'].includes(row.health)
      || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new PersistenceValidationError('Invalid plugin lifecycle state');
    return row;
  }
  function record(row: Row): PluginLifecycleRecord {
    const pins = executions.pins(row.pluginId);
    const desiredEnabled = row.desiredEnabled === 1;
    const state = row.health === 'failed' ? 'failed' : !desiredEnabled && pins.length ? 'draining'
      : !desiredEnabled ? row.revision === 0 ? 'installed' : 'disabled' : row.health === 'active' ? 'active' : 'installed';
    return { ...row, desiredEnabled, state, obligationsOnly: !desiredEnabled && pins.length > 0,
      diagnostic: row.diagnostic ? persistedJson(JSON.parse(row.diagnostic)) as unknown as RecoveryDiagnostic : null };
  }
  function pending(pluginId: string): boolean { return pendingPersistenceIntents(persistence).some(intent => intent.owner === `plugin:${pluginId}`); }
  function changeValid(change: LifecycleChange): Row {
    if (!change || !ID.test(change.id) || !ID.test(change.pluginId) || !HASH.test(change.artifactHash) || typeof change.desiredEnabled !== 'boolean'
      || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0 || !Array.isArray(change.drainDependents)
      || change.drainDependents.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(change.drainDependents).size !== change.drainDependents.length) throw new PersistenceValidationError('Invalid plugin lifecycle change');
    const row = current(change.pluginId);
    if (!row || !artifact(change.pluginId, change.artifactHash)) throw new PersistenceConflictError('Requested plugin artifact is not installed');
    if (row.revision !== change.expectedRevision) throw new PersistenceConflictError('Plugin lifecycle revision changed');
    return row;
  }
  function affectedDependents(pluginId: string): string[] {
    const records = (sql.prepare('SELECT pluginId FROM plugin_lifecycle').all() as Array<{ pluginId: string }>).map(row => current(row.pluginId)!);
    const affected = new Set<string>([pluginId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of records) {
        if (affected.has(row.pluginId) || !row.desiredEnabled) continue;
        if (artifact(row.pluginId, row.artifactHash)?.artifact.requires.some(id => affected.has(id))) { affected.add(row.pluginId); changed = true; }
      }
    }
    affected.delete(pluginId);
    return [...affected].sort();
  }
  function pinBlockers(pluginId: string, nextHash?: string): LifecycleBlocker[] {
    return executions.pins(pluginId).filter(pin => nextHash === undefined || pin.artifactHash !== nextHash).map(pin => ({
      kind: pin.kind === 'dependency' ? 'consumer' : pin.kind === 'admission' ? 'execution' : pin.kind, ownerId: pin.ownerId, reason: `Retained ${pin.kind} requires ${pin.artifactHash}`,
    }));
  }
  function plan(change: LifecycleChange): { blockers: readonly LifecycleBlocker[] } {
    const row = changeValid(change);
    const blockers: LifecycleBlocker[] = [];
    const requested = artifact(change.pluginId, change.artifactHash)!;
    if (row.artifactHash !== change.artifactHash) {
      blockers.push(...pinBlockers(change.pluginId, change.artifactHash));
      if (row.health === 'active') blockers.push({ kind: 'consumer', ownerId: change.pluginId, reason: 'Deactivate the loaded artifact before selecting another version' });
    }
    if (!change.desiredEnabled) {
      for (const dependent of affectedDependents(change.pluginId)) if (!change.drainDependents.includes(dependent)) blockers.push({ kind: 'consumer', ownerId: dependent, reason: 'Required dependent must be explicitly drained' });
    } else {
      for (const dependency of requested.artifact.requires) {
        const installed = current(dependency);
        if (!installed?.desiredEnabled || installed.health !== 'active' || pending(dependency)) blockers.push({ kind: 'consumer', ownerId: dependency, reason: 'Required provider is not active for new work' });
      }
      try { assertSchemaRanges(sql, requested.schemas); } catch (error) { blockers.push({ kind: 'schema', ownerId: change.pluginId, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { blockers };
  }
  function saveChange(row: Row, change: Pick<LifecycleChange, 'id' | 'desiredEnabled' | 'artifactHash'>): void {
    const revision = row.revision + 1;
    sql.prepare('UPDATE plugin_lifecycle SET artifactHash=?,desiredEnabled=?,health=?,diagnostic=?,revision=? WHERE pluginId=?').run(
      change.artifactHash, Number(change.desiredEnabled), row.artifactHash === change.artifactHash ? row.health : 'inactive', row.artifactHash === change.artifactHash ? row.diagnostic : null, revision, row.pluginId,
    );
    writePersistenceIntent(persistence, { id: change.id, owner: `plugin:${row.pluginId}`, revision,
      payload: { pluginId: row.pluginId, artifactHash: change.artifactHash, desiredEnabled: change.desiredEnabled }, targets: ['catalog', 'plugin-data'] });
  }
  function assertBound(input: ExecutionSnapshotInput, admission: boolean): void {
    const snapshot = validateExecutionSnapshot(input);
    assertSchemaRanges(sql, snapshot.schemas);
    for (const binding of snapshot.artifacts) {
      const row = current(binding.pluginId);
      const installed = artifact(binding.pluginId, binding.artifactHash);
      if (!row || !installed || row.artifactHash !== binding.artifactHash || row.health !== 'active'
        || stableJson(installed.artifact) !== stableJson(binding)) throw new PersistenceConflictError(`Pinned plugin artifact is unavailable: ${binding.pluginId}`);
      if (admission && (!row.desiredEnabled || pending(row.pluginId))) throw new PersistenceConflictError(`Plugin denies new admissions: ${row.pluginId}`);
      if (!admission && !executions.pins(row.pluginId).some(pin => pin.artifactHash === binding.artifactHash)) throw new PersistenceConflictError(`No retained obligation authorizes this provider: ${row.pluginId}`);
      assertSchemaRanges(sql, installed.schemas);
    }
  }
  const lifecycle: PluginLifecycle = {
    registerArtifact(value) {
      const item = persistedJson(value) as unknown as LifecycleArtifact;
      validateArtifact(item);
      persistence.transaction(() => {
        const existing = artifact(item.artifact.pluginId, item.artifact.artifactHash);
        if (existing && stableJson(existing) !== stableJson(item)) throw new PersistenceConflictError('Artifact metadata changed for immutable bytes');
        sql.prepare('INSERT OR IGNORE INTO plugin_artifacts VALUES (?,?,?)').run(item.artifact.pluginId, item.artifact.artifactHash, stableJson(item));
        const tombstone = sql.prepare('SELECT revision FROM plugin_lifecycle_tombstones WHERE pluginId=?').get(item.artifact.pluginId) as { revision: number } | undefined;
        sql.prepare("INSERT OR IGNORE INTO plugin_lifecycle VALUES (?,?,0,'inactive',NULL,?)").run(item.artifact.pluginId, item.artifact.artifactHash, tombstone?.revision ?? 0);
      });
    },
    list: () => (sql.prepare('SELECT pluginId FROM plugin_lifecycle ORDER BY pluginId').all() as Array<{ pluginId: string }>).map(row => record(current(row.pluginId)!)),
    recordHealth(pluginId, artifactHash, health, diagnostic) {
      if (!['inactive', 'active', 'failed'].includes(health) || health === 'failed' && !diagnostic) throw new PersistenceValidationError('Invalid plugin runtime health');
      if (diagnostic && (!diagnostic.code || !diagnostic.message || typeof diagnostic.retryable !== 'boolean')) throw new PersistenceValidationError('Invalid plugin runtime diagnostic');
      persistence.transaction(() => {
        const row = current(pluginId);
        if (!row || row.artifactHash !== artifactHash) throw new PersistenceConflictError('Runtime health does not match selected artifact');
        if (health === 'active' && !row.desiredEnabled && !executions.pins(pluginId).some(pin => pin.artifactHash === artifactHash)) throw new PersistenceConflictError('Disabled plugin has no obligation to service');
        sql.prepare('UPDATE plugin_lifecycle SET health=?,diagnostic=? WHERE pluginId=?').run(health, diagnostic ? stableJson(diagnostic) : null, pluginId);
      });
    },
    assertAdmission(snapshot) {
      if (!sql.inTransaction) throw new PersistenceConflictError('Admission validation requires the preparation transaction');
      assertBound(snapshot, true);
    },
    assertObligation: snapshot => assertBound(snapshot, false),
    plan: change => persistence.transaction(() => plan(change)),
    apply(change) {
      persistence.transaction(() => {
        const previousIntent = sql.prepare('SELECT owner,revision,payload FROM persistence_intents WHERE id=?').get(change.id) as { owner: string; revision: number; payload: string } | undefined;
        if (previousIntent) {
          if (previousIntent.owner !== `plugin:${change.pluginId}` || previousIntent.revision !== change.expectedRevision + 1
            || previousIntent.payload !== stableJson({ pluginId: change.pluginId, artifactHash: change.artifactHash, desiredEnabled: change.desiredEnabled })) throw new PersistenceConflictError('Lifecycle change ID already has different content');
          return;
        }
        const row = changeValid(change);
        const result = plan(change);
        if (result.blockers.length) throw new PersistenceConflictError(result.blockers.map(blocker => `${blocker.ownerId}: ${blocker.reason}`).join('; '));
        if (!change.desiredEnabled) {
          for (const dependent of affectedDependents(change.pluginId)) {
            const dependentRow = current(dependent)!;
            saveChange(dependentRow, { id: `${change.id}:drain:${dependent}`, desiredEnabled: false, artifactHash: dependentRow.artifactHash });
          }
        }
        saveChange(row, change);
      });
    },
    uninstall(pluginId, expectedRevision, changeId) {
      if (!ID.test(pluginId) || !ID.test(changeId) || !Number.isSafeInteger(expectedRevision)) throw new PersistenceValidationError('Invalid plugin uninstall');
      persistence.transaction(() => {
        const row = current(pluginId);
        if (!row || row.revision !== expectedRevision) throw new PersistenceConflictError('Plugin lifecycle revision changed');
        if (row.desiredEnabled || row.health === 'active' || executions.pins(pluginId).length || affectedDependents(pluginId).length) throw new PersistenceConflictError('Active or referenced plugins cannot be uninstalled');
        if (pending(pluginId)) throw new PersistenceConflictError('Settle pending plugin projections before uninstall');
        const revision = row.revision + 1;
        writePersistenceIntent(persistence, { id: changeId, owner: `plugin:${pluginId}`, revision,
          payload: { pluginId, artifactHash: row.artifactHash, desiredEnabled: false, removed: true }, targets: ['catalog', 'plugin-data'] });
        sql.prepare('INSERT INTO plugin_lifecycle_tombstones VALUES (?,?) ON CONFLICT(pluginId) DO UPDATE SET revision=excluded.revision').run(pluginId, revision);
        sql.prepare('DELETE FROM plugin_lifecycle WHERE pluginId=?').run(pluginId);
      });
    },
    canCollect(pluginId, artifactHash) {
      const blockers = pinBlockers(pluginId).filter(blocker => executions.pins(pluginId).some(pin => pin.artifactHash === artifactHash && pin.ownerId === blocker.ownerId));
      const row = current(pluginId);
      if (row?.artifactHash === artifactHash) blockers.push({ kind: 'consumer', ownerId: pluginId, reason: 'Artifact is still selected' });
      return { allowed: blockers.length === 0, blockers };
    },
    async validateCheckpointMigration(input) {
      if (!input?.checkpointId || !HASH.test(input.expectedSnapshotId)) throw new PersistenceValidationError('Invalid checkpoint migration validation');
      if (sql.inTransaction) throw new PersistenceConflictError('Checkpoint validation must run outside a persistence transaction');
      const next = validateExecutionSnapshot(input.next);
      const validator = validators.find(item => stableJson(item.provider) === stableJson(input.provider));
      if (!validator) throw new PersistenceConflictError('Retained provider does not support checkpoint migration');
      function retained() {
        const checkpoint = executions.checkpoint(input.checkpointId);
        const snapshot = checkpoint ? executions.snapshot(checkpoint.snapshotId) : null;
        if (!checkpoint || checkpoint.state !== 'resumable' || checkpoint.snapshotId !== input.expectedSnapshotId || !snapshot
          || !snapshot.bindings.some(binding => stableJson(binding) === stableJson(input.provider))) throw new PersistenceConflictError('Checkpoint validator is not its retained provider');
        assertBound(snapshot, false);
        return { checkpoint, snapshot };
      }
      const { checkpoint, snapshot } = retained();
      const checkpointHash = persistenceHash(checkpoint);
      const suppliedReceipt = await validator.validate({ checkpoint, previous: snapshot, next });
      if (!suppliedReceipt || typeof suppliedReceipt !== 'object') throw new PersistenceConflictError('Provider rejected checkpoint migration');
      const receipt = persistedJson(suppliedReceipt);
      return persistence.transaction(() => {
        if (persistenceHash(retained().checkpoint) !== checkpointHash) throw new PersistenceConflictError('Checkpoint changed during provider validation');
        const nextSnapshotHash = persistenceHash(next);
        const validationId = persistenceHash({ checkpointId: checkpoint.id, checkpointHash, nextSnapshotHash, provider: input.provider, receipt });
        sql.prepare('INSERT OR IGNORE INTO checkpoint_migration_validations VALUES (?,?,?,?,?,?,?)').run(validationId, checkpoint.id, snapshot.id, nextSnapshotHash, stableJson(input.provider), stableJson(receipt), checkpointHash);
        return { validationId, receipt };
      });
    },
    migrateCheckpoint(input) {
      if (!input?.actor || !input.reason || !input.validation?.validationId) throw new PersistenceValidationError('Checkpoint migration requires provider validation and actor');
      const next = validateExecutionSnapshot(input.next);
      if (next.provenance.kind !== 'checkpoint-migration') throw new PersistenceValidationError('Checkpoint migration provenance is required');
      persistence.transaction(() => {
        const checkpoint = executions.checkpoint(input.checkpointId);
        if (!checkpoint || checkpoint.state !== 'resumable' || checkpoint.snapshotId !== input.expectedSnapshotId) throw new PersistenceConflictError('Checkpoint changed before migration');
        const old = executions.snapshot(checkpoint.snapshotId);
        if (!old || next.runId !== old.runId || next.attempt !== old.attempt || next.repo !== old.repo
          || stableJson(next.logicalWork) !== stableJson(old.logicalWork) || stableJson(next.task) !== stableJson(old.task)) throw new PersistenceConflictError('Checkpoint migration cannot change logical work');
        const validation = sql.prepare('SELECT * FROM checkpoint_migration_validations WHERE id=?').get(input.validation.validationId) as { checkpointId: string; oldSnapshotId: string; newSnapshotHash: string; provider: string; receipt: string; checkpointHash: string } | undefined;
        if (!validation || validation.checkpointId !== checkpoint.id || validation.oldSnapshotId !== old.id || validation.newSnapshotHash !== persistenceHash(next)
          || validation.checkpointHash !== persistenceHash(checkpoint) || validation.provider !== stableJson(input.validation.provider) || validation.receipt !== stableJson(input.validation.receipt)) throw new PersistenceConflictError('Checkpoint migration validation does not match');
        for (const item of next.artifacts) {
          const installed = artifact(item.pluginId, item.artifactHash);
          if (!installed || stableJson(installed.artifact) !== stableJson(item)) throw new PersistenceConflictError('Checkpoint migration artifact is not installed');
          assertSchemaRanges(sql, installed.schemas);
        }
        assertSchemaRanges(sql, next.schemas);
        const migrated = createExecutionSnapshot(persistence, next);
        const updated = { ...checkpoint, snapshotId: migrated.id };
        sql.prepare('UPDATE execution_checkpoints SET snapshotId=?,json=? WHERE id=?').run(migrated.id, stableJson(updated), checkpoint.id);
        sql.prepare("DELETE FROM artifact_pins WHERE kind='checkpoint' AND ownerId=?").run(checkpoint.id);
        executions.retainPins(migrated.artifacts.map(item => ({ kind: 'checkpoint', ownerId: checkpoint.id, pluginId: item.pluginId, artifactHash: item.artifactHash })));
        sql.prepare('INSERT INTO binding_migrations VALUES (?,?,?,?,?,?,?,?)').run(persistenceHash({ checkpointId: checkpoint.id, old: old.id, next: migrated.id }), checkpoint.id, old.id, migrated.id, input.validation.validationId, input.actor, input.reason, new Date().toISOString());
      });
    },
  };
  return lifecycle;
}
