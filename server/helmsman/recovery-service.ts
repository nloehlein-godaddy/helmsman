import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdmissionStore } from './admission-store';
import type { Db } from './db';
import type { ExecutionStore } from './execution-store';
import type { OperationStore, OperatorResolution } from './operations';
import type { PluginLifecycle } from './plugins/lifecycle';
import type { LegacyExecutionAdoption } from './legacy-execution-adoption';
import { persistedJson } from './persistence';

export type RecoveryAction = 'retry-attachment' | 'stop-execution' | 'reconcile-operation' | 'cancel-admission' | 'retire-checkpoint' | 'resolve-operation';
interface Actions { actions: RecoveryAction[] }
export interface RecoverySnapshot {
  version: 1; mode: 'normal' | 'safe-start'; readOnly: boolean; errors: string[]; truncated: boolean;
  runs: (Actions & { id: string; repo: string; status: string; attempt: number; attachment: string; blockedReason: string | null; protected: boolean })[];
  attempts: (Actions & { runId: string; repo: string; attempt: number; preparation: string; attachment: string; processStatus: string | null; diagnosticCode: string | null; protected: boolean })[];
  admissions: (Actions & { runId: string; repo: string; state: string })[];
  reservations: { runId: string; repo: string; reason: string }[];
  pins: { kind: string; ownerId: string; pluginId: string; artifactHash: string }[];
  checkpoints: (Actions & { id: string; runId: string; attempt: number; state: string; format: string })[];
  operations: (Actions & { id: string; runId: string | null; type: string; status: string; providerId: string; attemptCount: number;
    evidence: { sequence: number; generation: number; kind: string; at: string; hasEvidence: boolean }[] })[];
  lifecycle: { id: string; artifactHash: string; desiredEnabled: boolean; health: string; state: string; blockers: { kind: string; ownerId: string }[] }[];
}

export interface RecoveryCallbacks {
  retryAttachment?(runId: string): Promise<unknown>;
  requestStop?(runId: string): void | Promise<void>;
  reconcileOperation?(id: string): Promise<unknown>;
  cancelAdmission?(runId: string, resolution: OperatorResolution): void | Promise<void>;
  retireCheckpoint?(id: string, resolution: OperatorResolution): void | Promise<void>;
  resolveOperation?(id: string, resolution: OperatorResolution & { outcome: 'acknowledged' | 'definitely-not-applied' }): void | Promise<void>;
}
export interface RecoveryService { snapshot(repo?: string | null): RecoverySnapshot; act(input: unknown): Promise<void>; }
export class RecoveryActionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Row = Record<string, unknown>;
interface RecoverySource {
  runs(): Iterable<unknown>;
  attempts(): Iterable<unknown>;
  admissions(): Iterable<unknown>;
  reservations(): Iterable<unknown>;
  pins(): Iterable<unknown>;
  checkpoints(): Iterable<unknown>;
  operations(): Iterable<unknown>;
  evidence(id: string): Iterable<unknown>;
  lifecycle(): Iterable<unknown>;
  repoFor(runId: string): string | null;
}
const row = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery metadata');
  return value as Row;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d_.:-]{0,255}$/i.test(value)) throw new Error('Invalid recovery identity');
  return value;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid recovery count');
  return Number(value);
};
const state = (value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('Invalid recovery state');
  return value;
};
export function validRecoveryRepo(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^[a-z\d_-][a-z\d_.-]*\/[a-z\d_-][a-z\d_.-]*$/i.test(value);
}
const repoName = (value: unknown): string => {
  if (typeof value !== 'string' || !validRecoveryRepo(value)) throw new Error('Invalid galleon');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) throw new Error('Invalid artifact hash');
  return value;
};
const LIMIT = 1000;

function project(source: RecoverySource, readOnly: boolean, callbacks: RecoveryCallbacks, repo: string | null): RecoverySnapshot {
  const result: RecoverySnapshot = { version: 1, mode: readOnly ? 'safe-start' : 'normal', readOnly, errors: [], truncated: false,
    runs: [], attempts: [], admissions: [], reservations: [], pins: [], checkpoints: [], operations: [], lifecycle: [] };
  const scoped = (value: string | null) => repo === null || value?.toLowerCase() === repo.toLowerCase();
  const actions = (available: (RecoveryAction | false | undefined)[]): RecoveryAction[] => readOnly ? [] : available.filter((value): value is RecoveryAction => Boolean(value));
  const snapshotOwners = new Set<string>();
  function records<T>(name: string, read: () => Iterable<unknown>, parse: (value: Row) => T | null): T[] {
    const values: T[] = [];
    try {
      const input = read();
      if (!input || typeof input[Symbol.iterator] !== 'function') throw new Error('Invalid inventory');
      for (const value of input) {
        try {
          const parsed = parse(row(value));
          if (parsed !== null) {
            if (values.length === LIMIT) { result.truncated = true; break; }
            values.push(parsed);
          }
        } catch { if (!result.errors.includes(`${name} metadata is incomplete or invalid.`)) result.errors.push(`${name} metadata is incomplete or invalid.`); }
      }
    } catch { result.errors.push(`${name} metadata could not be read; stored data was preserved.`); }
    return values;
  }
  result.reservations = records('Reservation', source.reservations, value => {
    const repo = repoName(value.repo);
    return scoped(repo) ? { runId: id(value.runId), repo, reason: state(value.reason, ['prepared', 'executing', 'unresolved']) } : null;
  });
  result.attempts = records('Execution', source.attempts, value => {
    const runId = id(value.runId), foundRepo = source.repoFor(runId);
    if (!scoped(foundRepo)) return null;
    const repo = repoName(foundRepo);
    snapshotOwners.add(id(value.snapshotId));
    const attachment = state(value.attachment, ['pending', 'attached', 'blocked', 'failed']);
    return { runId, repo, attempt: count(value.attempt), preparation: state(value.preparation, ['prepared', 'ready', 'launching', 'launched']), attachment,
      processStatus: value.outcome == null ? null : state(row(value.outcome).status, ['succeeded', 'failed', 'stopped']),
      diagnosticCode: value.diagnostic == null ? null : id(row(value.diagnostic).code),
      protected: result.reservations.some(item => item.runId === runId),
      actions: actions([attachment !== 'attached' && callbacks.retryAttachment && 'retry-attachment',
        attachment === 'attached' && value.outcome == null && callbacks.requestStop && 'stop-execution']) };
  });
  result.runs = records('Run', source.runs, value => {
    const repo = repoName(value.repo), runId = id(value.id);
    if (!scoped(repo)) return null;
    const attempt = count(value.attempt);
    const attached = result.attempts.find(item => item.runId === runId && item.attempt === attempt);
    return { id: runId, repo, status: state(value.status, ['running', 'succeeded', 'failed', 'stopped']), attempt,
      attachment: readOnly ? 'blocked' : attached?.attachment ?? 'blocked',
      protected: value.recoveryProtected === true || result.reservations.some(item => item.runId === runId),
      blockedReason: readOnly ? 'Provider recovery is disabled in safe start.' : !attached ? 'Legacy execution requires verified binding and ownership adoption.' : attached.attachment === 'attached' ? null : 'Execution ownership or required dependencies need reconciliation.',
      actions: attached?.actions ?? [] };
  });
  result.admissions = records('Admission', source.admissions, value => {
    const repo = repoName(value.repo);
    return scoped(repo) ? { runId: id(value.runId), repo, state: state(value.state, ['pending', 'blocked', 'started', 'failed']),
      actions: actions([['pending', 'blocked'].includes(String(value.state)) && callbacks.cancelAdmission && 'cancel-admission']) } : null;
  });
  result.checkpoints = records('Checkpoint', source.checkpoints, value => {
    const runId = id(value.runId);
    return scoped(source.repoFor(runId)) ? { id: id(value.id), runId, attempt: count(value.attempt),
      state: state(value.state, ['resumable', 'retired']), format: id(value.format),
      actions: actions([value.state === 'resumable' && callbacks.retireCheckpoint && 'retire-checkpoint']) } : null;
  });
  result.operations = records('Operation', source.operations, value => {
    const operationId = id(value.id), origin = row(value.origin), binding = row(value.binding);
    const runId = origin.runId === null ? null : id(origin.runId);
    const target = value.target && typeof value.target === 'object' && !Array.isArray(value.target) ? value.target as Row : null;
    const targetRepo = typeof target?.repo === 'string' && validRecoveryRepo(target.repo) ? target.repo : null;
    if (!scoped(runId ? source.repoFor(runId) : targetRepo)) return null;
    const status = state(value.status, ['pending', 'leased', 'retrying', 'blocked', 'uncertain', 'completed']);
    const pluginId = id(binding.pluginId);
    if (typeof binding.contributionId !== 'string') throw new Error('Invalid provider identity');
    const contributionId = binding.contributionId.split('/').map(part => id(part)).join('/');
    const providerId = contributionId.startsWith(`${pluginId}/`) ? contributionId : `${pluginId}/${contributionId}`;
    const evidence = records('Operation evidence', () => source.evidence(operationId), event => {
      if (typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid evidence timestamp');
      return { sequence: count(event.sequence), generation: count(event.generation), kind: id(event.kind), at: event.at, hasEvidence: event.evidence !== null && event.evidence !== undefined };
    });
    return { id: operationId, runId, type: id(value.kind), status, providerId, attemptCount: count(value.deliveryAttempts), evidence,
      actions: actions([status !== 'completed' && status !== 'leased' && callbacks.reconcileOperation && 'reconcile-operation',
        ['blocked', 'uncertain'].includes(status) && callbacks.resolveOperation && 'resolve-operation']) };
  });
  result.pins = records('Artifact pin', source.pins, value => {
    const kind = state(value.kind, ['admission', 'execution', 'checkpoint', 'operation', 'dependency']), ownerId = id(value.ownerId);
    if (repo !== null && !(kind === 'checkpoint' && result.checkpoints.some(item => item.id === ownerId)
      || kind === 'operation' && result.operations.some(item => item.id === ownerId)
      || kind === 'admission' && result.admissions.some(item => item.runId === ownerId)
      || kind === 'execution' && snapshotOwners.has(ownerId))) return null;
    return { kind, ownerId, pluginId: id(value.pluginId), artifactHash: hash(value.artifactHash) };
  });
  result.lifecycle = records('Plugin lifecycle', source.lifecycle, value => {
    const pluginId = id(value.pluginId);
    if (typeof value.desiredEnabled !== 'boolean') throw new Error('Invalid desired lifecycle');
    return { id: pluginId, artifactHash: hash(value.artifactHash), desiredEnabled: value.desiredEnabled,
      health: state(value.health, ['inactive', 'active', 'failed']), state: state(value.state, ['installed', 'active', 'draining', 'disabled', 'failed']),
      blockers: result.pins.filter(pin => pin.pluginId === pluginId).map(pin => ({ kind: pin.kind, ownerId: pin.ownerId })) };
  });
  return result;
}

export function createRecoveryService(options: {
  db: Pick<Db, 'activeRuns' | 'getRun'>; executions: ExecutionStore; admissions: AdmissionStore; operations: OperationStore;
  lifecycle: Pick<PluginLifecycle, 'list'>; callbacks?: RecoveryCallbacks; legacy?: Pick<LegacyExecutionAdoption, 'list'>;
}): RecoveryService {
  const callbacks = options.callbacks ?? {};
  const source: RecoverySource = {
    runs: () => [...new Map([
      ...options.db.activeRuns(),
      ...(options.legacy?.list() ?? []).filter(item => item.protected).map(item => ({ ...options.db.getRun(item.runId), ...item, id: item.runId, recoveryProtected: true })),
    ].map(item => [item.id, item])).values()],
    attempts: () => [...new Map([...options.executions.recoverable(), ...options.db.activeRuns().flatMap(run => {
      const attempt = options.executions.attempt({ runId: run.id, attempt: run.attempt }); return attempt ? [attempt] : [];
    })].map(value => [`${value.runId}:${value.attempt}`, value])).values()],
    admissions: () => options.admissions.pending(), reservations: () => options.executions.reservations(), pins: () => options.executions.pins(),
    checkpoints: () => [...new Set(options.executions.pins().filter(pin => pin.kind === 'checkpoint').map(pin => pin.ownerId))].flatMap(id => {
      const value = options.executions.checkpoint(id); return value ? [value] : [];
    }),
    operations: () => options.operations.list(), evidence: id => options.operations.attempts(id), lifecycle: () => options.lifecycle.list(),
    repoFor: runId => options.db.getRun(runId)?.repo ?? options.admissions.get(runId)?.repo ?? null,
  };
  const service: RecoveryService = {
    snapshot(repo = null) {
      if (!validRecoveryRepo(repo)) throw new RecoveryActionError(400, 'Invalid galleon filter.');
      return project(source, false, callbacks, repo);
    },
    async act(input) {
      let value: Row;
      try { value = row(persistedJson(input)); } catch { throw new RecoveryActionError(400, 'Invalid recovery action.'); }
      const action = value.action;
      if (!['retry-attachment', 'stop-execution', 'reconcile-operation', 'cancel-admission', 'retire-checkpoint', 'resolve-operation'].includes(String(action))) throw new RecoveryActionError(400, 'Unknown recovery action.');
      const runAction = action === 'retry-attachment' || action === 'stop-execution' || action === 'cancel-admission';
      const isResolution = !['retry-attachment', 'stop-execution', 'reconcile-operation'].includes(String(action));
      const fields = ['action', runAction ? 'runId' : 'id', ...(isResolution ? ['actor', 'reason', 'evidence'] : []), ...(action === 'resolve-operation' ? ['outcome'] : [])];
      if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new RecoveryActionError(400, 'Recovery action fields are invalid.');
      let target: string;
      try { target = id(value[runAction ? 'runId' : 'id']); } catch { throw new RecoveryActionError(400, 'Invalid recovery target.'); }
      const snapshot = service.snapshot();
      const entry = action === 'retry-attachment' || action === 'stop-execution' ? snapshot.attempts.find(item => item.runId === target)
        : action === 'cancel-admission' ? snapshot.admissions.find(item => item.runId === target)
          : action === 'retire-checkpoint' ? snapshot.checkpoints.find(item => item.id === target) : snapshot.operations.find(item => item.id === target);
      if (!entry?.actions.includes(action as RecoveryAction)) throw new RecoveryActionError(409, 'This recovery action is unavailable for the retained state.');
      let resolution: OperatorResolution | undefined;
      if (isResolution) {
        if (typeof value.actor !== 'string' || !value.actor.trim() || value.actor.length > 256 || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000
          || value.evidence === null || value.evidence === undefined || Buffer.byteLength(JSON.stringify(value.evidence)) > 16_384) throw new RecoveryActionError(400, 'Actor, reason, and bounded evidence are required.');
        resolution = { actor: value.actor.trim(), reason: value.reason.trim(), evidence: persistedJson(value.evidence) };
      }
      if (action === 'retry-attachment') await callbacks.retryAttachment!(target);
      else if (action === 'stop-execution') await callbacks.requestStop!(target);
      else if (action === 'reconcile-operation') await callbacks.reconcileOperation!(target);
      else if (action === 'cancel-admission') await callbacks.cancelAdmission!(target, resolution!);
      else if (action === 'retire-checkpoint') await callbacks.retireCheckpoint!(target, resolution!);
      else {
        if (value.outcome !== 'acknowledged' && value.outcome !== 'definitely-not-applied') throw new RecoveryActionError(400, 'Invalid operation resolution outcome.');
        await callbacks.resolveOperation!(target, { ...resolution!, outcome: value.outcome });
      }
    },
  };
  return service;
}

export function withReadonlyRecoveryCopy<T>(path: string, read: (sql: Database.Database) => T): T {
  let sql: Database.Database | undefined;
  let scratch: string | undefined;
  try {
    const suffixes = ['', '-wal', '-journal'];
    const fingerprint = () => suffixes.map(suffix => {
      if (!existsSync(`${path}${suffix}`)) return null;
      const stat = statSync(`${path}${suffix}`, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    });
    const before = fingerprint();
    scratch = mkdtempSync(join(tmpdir(), 'helmsman-recovery-'));
    const copy = join(scratch, 'state.sqlite');
    for (const [index, suffix] of suffixes.entries()) if (before[index] !== null) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    if (JSON.stringify(before) !== JSON.stringify(fingerprint())) throw new Error('Recovery source changed while reading');
    // SQLite can create WAL sidecars even on readonly connections; inspect a stable private copy.
    sql = new Database(copy, { readonly: true, fileMustExist: true }); sql.pragma('query_only = ON');
    return read(sql);
  } finally { sql?.close(); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

export function readRecoverySnapshot(path: string, repo: string | null = null): RecoverySnapshot {
  const empty: RecoverySource = { runs: () => [], attempts: () => [], admissions: () => [], reservations: () => [], pins: () => [], checkpoints: () => [], operations: () => [], evidence: () => [], lifecycle: () => [], repoFor: () => null };
  if (!validRecoveryRepo(repo)) throw new RecoveryActionError(400, 'Invalid galleon filter.');
  if (!existsSync(path)) return project(empty, true, {}, repo);
  try {
    return withReadonlyRecoveryCopy(path, connection => {
      const hasTable = (table: string) => Boolean(connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
      const read = (table: string, where = '', parameters: string[] = []): Iterable<Row> => hasTable(table)
        ? connection.prepare(`SELECT * FROM ${table} ${where}`).iterate(...parameters) as Iterable<Row> : [];
      const json = (value: unknown): Row => { if (typeof value !== 'string') throw new Error('Invalid stored JSON'); return row(JSON.parse(value)); };
      function* decode(values: Iterable<Row>, transform: (value: Row) => Row | null): Iterable<unknown> {
        for (const value of values) {
          try { const parsed = transform(value); if (parsed !== null) yield parsed; }
          catch { yield null; }
        }
      }
      const repoFor = (runId: string): string | null => {
        const run = hasTable('runs') ? connection.prepare('SELECT repo FROM runs WHERE id=?').get(runId) as Row | undefined : undefined;
        if (run) return repoName(run.repo);
        const admission = hasTable('execution_admissions') ? connection.prepare('SELECT json FROM execution_admissions WHERE runId=?').get(runId) as Row | undefined : undefined;
        return admission ? repoName(json(admission.json).repo) : null;
      };
      const source: RecoverySource = {
        runs: () => decode(read('runs', `WHERE status='running'${hasTable('legacy_execution_obligations') ? ' OR id IN (SELECT runId FROM legacy_execution_obligations WHERE protected=1)' : ''}`), value => ({
          ...value, recoveryProtected: hasTable('legacy_execution_obligations') && Boolean(connection.prepare('SELECT 1 FROM legacy_execution_obligations WHERE runId=? AND protected=1').get(id(value.id))),
        })),
        attempts: () => decode(read('execution_attempts'), value => {
          const attempt = json(value.json);
          if (attempt.outcome == null) return attempt;
          const run = hasTable('runs') ? connection.prepare('SELECT status FROM runs WHERE id=?').get(id(attempt.runId)) as Row | undefined : undefined;
          return run?.status === 'running' ? attempt : null;
        }),
        admissions: () => decode(read('execution_admissions', "WHERE state IN ('pending','blocked')"), value => ({ ...json(value.json), state: value.state })),
        reservations: function* () {
          const reserved = new Set<string>();
          for (const value of read('execution_reservations')) { reserved.add(id(value.runId)); yield value; }
          for (const value of read('legacy_execution_obligations', "WHERE protected=1 AND status='running'")) {
            if (!reserved.has(id(value.runId))) yield { runId: value.runId, repo: value.repo, reason: 'unresolved' };
          }
        }, pins: () => read('artifact_pins'),
        checkpoints: () => decode(read('execution_checkpoints', "WHERE state='resumable'"), value => json(value.json)),
        operations: () => decode(read('operations'), value => ({ ...json(value.draft), id: value.id, status: value.status, deliveryAttempts: value.deliveryAttempts })),
        evidence: id => decode(read('operation_attempts', 'WHERE operationId=? ORDER BY sequence', [id]), value => ({ ...value, evidence: value.evidence === 'null' ? null : true })),
        lifecycle: () => decode(read('plugin_lifecycle'), value => ({ ...value, desiredEnabled: value.desiredEnabled === 1,
          state: value.health === 'failed' ? 'failed' : value.desiredEnabled === 1 ? value.health === 'active' ? 'active' : 'installed'
            : hasTable('artifact_pins') && connection.prepare('SELECT 1 FROM artifact_pins WHERE pluginId=? LIMIT 1').get(id(value.pluginId)) ? 'draining' : 'disabled' })),
        repoFor,
      };
      return connection.transaction(() => project(source, true, {}, repo))();
    });
  } catch {
    const result = project(empty, true, {}, repo);
    result.errors.push('Stored recovery metadata could not be read; files were left unchanged.');
    return result;
  }
}
