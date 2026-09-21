import { parsePluginHostRef } from './execution-host-execution';
import { randomUUID } from 'node:crypto';
import type { PluginJson } from '../../src/plugins/backend';
import type { RunStatus } from './db';
import type { HostRef } from './run-host';
import { migrateOwned, validateTableColumns, type SchemaRange } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface ArtifactBinding { pluginId: string; artifactHash: string; packageVersion: string; requires: readonly string[] }
export interface ProviderBinding {
  role: 'source' | 'agent' | 'host' | 'workflow' | 'effect';
  capability: string;
  contractVersion: number;
  contributionId: string;
  pluginId: string;
  artifactHash: string;
  connectionId: string | null;
  credentialHandle: string | null;
}
export interface ExecutionSnapshotInput {
  version: 1;
  runId: string;
  attempt: number;
  repo: string;
  logicalWork: { source: string; instance: string; taskId: string };
  task: PluginJson;
  workflowSnapshotId: string | null;
  artifacts: readonly ArtifactBinding[];
  bindings: readonly ProviderBinding[];
  settings: Readonly<Record<string, PluginJson>>;
  schemas: readonly SchemaRange[];
  provenance: { kind: 'admission' | 'legacy-adoption' | 'checkpoint-migration'; evidence: PluginJson };
}
export interface ExecutionSnapshot extends ExecutionSnapshotInput { id: string; contentHash: string; createdAt: string }
export interface RecoveryDiagnostic { code: string; message: string; retryable: boolean; details: PluginJson }
export interface AttemptKey { runId: string; attempt: number }
export interface AttemptLease extends AttemptKey { token: string; generation: number; expiresAt: string }
export interface ExecutionAttempt extends AttemptKey {
  snapshotId: string;
  launchId: string;
  preparation: 'prepared' | 'ready' | 'launching' | 'launched';
  attachment: 'pending' | 'attached' | 'blocked' | 'failed';
  hostRef: HostRef | null;
  paths: { worktree: string | null; log: string; exit: string; spec: string };
  outcome: { status: Exclude<RunStatus, 'running'>; endedAt: string; evidence: PluginJson } | null;
  diagnostic: RecoveryDiagnostic | null;
}
export interface ExecutionReservation { runId: string; repo: string; reason: 'prepared' | 'executing' | 'unresolved' }
export interface ArtifactPin { kind: 'admission' | 'execution' | 'checkpoint' | 'operation' | 'dependency'; ownerId: string; pluginId: string; artifactHash: string }
export interface ExecutionCheckpoint {
  id: string; runId: string; attempt: number; snapshotId: string;
  format: string; formatVersion: number; artifacts: PluginJson; state: 'resumable' | 'retired';
}
export interface ExecutionStore {
  reserveAdmission(input: { runId: string; repo: string; maxConcurrency: number; evidence: PluginJson }): void;
  abandonAdmission(runId: string, evidence: PluginJson): void;
  prepare(input: { snapshot: ExecutionSnapshotInput; launchId: string; paths: ExecutionAttempt['paths']; maxConcurrency: number }): ExecutionAttempt;
  snapshot(id: string): ExecutionSnapshot | null;
  attempt(key: AttemptKey): ExecutionAttempt | null;
  recoverable(): readonly ExecutionAttempt[];
  hasRunEvidence(runId: string): boolean;
  reservations(): readonly ExecutionReservation[];
  lease(key: AttemptKey, ttlMs: number): AttemptLease | null;
  assertLease(lease: AttemptLease): void;
  renew(lease: AttemptLease, ttlMs: number): AttemptLease | null;
  releaseLease(lease: AttemptLease): void;
  setWorktree(lease: AttemptLease, path: string): void;
  ready(lease: AttemptLease): void;
  markLaunching(lease: AttemptLease): void;
  recordLaunch(lease: AttemptLease, ref: HostRef, evidence: PluginJson): void;
  recordAttachment(lease: AttemptLease, health: ExecutionAttempt['attachment'], diagnostic: RecoveryDiagnostic | null): void;
  recordOutcome(lease: AttemptLease, outcome: NonNullable<ExecutionAttempt['outcome']>): void;
  retainCheckpoint(checkpoint: ExecutionCheckpoint): void;
  checkpoint(id: string): ExecutionCheckpoint | null;
  retireCheckpoint(id: string, resolution: { actor: string; reason: string }): void;
  pins(pluginId?: string): readonly ArtifactPin[];
  retainPins(pins: readonly ArtifactPin[]): void;
  releasePins(kind: ArtifactPin['kind'], ownerId: string): void;
  releaseSourceClaimPins(claimId: string): void;
  cleanupEligibility(runId: string): { allowed: true } | { allowed: false; reasons: readonly string[] };
  releaseReservation(runId: string, evidence: PluginJson): void;
}

const HASH = /^[a-f\d]{64}$/;
const ID = /^[a-z\d][a-z\d_.:/@-]{0,255}$/i;
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function identity(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function keyValid(key: AttemptKey): void {
  if (!identity(key?.runId) || !Number.isSafeInteger(key.attempt) || key.attempt < 1) throw new PersistenceValidationError('Invalid execution attempt identity');
}

export function validateExecutionSnapshot(value: unknown): ExecutionSnapshotInput {
  const input = object(persistedJson(value));
  if (!input || input.version !== 1) throw new PersistenceValidationError('Invalid execution snapshot version');
  keyValid(input as unknown as AttemptKey);
  const work = object(input.logicalWork);
  const provenance = object(input.provenance);
  if (!nonempty(input.repo) || !work || !identity(work.source) || !nonempty(work.instance) || !nonempty(work.taskId)
    || !(input.workflowSnapshotId === null || nonempty(input.workflowSnapshotId)) || !object(input.settings)
    || !provenance || !['admission', 'legacy-adoption', 'checkpoint-migration'].includes(String(provenance.kind)) || !('evidence' in provenance)
    || !('task' in input) || !Array.isArray(input.artifacts) || !input.artifacts.length || input.artifacts.length > 256
    || !Array.isArray(input.bindings) || !input.bindings.length || input.bindings.length > 256 || !Array.isArray(input.schemas)) {
    throw new PersistenceValidationError('Invalid execution snapshot');
  }
  const artifacts = new Map<string, ArtifactBinding>();
  for (const item of input.artifacts) {
    const artifact = object(item);
    if (!artifact || !identity(artifact.pluginId) || typeof artifact.artifactHash !== 'string' || !HASH.test(artifact.artifactHash)
      || !nonempty(artifact.packageVersion) || !Array.isArray(artifact.requires) || artifact.requires.some(value => !identity(value))
      || new Set(artifact.requires).size !== artifact.requires.length || artifacts.has(artifact.pluginId)) throw new PersistenceValidationError('Invalid execution artifact closure');
    artifacts.set(artifact.pluginId, artifact as unknown as ArtifactBinding);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new PersistenceValidationError('Execution artifact dependency cycle');
    if (visited.has(id)) return;
    const artifact = artifacts.get(id);
    if (!artifact) throw new PersistenceValidationError('Execution artifact dependency is missing');
    visiting.add(id);
    for (const dependency of artifact.requires) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of artifacts.keys()) visit(id);
  const selections = new Set<string>();
  for (const item of input.bindings) {
    const binding = object(item);
    if (!binding || !['source', 'agent', 'host', 'workflow', 'effect'].includes(String(binding.role))
      || !identity(binding.capability) || !identity(binding.contributionId) || !identity(binding.pluginId)
      || !Number.isSafeInteger(binding.contractVersion) || Number(binding.contractVersion) < 1
      || artifacts.get(binding.pluginId)?.artifactHash !== binding.artifactHash
      || !(binding.connectionId === null || nonempty(binding.connectionId))
      || !(binding.credentialHandle === null || nonempty(binding.credentialHandle))
      || binding.credentialHandle !== null && binding.connectionId === null) throw new PersistenceValidationError('Invalid execution provider binding');
    const selection = `${String(binding.role)}:${binding.capability}${binding.role === 'agent' && binding.capability === 'helmsman/agent' ? `:${binding.contributionId}` : ''}`;
    if (selections.has(selection)) throw new PersistenceValidationError('Ambiguous execution provider binding');
    selections.add(selection);
  }
  if (!input.bindings.some(binding => object(binding)?.role === 'host')) throw new PersistenceValidationError('Execution host binding is required');
  const schemaOwners = new Set<string>();
  for (const item of input.schemas) {
    const schema = object(item);
    if (!schema || !identity(schema.owner) || !Number.isSafeInteger(schema.minimum) || !Number.isSafeInteger(schema.maximum)
      || Number(schema.minimum) < 0 || Number(schema.maximum) < Number(schema.minimum) || schemaOwners.has(schema.owner)) throw new PersistenceValidationError('Invalid execution schema requirement');
    schemaOwners.add(schema.owner);
  }
  function rejectSecrets(item: unknown): void {
    if (Array.isArray(item)) { item.forEach(rejectSecrets); return; }
    const record = object(item);
    if (!record) return;
    for (const [name, child] of Object.entries(record)) {
      if (/^(?:password|secret|api[_-]?key|api[_-]?token|access[_-]?token|authorization|jira[_-]?api[_-]?token|gate[_-]?token|capability)$/i.test(name)) throw new PersistenceValidationError('Execution snapshots cannot contain credential values');
      rejectSecrets(child);
    }
  }
  rejectSecrets(input.task); rejectSecrets(input.settings);
  return input as unknown as ExecutionSnapshotInput;
}

export function createExecutionSnapshot(persistence: Persistence, value: ExecutionSnapshotInput): ExecutionSnapshot {
  const input = validateExecutionSnapshot(value);
  const contentHash = persistenceHash(input);
  const sql = persistence.sql;
  const previous = sql.prepare('SELECT * FROM execution_snapshots WHERE id = ?').get(contentHash) as SnapshotRow | undefined;
  if (previous) return decodeSnapshot(previous);
  const result = { ...input, id: contentHash, contentHash, createdAt: new Date().toISOString() };
  sql.prepare('INSERT INTO execution_snapshots (id,runId,attempt,contentHash,json,createdAt) VALUES (@id,@runId,@attempt,@contentHash,@json,@createdAt)').run({ ...result, json: stableJson(input) });
  return result;
}

interface SnapshotRow { id: string; runId: string; attempt: number; contentHash: string; json: string; createdAt: string }
function decodeSnapshot(row: SnapshotRow): ExecutionSnapshot {
  const value = validateExecutionSnapshot(JSON.parse(row.json));
  if (value.runId !== row.runId || value.attempt !== row.attempt || persistenceHash(value) !== row.contentHash || row.id !== row.contentHash
    || !Number.isFinite(Date.parse(row.createdAt))) throw new PersistenceValidationError('Execution snapshot integrity check failed');
  return { ...value, id: row.id, contentHash: row.contentHash, createdAt: row.createdAt };
}

function validateHostRef(value: unknown): HostRef {
  const ref = object(persistedJson(value));
  if (ref?.kind === 'plugin') return parsePluginHostRef(ref);
  if (!ref || !(ref.kind === 'detached' && Number.isSafeInteger(ref.pid) && Number(ref.pid) > 0
    || ref.kind === 'cmux' && nonempty(ref.workspace)
    || ref.kind === 'wezterm' && nonempty(ref.paneId) && (ref.socket === undefined || ref.socket === null || nonempty(ref.socket))
    || ref.kind === 'docker' && typeof ref.containerId === 'string' && /^[a-f\d]{12,64}$/i.test(ref.containerId))) throw new PersistenceValidationError('Invalid execution host reference');
  return ref as unknown as HostRef;
}

function validatePaths(value: unknown): ExecutionAttempt['paths'] {
  const paths = object(persistedJson(value));
  if (!paths || !(paths.worktree === null || nonempty(paths.worktree)) || !nonempty(paths.log) || !nonempty(paths.exit) || !nonempty(paths.spec)
    || new Set([paths.log, paths.exit, paths.spec]).size !== 3) throw new PersistenceValidationError('Invalid execution artifact paths');
  return paths as unknown as ExecutionAttempt['paths'];
}

interface AttemptRow { runId: string; attempt: number; snapshotId: string; launchId: string; json: string; leaseToken: string | null; leaseGeneration: number; leaseExpiresAt: string | null }
function decodeAttempt(row: AttemptRow): ExecutionAttempt {
  const value = object(persistedJson(JSON.parse(row.json)));
  if (!value || value.runId !== row.runId || value.attempt !== row.attempt || value.snapshotId !== row.snapshotId || value.launchId !== row.launchId
    || !['prepared', 'ready', 'launching', 'launched'].includes(String(value.preparation))
    || !['pending', 'attached', 'blocked', 'failed'].includes(String(value.attachment))) throw new PersistenceValidationError('Execution attempt integrity check failed');
  keyValid(value as unknown as AttemptKey);
  validatePaths(value.paths);
  if (value.hostRef !== null) validateHostRef(value.hostRef);
  if (value.outcome !== null) validateOutcome(value.outcome);
  if (value.diagnostic !== null) validateDiagnostic(value.diagnostic);
  return value as unknown as ExecutionAttempt;
}

function validateOutcome(value: unknown): NonNullable<ExecutionAttempt['outcome']> {
  const outcome = object(persistedJson(value));
  if (!outcome || !['succeeded', 'failed', 'stopped'].includes(String(outcome.status)) || typeof outcome.endedAt !== 'string'
    || !Number.isFinite(Date.parse(outcome.endedAt)) || !('evidence' in outcome) || outcome.evidence === null) throw new PersistenceValidationError('Terminal execution evidence is required');
  return outcome as unknown as NonNullable<ExecutionAttempt['outcome']>;
}

function validateDiagnostic(value: unknown): RecoveryDiagnostic {
  const diagnostic = object(persistedJson(value));
  if (!diagnostic || !identity(diagnostic.code) || !nonempty(diagnostic.message) || typeof diagnostic.retryable !== 'boolean' || !('details' in diagnostic)) throw new PersistenceValidationError('Invalid recovery diagnostic');
  return diagnostic as unknown as RecoveryDiagnostic;
}

const DDL = `
  CREATE TABLE execution_snapshots (id TEXT PRIMARY KEY,runId TEXT NOT NULL,attempt INTEGER NOT NULL,contentHash TEXT NOT NULL,json TEXT NOT NULL,createdAt TEXT NOT NULL);
  CREATE TABLE execution_attempts (runId TEXT NOT NULL,attempt INTEGER NOT NULL,snapshotId TEXT NOT NULL,launchId TEXT NOT NULL UNIQUE,json TEXT NOT NULL,leaseToken TEXT,leaseGeneration INTEGER NOT NULL DEFAULT 0,leaseExpiresAt TEXT,PRIMARY KEY(runId,attempt));
  CREATE TABLE execution_reservations (runId TEXT PRIMARY KEY,repo TEXT NOT NULL COLLATE NOCASE UNIQUE,reason TEXT NOT NULL);
  CREATE TABLE execution_checkpoints (id TEXT PRIMARY KEY,runId TEXT NOT NULL,attempt INTEGER NOT NULL,snapshotId TEXT NOT NULL,state TEXT NOT NULL,json TEXT NOT NULL);
  CREATE TABLE artifact_pins (kind TEXT NOT NULL,ownerId TEXT NOT NULL,pluginId TEXT NOT NULL,artifactHash TEXT NOT NULL,PRIMARY KEY(kind,ownerId,pluginId,artifactHash));
  CREATE TABLE execution_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT NOT NULL,attempt INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL);
`;
const TABLES = {
  execution_snapshots: ['id', 'runId', 'attempt', 'contentHash', 'json', 'createdAt'],
  execution_attempts: ['runId', 'attempt', 'snapshotId', 'launchId', 'json', 'leaseToken', 'leaseGeneration', 'leaseExpiresAt'],
  execution_reservations: ['runId', 'repo', 'reason'],
  execution_checkpoints: ['id', 'runId', 'attempt', 'snapshotId', 'state', 'json'],
  artifact_pins: ['kind', 'ownerId', 'pluginId', 'artifactHash'],
  execution_evidence: ['id', 'runId', 'attempt', 'kind', 'payload', 'createdAt'],
};

export function openExecutionStore(persistence: Persistence, now: () => number = Date.now): ExecutionStore {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.execution', version: 1, checksum: persistenceHash(DDL), tables: Object.keys(TABLES),
    validateLegacy: () => null, apply: () => sql.exec(DDL),
    validateCurrent: () => { for (const [table, columns] of Object.entries(TABLES)) validateTableColumns(sql, table, columns); },
  });
  const transaction = persistence.transaction;
  function legacyObligations(): Array<{ runId: string; repo: string; status: string; state: string; protected: number }> {
    if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_execution_obligations'").get()) return [];
    const rows = sql.prepare('SELECT runId,repo,status,state,protected FROM legacy_execution_obligations').all() as Array<{ runId: string; repo: string; status: string; state: string; protected: number }>;
    if (rows.some(row => !identity(row.runId) || !nonempty(row.repo) || !['running', 'succeeded', 'failed', 'stopped'].includes(row.status)
      || ![0, 1].includes(row.protected))) throw new PersistenceValidationError('Invalid legacy execution protection');
    return rows.filter(row => row.protected === 1);
  }
  function rejectUnadoptedLegacy(runId: string): void {
    if (legacyObligations().some(item => item.runId === runId)) throw new PersistenceConflictError('Legacy execution requires verified adoption before admission or preparation');
  }
  const raw = (key: AttemptKey) => { keyValid(key); return sql.prepare('SELECT * FROM execution_attempts WHERE runId = ? AND attempt = ?').get(key.runId, key.attempt) as AttemptRow | undefined; };
  const save = (value: ExecutionAttempt) => sql.prepare('UPDATE execution_attempts SET json = ? WHERE runId = ? AND attempt = ?').run(stableJson(value), value.runId, value.attempt);
  const evidence = (key: AttemptKey, kind: string, payload: unknown) => sql.prepare('INSERT INTO execution_evidence(runId,attempt,kind,payload,createdAt) VALUES(?,?,?,?,?)').run(key.runId, key.attempt, kind, stableJson(payload), new Date(now()).toISOString());
  function owned(lease: AttemptLease): ExecutionAttempt {
    const row = raw(lease);
    const expiresAt = Date.parse(row?.leaseExpiresAt ?? '');
    if (!row || row.leaseToken !== lease.token || row.leaseGeneration !== lease.generation || row.leaseExpiresAt !== lease.expiresAt || !Number.isFinite(expiresAt) || expiresAt <= now()) throw new PersistenceConflictError('Execution lease is stale or expired');
    return decodeAttempt(row);
  }
  function ttl(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new PersistenceValidationError('Invalid execution lease duration'); }
  function pinList(pluginId?: string): ArtifactPin[] {
    const rows = (pluginId === undefined ? sql.prepare('SELECT * FROM artifact_pins ORDER BY kind,ownerId,pluginId').all() : sql.prepare('SELECT * FROM artifact_pins WHERE pluginId = ? ORDER BY kind,ownerId').all(pluginId)) as ArtifactPin[];
    for (const pin of rows) validatePin(pin);
    return rows;
  }
  function validatePin(pin: ArtifactPin): void {
    if (!pin || !['admission', 'execution', 'checkpoint', 'operation', 'dependency'].includes(pin.kind) || !nonempty(pin.ownerId) || !identity(pin.pluginId) || !HASH.test(pin.artifactHash)) throw new PersistenceValidationError('Invalid artifact pin');
  }
  function addPins(pins: readonly ArtifactPin[]): void {
    for (const pin of pins) {
      validatePin(pin);
      const conflicting = sql.prepare('SELECT artifactHash FROM artifact_pins WHERE kind = ? AND ownerId = ? AND pluginId = ? AND artifactHash != ?').get(pin.kind, pin.ownerId, pin.pluginId, pin.artifactHash);
      if (conflicting) throw new PersistenceConflictError('An obligation cannot pin two versions of one plugin');
      sql.prepare('INSERT OR IGNORE INTO artifact_pins VALUES (@kind,@ownerId,@pluginId,@artifactHash)').run(pin);
    }
  }
  function snapshot(id: string): ExecutionSnapshot | null {
    const row = sql.prepare('SELECT * FROM execution_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
    return row ? decodeSnapshot(row) : null;
  }
  function checkpoint(id: string): ExecutionCheckpoint | null {
    const row = sql.prepare('SELECT * FROM execution_checkpoints WHERE id = ?').get(id) as { id: string; runId: string; attempt: number; snapshotId: string; state: string; json: string } | undefined;
    if (!row) return null;
    const item = object(persistedJson(JSON.parse(row.json)));
    if (!item || item.id !== row.id || item.runId !== row.runId || item.attempt !== row.attempt || item.snapshotId !== row.snapshotId || item.state !== row.state
      || !identity(item.id) || !identity(item.format) || !Number.isSafeInteger(item.formatVersion) || Number(item.formatVersion) < 1
      || !['resumable', 'retired'].includes(String(item.state)) || !('artifacts' in item)) throw new PersistenceValidationError('Checkpoint integrity check failed');
    return item as unknown as ExecutionCheckpoint;
  }
  const store: ExecutionStore = {
    hasRunEvidence(runId) {
      if (!identity(runId)) throw new PersistenceValidationError('Invalid execution identity');
      for (const table of ['execution_attempts', 'execution_snapshots', 'execution_reservations', 'execution_checkpoints', 'execution_evidence', 'execution_controls']) {
        if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
          && sql.prepare(`SELECT 1 FROM ${table} WHERE runId=? LIMIT 1`).get(runId)) return true;
      }
      if (sql.prepare("SELECT 1 FROM artifact_pins WHERE kind='admission' AND ownerId=? LIMIT 1").get(runId)) return true;
      if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_claims'").get()
        && sql.prepare("SELECT 1 FROM work_claims WHERE json_extract(json,'$.runId')=? LIMIT 1").get(runId)) return true;
      return Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operations'").get()
        && sql.prepare("SELECT 1 FROM operations WHERE json_extract(draft,'$.origin.runId')=? LIMIT 1").get(runId));
    },
    reserveAdmission(input) {
      if (!identity(input?.runId) || !nonempty(input.repo) || !Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.evidence === null) throw new PersistenceValidationError('Invalid admission reservation');
      transaction(() => {
        rejectUnadoptedLegacy(input.runId);
        const reservations = store.reservations();
        const existing = reservations.find(item => item.runId === input.runId);
        if (existing) {
          if (existing.repo.toLowerCase() !== input.repo.toLowerCase()) throw new PersistenceConflictError('Admission already reserves another galleon');
          return;
        }
        if (reservations.length >= input.maxConcurrency || reservations.some(item => item.repo.toLowerCase() === input.repo.toLowerCase())) throw new PersistenceConflictError('Execution capacity is reserved');
        if (sql.prepare('SELECT runId FROM execution_attempts WHERE runId=?').get(input.runId)) throw new PersistenceConflictError('Admission already has an execution attempt');
        sql.prepare("INSERT INTO execution_reservations VALUES (?,?,'prepared')").run(input.runId, input.repo);
        evidence({ runId: input.runId, attempt: 0 }, 'admission-reserved', input.evidence);
      });
    },
    abandonAdmission(runId, abandonmentEvidence) {
      if (!identity(runId) || abandonmentEvidence === null) throw new PersistenceValidationError('Admission abandonment requires evidence');
      transaction(() => {
        rejectUnadoptedLegacy(runId);
        if (sql.prepare('SELECT runId FROM execution_attempts WHERE runId=?').get(runId)) throw new PersistenceConflictError('Attempted execution cannot be abandoned as an admission');
        evidence({ runId, attempt: 0 }, 'admission-abandoned', abandonmentEvidence);
        sql.prepare('DELETE FROM execution_reservations WHERE runId=?').run(runId);
      });
    },
    prepare(input) {
      const value = validateExecutionSnapshot(input?.snapshot);
      const paths = validatePaths(input.paths);
      if (!identity(input.launchId) || !Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1) throw new PersistenceValidationError('Invalid execution preparation');
      return transaction(() => {
        rejectUnadoptedLegacy(value.runId);
        const previous = raw(value);
        if (previous) {
          const attempt = decodeAttempt(previous);
          const expectedPaths = paths.worktree === null ? { ...paths, worktree: attempt.paths.worktree } : paths;
          if (attempt.snapshotId !== persistenceHash(value) || attempt.launchId !== input.launchId || stableJson(attempt.paths) !== stableJson(expectedPaths)) throw new PersistenceConflictError('Execution attempt already has different preparation');
          return attempt;
        }
        const attempts = (sql.prepare('SELECT * FROM execution_attempts WHERE runId = ?').all(value.runId) as AttemptRow[]).map(decodeAttempt);
        if (attempts.some(attempt => !attempt.outcome)) throw new PersistenceConflictError('Prior execution attempt is unresolved');
        if (attempts.some(attempt => attempt.attempt >= value.attempt)) throw new PersistenceConflictError('Execution attempts must advance monotonically');
        if (sql.prepare('SELECT launchId FROM execution_attempts WHERE launchId=?').get(input.launchId)) throw new PersistenceConflictError('Launch identity belongs to another execution attempt');
        const reservation = sql.prepare('SELECT * FROM execution_reservations WHERE runId = ?').get(value.runId) as ExecutionReservation | undefined;
        const reservations = store.reservations();
        if (reservation && reservation.repo.toLowerCase() !== value.repo.toLowerCase() || reservations.some(item => item.runId !== value.runId && item.repo.toLowerCase() === value.repo.toLowerCase())) throw new PersistenceConflictError('A voyage already reserves this galleon');
        if (!reservation && reservations.length >= input.maxConcurrency) throw new PersistenceConflictError('Maximum execution concurrency reached');
        const saved = createExecutionSnapshot(persistence, value);
        const attempt: ExecutionAttempt = { runId: value.runId, attempt: value.attempt, snapshotId: saved.id, launchId: input.launchId,
          preparation: 'prepared', attachment: 'pending', hostRef: null, paths, outcome: null, diagnostic: null };
        sql.prepare('INSERT INTO execution_attempts(runId,attempt,snapshotId,launchId,json) VALUES(@runId,@attempt,@snapshotId,@launchId,@json)').run({ ...attempt, json: stableJson(attempt) });
        sql.prepare("INSERT INTO execution_reservations VALUES (?,?,'prepared') ON CONFLICT(runId) DO UPDATE SET reason='prepared'").run(value.runId, value.repo);
        addPins(saved.artifacts.map(artifact => ({ kind: 'execution', ownerId: saved.id, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash })));
        evidence(attempt, 'prepared', { snapshotId: saved.id, launchId: attempt.launchId });
        return attempt;
      });
    },
    snapshot,
    attempt: key => { const row = raw(key); return row ? decodeAttempt(row) : null; },
    recoverable() {
      const attempts = (sql.prepare('SELECT * FROM execution_attempts ORDER BY runId,attempt').all() as AttemptRow[]).map(decodeAttempt);
      const hasRuns = !!sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
      return attempts.filter(item => item.outcome === null
        || !!sql.prepare("SELECT ownerId FROM artifact_pins WHERE kind='execution' AND ownerId=?").get(item.snapshotId)
        || !!sql.prepare('SELECT runId FROM execution_reservations WHERE runId=?').get(item.runId) && !attempts.some(other => other.runId === item.runId && other.attempt > item.attempt)
        || hasRuns && !!sql.prepare("SELECT id FROM runs WHERE id=? AND attempt=? AND status='running'").get(item.runId, item.attempt));
    },
    reservations() {
      const rows = sql.prepare('SELECT * FROM execution_reservations ORDER BY runId').all() as ExecutionReservation[];
      for (const item of legacyObligations()) {
        if (item.status === 'running' && !rows.some(row => row.runId === item.runId)) rows.push({ runId: item.runId, repo: item.repo, reason: 'unresolved' });
      }
      if (rows.some(row => !identity(row.runId) || !nonempty(row.repo) || !['prepared', 'executing', 'unresolved'].includes(row.reason))) throw new PersistenceValidationError('Invalid durable execution reservation');
      return rows;
    },
    lease(key, ttlMs) {
      ttl(ttlMs);
      return transaction(() => {
        const row = raw(key);
        if (!row) throw new PersistenceConflictError('Execution attempt is missing');
        if (!Number.isSafeInteger(row.leaseGeneration) || row.leaseGeneration < 0 || row.leaseToken && !Number.isFinite(Date.parse(row.leaseExpiresAt ?? ''))) throw new PersistenceValidationError('Execution lease ownership is invalid');
        if (row.leaseToken && Date.parse(row.leaseExpiresAt ?? '') > now()) return null;
        const lease = { runId: key.runId, attempt: key.attempt, token: randomUUID(), generation: row.leaseGeneration + 1, expiresAt: new Date(now() + ttlMs).toISOString() };
        sql.prepare('UPDATE execution_attempts SET leaseToken=?,leaseGeneration=?,leaseExpiresAt=? WHERE runId=? AND attempt=?').run(lease.token, lease.generation, lease.expiresAt, key.runId, key.attempt);
        return lease;
      });
    },
    assertLease: lease => { owned(lease); },
    renew(lease, ttlMs) {
      ttl(ttlMs);
      return transaction(() => {
        try { owned(lease); } catch (error) { if (error instanceof PersistenceConflictError) return null; throw error; }
        const next = { ...lease, expiresAt: new Date(now() + ttlMs).toISOString() };
        sql.prepare('UPDATE execution_attempts SET leaseExpiresAt=? WHERE runId=? AND attempt=?').run(next.expiresAt, lease.runId, lease.attempt);
        return next;
      });
    },
    releaseLease(lease) { transaction(() => { owned(lease); sql.prepare('UPDATE execution_attempts SET leaseToken=NULL,leaseExpiresAt=NULL WHERE runId=? AND attempt=?').run(lease.runId, lease.attempt); }); },
    setWorktree(lease, path) {
      if (!nonempty(path)) throw new PersistenceValidationError('Worktree path is required');
      transaction(() => {
        const item = owned(lease);
        if (item.outcome || !['prepared', 'ready'].includes(item.preparation) || item.paths.worktree !== null && item.paths.worktree !== path) throw new PersistenceConflictError('Prepared worktree identity cannot change');
        save({ ...item, paths: { ...item.paths, worktree: path } });
        evidence(item, 'worktree-prepared', { path });
      });
    },
    ready(lease) { transaction(() => { const item = owned(lease); if (item.outcome || !['prepared', 'ready'].includes(item.preparation)) throw new PersistenceConflictError('Execution cannot become ready'); save({ ...item, preparation: 'ready' }); }); },
    markLaunching(lease) { transaction(() => { const item = owned(lease); if (item.outcome || item.preparation !== 'ready') throw new PersistenceConflictError('Execution cannot launch again without discovery'); save({ ...item, preparation: 'launching' }); sql.prepare("UPDATE execution_reservations SET reason='unresolved' WHERE runId=?").run(item.runId); }); },
    recordLaunch(lease, ref, ownershipEvidence) {
      const hostRef = validateHostRef(ref);
      if (ownershipEvidence === null) throw new PersistenceValidationError('Launch ownership evidence is required');
      transaction(() => {
        const item = owned(lease);
        if (item.outcome || !['launching', 'launched'].includes(item.preparation) || item.hostRef && stableJson(item.hostRef) !== stableJson(hostRef)) throw new PersistenceConflictError('Execution host reference conflicts with launch');
        const binding = snapshot(item.snapshotId)?.bindings.find(value => value.role === 'host');
        if (binding?.capability === 'helmsman/execution-host' || hostRef.kind === 'plugin') {
          if (hostRef.kind !== 'plugin' || binding?.capability !== 'helmsman/execution-host' || hostRef.providerId !== binding.contributionId
            || hostRef.reference.identity.runId !== item.runId || hostRef.reference.identity.attempt !== item.attempt
            || hostRef.reference.identity.launchId !== item.launchId || hostRef.reference.identity.receiptPath !== `${item.paths.spec}.receipt`) {
            throw new PersistenceConflictError('Execution host reference differs from its retained launch binding');
          }
        }
        save({ ...item, hostRef, preparation: 'launched' }); evidence(item, 'launch', ownershipEvidence);
        sql.prepare("UPDATE execution_reservations SET reason='executing' WHERE runId=?").run(item.runId);
      });
    },
    recordAttachment(lease, health, diagnostic) {
      if (!['pending', 'attached', 'blocked', 'failed'].includes(health)) throw new PersistenceValidationError('Invalid attachment health');
      const parsed = diagnostic === null ? null : validateDiagnostic(diagnostic);
      if (['blocked', 'failed'].includes(health) && !parsed) throw new PersistenceValidationError('Attachment failure requires a diagnostic');
      transaction(() => {
        const item = owned(lease);
        if (health === 'attached' && !item.hostRef) throw new PersistenceConflictError('Cannot attach without an owned host reference');
        save({ ...item, attachment: health, diagnostic: parsed });
        if (!item.outcome) sql.prepare('UPDATE execution_reservations SET reason=? WHERE runId=?').run(health === 'attached' ? 'executing' : 'unresolved', item.runId);
      });
    },
    recordOutcome(lease, value) {
      const outcome = validateOutcome(value);
      transaction(() => {
        const item = owned(lease);
        if (item.outcome && stableJson(item.outcome) !== stableJson(outcome)) throw new PersistenceConflictError('Execution already has different terminal evidence');
        save({ ...item, outcome }); evidence(item, 'outcome', outcome);
      });
    },
    retainCheckpoint(value) {
      const input = persistedJson(value) as unknown as ExecutionCheckpoint;
      if (!identity(input?.id) || !identity(input.format) || !Number.isSafeInteger(input.formatVersion) || input.formatVersion < 1 || input.state !== 'resumable') throw new PersistenceValidationError('Invalid resumable checkpoint');
      keyValid(input);
      transaction(() => {
        const bound = snapshot(input.snapshotId);
        if (!bound || bound.runId !== input.runId || bound.attempt !== input.attempt) throw new PersistenceConflictError('Checkpoint snapshot does not match the execution');
        const prior = checkpoint(input.id);
        if (prior && stableJson(prior) !== stableJson(input)) throw new PersistenceConflictError('Checkpoint already has different content');
        sql.prepare('INSERT OR IGNORE INTO execution_checkpoints VALUES (@id,@runId,@attempt,@snapshotId,@state,@json)').run({ ...input, json: stableJson(input) });
        addPins(bound.artifacts.map(artifact => ({ kind: 'checkpoint', ownerId: input.id, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash })));
      });
    },
    checkpoint,
    retireCheckpoint(id, resolution) {
      if (!nonempty(resolution?.actor) || !nonempty(resolution.reason)) throw new PersistenceValidationError('Checkpoint retirement requires actor and reason');
      transaction(() => {
        const item = checkpoint(id);
        if (!item) throw new PersistenceConflictError('Checkpoint is missing');
        if (item.state === 'retired') return;
        const retired = { ...item, state: 'retired' as const };
        sql.prepare("UPDATE execution_checkpoints SET state='retired',json=? WHERE id=?").run(stableJson(retired), id);
        evidence(item, 'checkpoint-retired', { id, ...resolution });
        store.releasePins('checkpoint', id);
      });
    },
    pins: pinList,
    retainPins: pins => transaction(() => addPins(pins)),
    releasePins(kind, ownerId) {
      transaction(() => {
        if (kind === 'admission') {
          const exists = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_admissions'").get();
          const row = exists ? sql.prepare('SELECT state FROM execution_admissions WHERE runId=?').get(ownerId) as { state: string } | undefined : undefined;
          if (!row || !['started', 'failed'].includes(row.state)) throw new PersistenceConflictError('Pending admission pins must be retained');
        }
        if (kind === 'checkpoint' && checkpoint(ownerId)?.state !== 'retired') throw new PersistenceConflictError('Resumable checkpoint pins must be retained');
        if (kind === 'execution') {
          const row = sql.prepare('SELECT * FROM execution_attempts WHERE snapshotId=?').get(ownerId) as AttemptRow | undefined;
          if (!row || !decodeAttempt(row).outcome) throw new PersistenceConflictError('Unresolved execution pins must be retained');
        }
        if (kind === 'operation') {
          const exists = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get();
          const row = exists ? sql.prepare('SELECT status FROM operations WHERE id=?').get(ownerId) as { status: string } | undefined : undefined;
          if (row?.status !== 'completed') throw new PersistenceConflictError('Unsettled operation pins must be retained');
        }
        if (kind === 'dependency') throw new PersistenceConflictError('Dependency pins must be released by their owning obligation');
        sql.prepare('DELETE FROM artifact_pins WHERE kind=? AND ownerId=?').run(kind, ownerId);
      });
    },
    releaseSourceClaimPins(claimId) {
      transaction(() => {
        if (!nonempty(claimId)) throw new PersistenceValidationError('Source claim identity is required');
        const exists = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'").get();
        const row = exists ? sql.prepare('SELECT id,state,json FROM work_claims WHERE id=?').get(claimId) as { id: string; state: string; json: string } | undefined : undefined;
        const claim = row ? persistedJson(JSON.parse(row.json)) as { id?: unknown; state?: unknown; settlement?: { claimId?: unknown; disposition?: unknown } } | null : null;
        if (!row || row.state !== 'settled' || claim?.id !== claimId || claim.state !== 'settled' || claim.settlement?.claimId !== claimId || !['released', 'completed'].includes(String(claim.settlement?.disposition))) throw new PersistenceConflictError('Unsettled source claim pins must be retained');
        sql.prepare("DELETE FROM artifact_pins WHERE kind='dependency' AND ownerId=?").run(`source-claim:${claimId}`);
      });
    },
    cleanupEligibility(runId) {
      const reasons: string[] = [];
      if (legacyObligations().some(item => item.runId === runId)) reasons.push('Legacy execution or checkpoint requires verified adoption');
      const hasAdmissions = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_admissions'").get();
      if (hasAdmissions && sql.prepare("SELECT runId FROM execution_admissions WHERE runId=? AND state IN ('pending','blocked')").get(runId)) reasons.push('Execution admission remains unresolved');
      if (sql.prepare('SELECT runId FROM execution_reservations WHERE runId=?').get(runId)) reasons.push('Execution ownership remains reserved');
      if ((sql.prepare('SELECT * FROM execution_attempts WHERE runId=?').all(runId) as AttemptRow[]).map(decodeAttempt).some(item => !item.outcome)) reasons.push('Execution liveness is unresolved');
      if (sql.prepare("SELECT id FROM execution_checkpoints WHERE runId=? AND state='resumable'").get(runId)) reasons.push('A resumable checkpoint retains execution artifacts');
      const hasClaims = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'").get();
      if (hasClaims && (sql.prepare("SELECT json FROM work_claims WHERE state!='settled'").all() as { json: string }[]).some(row => { const claim = persistedJson(JSON.parse(row.json)) as { runId?: unknown } | null; return claim?.runId === runId; })) reasons.push('Task source ownership remains unsettled');
      const hasOperations = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get();
      if (hasOperations) {
        const columns = sql.pragma('table_info(operations)') as Array<{ name: string }>;
        if (columns.some(column => column.name === 'runId') && sql.prepare("SELECT id FROM operations WHERE runId=? AND status!='completed'").get(runId)) reasons.push('External operations remain unsettled');
      }
      return reasons.length ? { allowed: false, reasons } : { allowed: true };
    },
    releaseReservation(runId, terminalEvidence) {
      if (!nonempty(runId) || terminalEvidence === null) throw new PersistenceValidationError('Reservation release requires termination evidence');
      transaction(() => {
        rejectUnadoptedLegacy(runId);
        const rows = (sql.prepare('SELECT * FROM execution_attempts WHERE runId=?').all(runId) as AttemptRow[]).map(decodeAttempt);
        if (!rows.length || rows.some(item => !item.outcome)) throw new PersistenceConflictError('Execution ownership is unresolved');
        evidence(rows.at(-1)!, 'reservation-released', terminalEvidence);
        sql.prepare('DELETE FROM execution_reservations WHERE runId=?').run(runId);
      });
    },
  };
  return store;
}
