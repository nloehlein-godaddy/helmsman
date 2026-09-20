import type { PluginJson } from '../../src/plugins/backend';
import type { ArtifactBinding, ExecutionStore } from './execution-store';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface AdmissionInput {
  runId: string;
  repo: string;
  request: PluginJson;
  settings: PluginJson;
  artifacts: readonly ArtifactBinding[];
}
export interface Admission extends AdmissionInput {
  contentHash: string;
  state: 'pending' | 'blocked' | 'started' | 'failed';
  reason: string | null;
  createdAt: string;
}
export interface AdmissionStore {
  admit(input: AdmissionInput, maxConcurrency: number): Admission;
  get(runId: string): Admission | null;
  pending(): readonly Admission[];
  started(runId: string): void;
  block(runId: string, reason: string): void;
  fail(runId: string, reason: string): void;
}

const DDL = 'CREATE TABLE execution_admissions (runId TEXT PRIMARY KEY,contentHash TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,createdAt TEXT NOT NULL)';

export function openAdmissionStore(persistence: Persistence, executions: ExecutionStore): AdmissionStore {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.admissions', version: 1, checksum: persistenceHash(DDL), tables: ['execution_admissions'],
    validateLegacy: () => null, apply: () => { sql.exec(DDL); },
    validateCurrent: () => validateTableColumns(sql, 'execution_admissions', ['runId', 'contentHash', 'json', 'state', 'reason', 'createdAt']),
  });
  function validate(input: AdmissionInput): AdmissionInput {
    const value = persistedJson(input) as unknown as AdmissionInput;
    if (!/^[a-z\d_-]{1,128}$/i.test(value?.runId) || typeof value.repo !== 'string' || !value.repo.trim()
      || !Array.isArray(value.artifacts) || !value.artifacts.length || !('request' in value) || !('settings' in value)
      || value.artifacts.some(artifact => !artifact || typeof artifact.pluginId !== 'string' || !artifact.pluginId
        || !/^[a-f\d]{64}$/.test(artifact.artifactHash) || typeof artifact.packageVersion !== 'string'
        || !Array.isArray(artifact.requires))) throw new PersistenceValidationError('Invalid admission intent');
    return value;
  }
  function decode(row: { runId: string; contentHash: string; json: string; state: Admission['state']; reason: string | null; createdAt: string }): Admission {
    const input = validate(JSON.parse(row.json));
    if (input.runId !== row.runId || persistenceHash(input) !== row.contentHash || !['pending', 'blocked', 'started', 'failed'].includes(row.state)
      || !Number.isFinite(Date.parse(row.createdAt))) throw new PersistenceValidationError('Admission integrity check failed');
    return { ...input, contentHash: row.contentHash, state: row.state, reason: row.reason, createdAt: row.createdAt };
  }
  const get = (runId: string): Admission | null => {
    const row = sql.prepare('SELECT * FROM execution_admissions WHERE runId=?').get(runId) as Parameters<typeof decode>[0] | undefined;
    return row ? decode(row) : null;
  };
  function change(runId: string, state: Admission['state'], reason: string | null): void {
    const current = get(runId);
    if (!current || ['started', 'failed'].includes(current.state)) throw new PersistenceConflictError('Admission has already settled or is missing');
    sql.prepare('UPDATE execution_admissions SET state=?,reason=? WHERE runId=?').run(state, reason, runId);
  }
  return {
    get,
    pending: () => (sql.prepare("SELECT * FROM execution_admissions WHERE state IN ('pending','blocked') ORDER BY createdAt,runId").all() as Parameters<typeof decode>[0][]).map(decode),
    admit(input, maxConcurrency) {
      const value = validate(input);
      return persistence.transaction(() => {
        const prior = get(value.runId);
        if (prior) {
          if (prior.contentHash !== persistenceHash(value)) throw new PersistenceConflictError('Admission identity has different content');
          return prior;
        }
        executions.reserveAdmission({ runId: value.runId, repo: value.repo, maxConcurrency, evidence: { contentHash: persistenceHash(value) } });
        executions.retainPins(value.artifacts.map(artifact => ({ kind: 'admission', ownerId: value.runId, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash })));
        sql.prepare('INSERT INTO execution_admissions VALUES (?,?,?,\'pending\',NULL,?)').run(value.runId, persistenceHash(value), stableJson(value), new Date().toISOString());
        return get(value.runId)!;
      });
    },
    started(runId) { persistence.transaction(() => {
      if (get(runId)?.state === 'started') return;
      if (!executions.attempt({ runId, attempt: 1 })) throw new PersistenceConflictError('Execution must be prepared before admission settles');
      change(runId, 'started', null);
      executions.releasePins('admission', runId);
    }); },
    block(runId, reason) {
      if (typeof reason !== 'string' || !reason.trim()) throw new PersistenceValidationError('Admission diagnostic is required');
      persistence.transaction(() => change(runId, 'blocked', reason));
    },
    fail(runId, reason) {
      if (typeof reason !== 'string' || !reason.trim()) throw new PersistenceValidationError('Admission failure evidence is required');
      persistence.transaction(() => {
        executions.abandonAdmission(runId, { reason, neverLaunched: true });
        change(runId, 'failed', reason);
        executions.releasePins('admission', runId);
      });
    },
  };
}
