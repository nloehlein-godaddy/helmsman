import { executionMigrationReadiness } from './execution-schema';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface GalleonExecutionPolicy { version: 1; repo: string; revision: number; maxConcurrentRuns: number }
export interface ExecutionPolicyCommand { caller: string; requestId: string; repo: string; expectedRevision: number; maxConcurrentRuns: number }
const ddl = `CREATE TABLE execution_policies(repo TEXT PRIMARY KEY COLLATE NOCASE,revision INTEGER NOT NULL CHECK(revision>=1),maximum INTEGER NOT NULL CHECK(maximum BETWEEN 1 AND 20));
CREATE TABLE execution_policy_commands(caller TEXT NOT NULL,requestId TEXT NOT NULL,inputHash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(caller,requestId));`;
const repoName = (value: string) => {
  if (typeof value !== 'string' || !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(value)) throw new PersistenceValidationError('Invalid execution policy galleon');
  return value.toLowerCase();
};

export function openExecutionPolicy(persistence: Persistence): {
  read(repo: string): GalleonExecutionPolicy;
  set(input: ExecutionPolicyCommand): GalleonExecutionPolicy;
} {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.execution-policy', version: 1, checksum: persistenceHash(ddl), tables: ['execution_policies', 'execution_policy_commands'],
    validateLegacy: () => null, apply: () => sql.exec(ddl), validateCurrent: () => {
      validateTableColumns(sql, 'execution_policies', ['repo', 'revision', 'maximum']);
      validateTableColumns(sql, 'execution_policy_commands', ['caller', 'requestId', 'inputHash', 'result']);
      for (const definition of ddl.split(';').map(value => value.trim()).filter(Boolean)) {
        const name = /^CREATE TABLE (\w+)/.exec(definition)?.[1];
        const row = name ? sql.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined : undefined;
        if (!row?.sql || row.sql.replace(/\s+/g, '') !== definition.replace(/\s+/g, '')) throw new PersistenceValidationError('Invalid execution policy schema');
      }
    } });
  function read(repo: string): GalleonExecutionPolicy {
    const canonical = repoName(repo);
    const row = sql.prepare('SELECT revision,maximum FROM execution_policies WHERE repo=?').get(canonical) as { revision: number; maximum: number } | undefined;
    if (row && (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.maximum) || row.maximum < 1 || row.maximum > 20)) {
      throw new PersistenceValidationError('Invalid stored execution policy');
    }
    return { version: 1, repo: canonical, revision: row?.revision ?? 0, maxConcurrentRuns: row?.maximum ?? 1 };
  }
  return { read, set(input) {
    if (!input || typeof input.caller !== 'string' || !/^[a-z\d_.:/-]{1,256}$/i.test(input.caller)
      || typeof input.requestId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(input.requestId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !Number.isSafeInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1 || input.maxConcurrentRuns > 20) throw new PersistenceValidationError('Invalid execution policy command');
    const value = { ...input, repo: repoName(input.repo) };
    return persistence.transaction(() => {
      const previous = sql.prepare('SELECT inputHash,result FROM execution_policy_commands WHERE caller=? AND requestId=?').get(value.caller, value.requestId) as { inputHash: string; result: string } | undefined;
      if (previous) {
        if (previous.inputHash !== persistenceHash(value)) throw new PersistenceConflictError('Execution policy request has different content');
        const result = JSON.parse(previous.result) as GalleonExecutionPolicy | null;
        if (result?.version !== 1 || result.repo !== value.repo || result.revision !== value.expectedRevision + 1 || result.maxConcurrentRuns !== value.maxConcurrentRuns) throw new PersistenceValidationError('Invalid execution policy receipt');
        return result;
      }
      const current = read(value.repo);
      if (current.revision !== value.expectedRevision) throw new PersistenceConflictError('Execution policy changed; refresh before saving');
      if (value.maxConcurrentRuns > 1 && (executionMigrationReadiness(sql).currentVersion !== 2 || !executionMigrationReadiness(sql).ready)) throw new PersistenceConflictError('Parallel execution requires compatible ownership schema; retained version 1 obligations must settle first');
      const result: GalleonExecutionPolicy = { version: 1, repo: value.repo, revision: current.revision + 1, maxConcurrentRuns: value.maxConcurrentRuns };
      sql.prepare('INSERT INTO execution_policies VALUES (?,?,?) ON CONFLICT(repo) DO UPDATE SET revision=excluded.revision,maximum=excluded.maximum').run(result.repo, result.revision, result.maxConcurrentRuns);
      sql.prepare('INSERT INTO execution_policy_commands VALUES (?,?,?,?)').run(value.caller, value.requestId, persistenceHash(value), stableJson(result));
      return result;
    });
  } };
}
