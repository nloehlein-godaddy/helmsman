import { randomUUID } from 'node:crypto';
import type { PluginJson } from '../../src/plugins/backend';
import type { ArtifactBinding, ExecutionStore, ProviderBinding } from './execution-store';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export type OperationStatus = 'pending' | 'leased' | 'retrying' | 'blocked' | 'uncertain' | 'completed';
export interface OperationOrigin { kind: string; id: string; revision: string; runId: string | null; attempt: number | null; }
export interface OperationRetry { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; }
export interface OperationDraft {
  version: 1;
  key: string;
  kind: string;
  origin: OperationOrigin;
  binding: ProviderBinding;
  artifacts: readonly ArtifactBinding[];
  target: PluginJson;
  payload: PluginJson;
  dependencies?: readonly string[];
  retry?: OperationRetry;
}
export interface DurableOperation extends Omit<OperationDraft, 'dependencies' | 'retry'> {
  id: string;
  contentHash: string;
  dependencies: readonly string[];
  retry: OperationRetry;
  status: OperationStatus;
  generation: number;
  deliveryAttempts: number;
  requiresReconciliation: boolean;
  retryAt: string | null;
  leaseExpiresAt: string | null;
  receipt: PluginJson;
  diagnostic: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface OperationLease { operationId: string; token: string; generation: number; expiresAt: string; requiresReconciliation: boolean; }
export type OperationResult =
  | { status: 'acknowledged'; receipt: PluginJson }
  | { status: 'definitely-not-applied'; evidence: PluginJson; retryable: boolean; reason: string }
  | { status: 'unknown'; evidence: PluginJson; reason: string }
  | { status: 'blocked'; evidence: PluginJson; reason: string };
export interface OperationEvidence {
  sequence: number;
  operationId: string;
  generation: number;
  kind: string;
  at: string;
  evidence: PluginJson;
}
export interface OperatorResolution { actor: string; reason: string; evidence: PluginJson; }
export interface OperationStore {
  assertDispatchAllowed(): void;
  enqueue(draft: OperationDraft): DurableOperation;
  get(id: string): DurableOperation | null;
  byKey(key: string): DurableOperation | null;
  list(filter?: { runId?: string; statuses?: readonly OperationStatus[] }): readonly DurableOperation[];
  attempts(id: string): readonly OperationEvidence[];
  lease(id: string, ttlMs: number, options?: { reconcile?: boolean }): OperationLease | null;
  renew(lease: OperationLease, ttlMs: number): OperationLease;
  markInvoked(lease: OperationLease): void;
  settle(lease: OperationLease, result: OperationResult): DurableOperation;
  retry(id: string, resolution: OperatorResolution): DurableOperation;
  resolve(id: string, resolution: OperatorResolution & { outcome: 'acknowledged' | 'definitely-not-applied' }): DurableOperation;
}

const statuses: readonly OperationStatus[] = ['pending', 'leased', 'retrying', 'blocked', 'uncertain', 'completed'];
const defaultRetry: OperationRetry = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const label = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function draftValue(input: unknown): Required<OperationDraft> {
  const value = persistedJson(input) as unknown as OperationDraft;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key => !['version', 'key', 'kind', 'origin', 'binding', 'artifacts', 'target', 'payload', 'dependencies', 'retry'].includes(key))
    || !label(value.key) || !label(value.kind, 100) || !value.origin || !label(value.origin.kind, 100) || !label(value.origin.id)
    || !label(value.origin.revision) || value.origin.runId !== null && !label(value.origin.runId, 128)
    || value.origin.attempt !== null && !integer(value.origin.attempt, 1, Number.MAX_SAFE_INTEGER)
    || (value.origin.runId === null) !== (value.origin.attempt === null)) throw new PersistenceValidationError('Invalid operation identity or origin');
  const binding = value.binding;
  if (!binding || !['source', 'agent', 'host', 'workflow', 'effect'].includes(binding.role) || !label(binding.capability)
    || !integer(binding.contractVersion, 1, 1_000_000) || !label(binding.contributionId) || !label(binding.pluginId)
    || !hash(binding.artifactHash) || binding.connectionId !== null && !label(binding.connectionId)
    || binding.credentialHandle !== null && !label(binding.credentialHandle)) throw new PersistenceValidationError('Invalid operation provider binding');
  if (!Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 128
    || value.artifacts.some(item => !item || !label(item.pluginId) || !hash(item.artifactHash) || !label(item.packageVersion)
      || !Array.isArray(item.requires) || item.requires.some((required: unknown) => !label(required)))) throw new PersistenceValidationError('Invalid operation artifact closure');
  const artifacts = [...value.artifacts].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  if (new Set(artifacts.map(item => item.pluginId)).size !== artifacts.length
    || !artifacts.some(item => item.pluginId === binding.pluginId && item.artifactHash === binding.artifactHash)) throw new PersistenceValidationError('Operation binding is absent from its artifact closure');
  const byPlugin = new Map(artifacts.map(item => [item.pluginId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new PersistenceValidationError('Operation artifact dependencies contain a cycle');
    if (visited.has(id)) return;
    const artifact = byPlugin.get(id);
    if (!artifact) throw new PersistenceValidationError('Operation artifact dependency is missing');
    visiting.add(id);
    for (const required of artifact.requires) visit(required);
    visiting.delete(id); visited.add(id);
  };
  for (const artifact of artifacts) visit(artifact.pluginId);
  const dependencies = value.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 128 || dependencies.some(id => !hash(id))
    || new Set(dependencies).size !== dependencies.length) throw new PersistenceValidationError('Invalid operation dependencies');
  const retry = value.retry ?? defaultRetry;
  if (!retry || !integer(retry.maxAttempts, 1, 100) || !integer(retry.baseDelayMs, 1, 86_400_000)
    || !integer(retry.maxDelayMs, retry.baseDelayMs, 7 * 86_400_000)) throw new PersistenceValidationError('Invalid operation retry policy');
  if (value.target === undefined || value.payload === undefined) throw new PersistenceValidationError('Operation target and payload are required');
  return persistedJson({ ...value, artifacts, dependencies: [...dependencies].sort(), retry }) as unknown as Required<OperationDraft>;
}

const schema = `
  CREATE TABLE operations (
    id TEXT PRIMARY KEY, logicalKey TEXT NOT NULL UNIQUE, runId TEXT, contentHash TEXT NOT NULL, draft TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','leased','retrying','blocked','uncertain','completed')),
    generation INTEGER NOT NULL DEFAULT 0, leaseToken TEXT, leaseExpiresAt TEXT,
    deliveryAttempts INTEGER NOT NULL DEFAULT 0, requiresReconciliation INTEGER NOT NULL DEFAULT 0,
    retryAt TEXT, receipt TEXT NOT NULL DEFAULT 'null', diagnostic TEXT NOT NULL DEFAULT 'null',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE operation_attempts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL, generation INTEGER NOT NULL,
    kind TEXT NOT NULL, at TEXT NOT NULL, evidence TEXT NOT NULL
  );
  CREATE INDEX operation_attempts_owner ON operation_attempts(operationId, sequence);
`;
const columns = {
  operations: ['id', 'logicalKey', 'runId', 'contentHash', 'draft', 'status', 'generation', 'leaseToken', 'leaseExpiresAt', 'deliveryAttempts', 'requiresReconciliation', 'retryAt', 'receipt', 'diagnostic', 'createdAt', 'updatedAt'],
  operation_attempts: ['sequence', 'operationId', 'generation', 'kind', 'at', 'evidence'],
};
interface Row {
  id: string; logicalKey: string; runId: string | null; contentHash: string; draft: string; status: OperationStatus; generation: number;
  leaseToken: string | null; leaseExpiresAt: string | null; deliveryAttempts: number; requiresReconciliation: number;
  retryAt: string | null; receipt: string; diagnostic: string; createdAt: string; updatedAt: string;
}

export function openOperationStore(persistence: Persistence, executions: Pick<ExecutionStore, 'retainPins' | 'releasePins'>, options: { now?: () => number } = {}): OperationStore {
  const { sql } = persistence;
  const now = options.now ?? Date.now;
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new PersistenceValidationError('Invalid operation clock');
    return value;
  };
  const iso = () => new Date(time()).toISOString();
  const validate = () => { for (const [table, names] of Object.entries(columns)) validateTableColumns(sql, table, names); };
  migrateOwned(sql, {
    owner: 'core.operations', version: 1, checksum: persistenceHash(schema), tables: Object.keys(columns),
    validateLegacy: () => {
      const present = Object.keys(columns).filter(table => sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
      if (!present.length) return null;
      validate(); return 1;
    },
    apply: (_sql, from) => { if (from === 0) sql.exec(schema); }, validateCurrent: validate,
  });
  function decode(row: Row): DurableOperation {
    const draft = draftValue(JSON.parse(row.draft));
    const diagnostic = persistedJson(JSON.parse(row.diagnostic)) as unknown as DurableOperation['diagnostic'];
    if (!hash(row.id) || row.id !== persistenceHash({ key: draft.key }) || row.logicalKey !== draft.key || row.runId !== draft.origin.runId || row.contentHash !== persistenceHash(draft)
      || !statuses.includes(row.status) || !integer(row.generation, 0, Number.MAX_SAFE_INTEGER) || !integer(row.deliveryAttempts, 0, 100)
      || ![0, 1].includes(row.requiresReconciliation) || !timestamp(row.createdAt) || !timestamp(row.updatedAt)
      || row.retryAt !== null && !timestamp(row.retryAt) || row.leaseExpiresAt !== null && !timestamp(row.leaseExpiresAt)
      || row.status === 'leased' && (!label(row.leaseToken) || row.leaseExpiresAt === null)
      || diagnostic !== null && (!label(diagnostic?.code) || !label(diagnostic?.message, 4096))) throw new PersistenceValidationError('Stored operation identity or state is invalid');
    return Object.freeze({ ...draft, id: row.id, contentHash: row.contentHash, status: row.status,
      generation: row.generation, deliveryAttempts: row.deliveryAttempts, requiresReconciliation: row.requiresReconciliation === 1,
      retryAt: row.retryAt, leaseExpiresAt: row.leaseExpiresAt, receipt: persistedJson(JSON.parse(row.receipt)), diagnostic,
      createdAt: row.createdAt, updatedAt: row.updatedAt });
  }
  function row(id: string): Row | null {
    if (!hash(id)) throw new PersistenceValidationError('Invalid operation ID');
    const value = sql.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
    if (!value) return null;
    decode(value); return value;
  }
  function required(id: string): Row {
    const value = row(id);
    if (!value) throw new PersistenceConflictError('Operation is missing');
    return value;
  }
  function event(value: Row, kind: string, evidence: unknown): void {
    sql.prepare('INSERT INTO operation_attempts(operationId,generation,kind,at,evidence) VALUES (?,?,?,?,?)')
      .run(value.id, value.generation, kind, iso(), stableJson(evidence));
  }
  function owned(lease: OperationLease): Row {
    const value = required(lease?.operationId);
    if (value.status !== 'leased' || value.generation !== lease.generation || value.leaseToken !== lease.token
      || !value.leaseExpiresAt || Date.parse(value.leaseExpiresAt) <= time()) throw new PersistenceConflictError('Operation lease is stale or expired');
    return value;
  }
  function duration(ttlMs: number): void {
    if (!integer(ttlMs, 1, 300_000)) throw new PersistenceValidationError('Invalid operation lease duration');
  }
  function setState(value: Row, status: OperationStatus, input: {
    requiresReconciliation?: boolean; retryAt?: string | null; receipt?: PluginJson; diagnostic?: DurableOperation['diagnostic'];
  } = {}): DurableOperation {
    sql.prepare(`UPDATE operations SET status=?,leaseToken=NULL,leaseExpiresAt=NULL,requiresReconciliation=?,retryAt=?,receipt=?,diagnostic=?,updatedAt=? WHERE id=?`)
      .run(status, Number(input.requiresReconciliation ?? value.requiresReconciliation === 1), input.retryAt ?? null,
        stableJson(input.receipt ?? JSON.parse(value.receipt)), stableJson(input.diagnostic ?? null), iso(), value.id);
    return decode(required(value.id));
  }
  function resolutionValue(input: OperatorResolution): OperatorResolution {
    const value = persistedJson(input) as unknown as OperatorResolution;
    if (!value || !label(value.actor, 200) || !label(value.reason, 4096) || value.evidence === null || typeof value.evidence !== 'object') throw new PersistenceValidationError('Operator resolution requires actor, reason, and structured evidence');
    return value;
  }
  function idle(id: string): Row {
    const value = required(id);
    if (value.status === 'completed' || value.status === 'leased' && value.leaseExpiresAt && Date.parse(value.leaseExpiresAt) > time()) throw new PersistenceConflictError('Operation is completed or owned by a live worker');
    return value;
  }
  const store: OperationStore = {
    assertDispatchAllowed() { if (sql.inTransaction) throw new PersistenceConflictError('Dispatch must start after the originating transaction commits'); },
    enqueue(input) {
      const draft = draftValue(input);
      const id = persistenceHash({ key: draft.key });
      const contentHash = persistenceHash(draft);
      return persistence.transaction(() => {
        const existing = row(id);
        if (existing) {
          if (existing.contentHash !== contentHash) throw new PersistenceConflictError('Logical operation already has a different payload, target, or binding');
          return decode(existing);
        }
        for (const dependency of draft.dependencies) {
          if (dependency === id || !row(dependency)) throw new PersistenceValidationError('Operation dependency must be a previously enqueued operation');
        }
        sql.prepare(`INSERT INTO operations(id,logicalKey,runId,contentHash,draft,status,createdAt,updatedAt) VALUES (?,?,?,?,?,'pending',?,?)`)
          .run(id, draft.key, draft.origin.runId, contentHash, stableJson(draft), iso(), iso());
        executions.retainPins(draft.artifacts.map(artifact => ({ kind: 'operation', ownerId: id, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash })));
        event(required(id), 'enqueued', { contentHash });
        return decode(required(id));
      });
    },
    get: id => { const value = row(id); return value ? decode(value) : null; },
    byKey: key => { if (!label(key)) throw new PersistenceValidationError('Invalid operation key'); return store.get(persistenceHash({ key })); },
    list(filter = {}) {
      if (filter.statuses?.some(status => !statuses.includes(status))) throw new PersistenceValidationError('Invalid operation status filter');
      return Object.freeze((sql.prepare('SELECT * FROM operations ORDER BY createdAt,id').all() as Row[]).map(decode)
        .filter(value => (filter.runId === undefined || value.origin.runId === filter.runId) && (!filter.statuses || filter.statuses.includes(value.status))));
    },
    attempts(id) {
      required(id);
      const values = sql.prepare('SELECT * FROM operation_attempts WHERE operationId=? ORDER BY sequence').all(id) as Array<Omit<OperationEvidence, 'evidence'> & { evidence: string }>;
      return Object.freeze(values.map(value => Object.freeze({ ...value, evidence: persistedJson(JSON.parse(value.evidence)) })));
    },
    lease(id, ttlMs, leaseOptions = {}) {
      duration(ttlMs);
      return persistence.transaction(() => {
        const value = required(id);
        const operation = decode(value);
        if (value.status === 'completed' || value.status === 'blocked' && operation.diagnostic?.code === 'delivery-blocked' || value.status === 'leased' && Date.parse(value.leaseExpiresAt!) > time()
          || ['uncertain', 'blocked'].includes(value.status) && !leaseOptions.reconcile
          || value.retryAt && Date.parse(value.retryAt) > time()
          || operation.dependencies.some(dependency => required(dependency).status !== 'completed')) return null;
        if (value.status === 'leased') event(value, 'expired', { invoked: value.requiresReconciliation === 1 });
        const token = randomUUID();
        const expiresAt = new Date(time() + ttlMs).toISOString();
        sql.prepare(`UPDATE operations SET status='leased',generation=generation+1,leaseToken=?,leaseExpiresAt=?,retryAt=NULL,updatedAt=? WHERE id=?`)
          .run(token, expiresAt, iso(), id);
        const leased = required(id);
        event(leased, 'leased', { requiresReconciliation: leased.requiresReconciliation === 1 });
        return Object.freeze({ operationId: id, token, generation: leased.generation, expiresAt, requiresReconciliation: leased.requiresReconciliation === 1 });
      });
    },
    renew(lease, ttlMs) {
      duration(ttlMs);
      return persistence.transaction(() => {
        const value = owned(lease);
        const expiresAt = new Date(time() + ttlMs).toISOString();
        sql.prepare('UPDATE operations SET leaseExpiresAt=?,updatedAt=? WHERE id=?').run(expiresAt, iso(), value.id);
        return Object.freeze({ ...lease, expiresAt });
      });
    },
    markInvoked(lease) {
      persistence.transaction(() => {
        const value = owned(lease);
        if (value.requiresReconciliation || value.deliveryAttempts >= decode(value).retry.maxAttempts) throw new PersistenceConflictError('Operation requires reconciliation or has exhausted delivery attempts');
        if (sql.prepare("SELECT sequence FROM operation_attempts WHERE operationId=? AND generation=? AND kind='invoked'").get(value.id, value.generation)) throw new PersistenceConflictError('Operation lease already invoked its effect');
        sql.prepare('UPDATE operations SET deliveryAttempts=deliveryAttempts+1,requiresReconciliation=1,updatedAt=? WHERE id=?').run(iso(), value.id);
        event(value, 'invoked', { contentHash: value.contentHash });
      });
    },
    settle(lease, supplied) {
      const result = persistedJson(supplied) as unknown as OperationResult;
      if (!result || !['acknowledged', 'definitely-not-applied', 'unknown', 'blocked'].includes(result.status)
        || result.status === 'acknowledged' && (result.receipt === null || result.receipt === undefined)
        || result.status !== 'acknowledged' && (!label(result.reason, 4096) || result.evidence === undefined)
        || result.status === 'definitely-not-applied' && typeof result.retryable !== 'boolean') throw new PersistenceValidationError('Invalid operation result');
      return persistence.transaction(() => {
        const value = owned(lease);
        const operation = decode(value);
        event(value, result.status, result);
        if (result.status === 'acknowledged') {
          const done = setState(value, 'completed', { receipt: result.receipt, requiresReconciliation: false });
          executions.releasePins('operation', value.id);
          return done;
        }
        if (result.status === 'definitely-not-applied') {
          const retrying = result.retryable && operation.deliveryAttempts < operation.retry.maxAttempts;
          const delay = Math.min(operation.retry.maxDelayMs, operation.retry.baseDelayMs * 2 ** Math.min(30, Math.max(0, operation.deliveryAttempts - 1)));
          return setState(value, retrying ? 'retrying' : 'blocked', { requiresReconciliation: false,
            retryAt: retrying ? new Date(time() + delay).toISOString() : null,
            diagnostic: { code: retrying ? 'not-applied' : 'delivery-blocked', message: result.reason } });
        }
        return setState(value, result.status === 'unknown' ? 'uncertain' : 'blocked', {
          requiresReconciliation: result.status === 'unknown' || operation.requiresReconciliation,
          diagnostic: { code: result.status, message: result.reason },
        });
      });
    },
    retry(id, supplied) {
      const resolution = resolutionValue(supplied);
      return persistence.transaction(() => {
        const value = idle(id);
        event(value, 'operator-retry', resolution);
        return setState(value, value.requiresReconciliation ? 'uncertain' : 'pending');
      });
    },
    resolve(id, supplied) {
      const resolution = resolutionValue(supplied);
      if (!['acknowledged', 'definitely-not-applied'].includes(supplied.outcome)) throw new PersistenceValidationError('Invalid operator outcome');
      return persistence.transaction(() => {
        const value = idle(id);
        event(value, 'operator-resolution', { ...resolution, outcome: supplied.outcome });
        const next = setState(value, supplied.outcome === 'acknowledged' ? 'completed' : 'pending', {
          requiresReconciliation: false,
          receipt: supplied.outcome === 'acknowledged' ? { actor: resolution.actor, reason: resolution.reason, evidence: resolution.evidence } : null,
        });
        if (next.status === 'completed') executions.releasePins('operation', id);
        return next;
      });
    },
  };
  return store;
}
