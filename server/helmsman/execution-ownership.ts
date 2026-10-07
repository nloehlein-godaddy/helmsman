import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { executionFootprintsConflict, executionResourceKey, parseExecutionFootprint, type ExecutionFootprint } from './execution-footprint';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface ExecutionOwnership {
  footprint: ExecutionFootprint;
  state: 'held' | 'cleanup-pending' | 'released';
  cleanupToken: string | null;
}
interface Row { runId: string; repo: string; contentHash: string; json: string; state: ExecutionOwnership['state']; cleanupToken: string | null }

export function openExecutionOwnership(persistence: Persistence) {
  const sql = persistence.sql;
  const evidence = (runId: string, kind: string, payload: unknown) => sql.prepare('INSERT INTO execution_evidence(runId,attempt,kind,payload,createdAt) VALUES(?,0,?,?,?)').run(runId, kind, stableJson(payload), new Date().toISOString());
  function decode(row: Row): ExecutionOwnership {
    const footprint = parseExecutionFootprint(JSON.parse(row.json));
    if (row.runId !== footprint.runId || row.repo !== footprint.repo || row.contentHash !== persistenceHash(footprint)
      || !['held', 'cleanup-pending', 'released'].includes(row.state)
      || (row.state === 'cleanup-pending' ? typeof row.cleanupToken !== 'string' || !row.cleanupToken : row.cleanupToken !== null)) {
      throw new PersistenceValidationError('Execution ownership integrity check failed');
    }
    const expected = row.state === 'released' ? [] : footprint.resources.filter(resource => !resource.kind.endsWith('-exclusive')).map(executionResourceKey).sort();
    const claims = sql.prepare('SELECT kind,namespace,identity FROM execution_resource_claims WHERE runId=?').all(row.runId) as ExecutionFootprint['resources'];
    if (stableJson(claims.map(executionResourceKey).sort()) !== stableJson(expected)) throw new PersistenceValidationError('Execution resource ownership is incomplete');
    return { footprint, state: row.state, cleanupToken: row.cleanupToken };
  }
  function get(runId: string): ExecutionOwnership | null {
    const row = sql.prepare('SELECT * FROM execution_footprints WHERE runId=?').get(runId) as Row | undefined;
    return row ? decode(row) : null;
  }
  const held = (): ExecutionOwnership[] => (sql.prepare("SELECT * FROM execution_footprints WHERE state!='released'").all() as Row[]).map(decode);
  function assertAvailable(candidate: ExecutionFootprint): void {
    const conflict = held().find(owner => executionFootprintsConflict(candidate, owner.footprint));
    if (conflict) throw new PersistenceConflictError(`Execution resources remain owned by ${conflict.footprint.runId}`);
  }
  function acquire(input: ExecutionFootprint): ExecutionOwnership {
    const candidate = parseExecutionFootprint(input);
    return persistence.transaction(() => {
      const previous = get(candidate.runId);
      if (previous) {
        if (persistenceHash(previous.footprint) !== persistenceHash(candidate)) throw new PersistenceConflictError('Execution footprint cannot change during replay');
        if (previous.state === 'cleanup-pending') throw new PersistenceConflictError('Execution cleanup remains unresolved');
        if (previous.state === 'held') { assertAvailable(candidate); return previous; }
      }
      assertAvailable(candidate);
      sql.prepare("INSERT INTO execution_footprints VALUES (?,?,?,?,'held',NULL) ON CONFLICT(runId) DO UPDATE SET state='held'")
        .run(candidate.runId, candidate.repo, persistenceHash(candidate), stableJson(candidate));
      for (const resource of candidate.resources.filter(item => !item.kind.endsWith('-exclusive'))) {
        sql.prepare('INSERT INTO execution_resource_claims VALUES (?,?,?,?)').run(resource.kind, resource.namespace, resource.identity, candidate.runId);
      }
      evidence(candidate.runId, 'resources-acquired', { footprintHash: persistenceHash(candidate) });
      return get(candidate.runId)!;
    });
  }
  function release(runId: string): void {
    sql.prepare('DELETE FROM execution_resource_claims WHERE runId=?').run(runId);
    sql.prepare("UPDATE execution_footprints SET state='released',cleanupToken=NULL WHERE runId=?").run(runId);
    evidence(runId, 'resources-released', {});
  }
  for (const row of sql.prepare('SELECT * FROM execution_footprints').all() as Row[]) decode(row);
  if (sql.prepare('SELECT 1 FROM execution_resource_claims c LEFT JOIN execution_footprints f ON f.runId=c.runId WHERE f.runId IS NULL LIMIT 1').get()) throw new PersistenceValidationError('Execution resource owner is missing');
  return { get, held, assertAvailable, acquire,
    reconcileLegacyTerminal(input: { runId: string; expectedRunHash: string; expectedFootprintHash: string;
      checkout: { path: string; commonDirectory: string }; workspace: string } &
      ({ kind: 'registered'; branchRef: string } | { kind: 'orphan' | 'absent'; branchRef: null })): ExecutionOwnership {
      return persistence.transaction(() => {
        const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096
          && !/[\u0000-\u001f\u007f]/.test(value) && isAbsolute(value) && normalize(value) === value;
        if (!input || !['registered', 'orphan', 'absent'].includes(input.kind)
          || !/^[a-f\d]{64}$/.test(input.expectedRunHash) || !/^[a-f\d]{64}$/.test(input.expectedFootprintHash)
          || !input.checkout || !path(input.checkout.path) || !path(input.checkout.commonDirectory) || !path(input.workspace)
          || input.kind !== 'registered' && input.branchRef !== null
          || input.kind === 'registered' && (typeof input.branchRef !== 'string'
            || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/.test(input.branchRef)
            || input.branchRef.includes('..') || input.branchRef.endsWith('/') || input.branchRef.endsWith('.lock'))) {
          throw new PersistenceValidationError('Invalid legacy execution reconciliation evidence');
        }
        const previous = get(input.runId);
        if (!previous || previous.state !== 'held' || previous.footprint.completeness !== 'exclusive'
          || previous.footprint.checkout !== null || previous.footprint.resources.length !== 1
          || previous.footprint.resources[0]?.kind !== 'galleon-exclusive'
          || persistenceHash(previous.footprint) !== input.expectedFootprintHash) {
          throw new PersistenceConflictError('Legacy exclusive ownership changed before reconciliation');
        }
        const run = sql.prepare('SELECT * FROM runs WHERE id=?').get(input.runId) as Record<string, unknown> | undefined;
        if (!run || persistenceHash(run) !== input.expectedRunHash || typeof run.repo !== 'string' || run.repo.toLowerCase() !== previous.footprint.repo
          || !['succeeded', 'failed', 'stopped'].includes(String(run.status)) || typeof run.endedAt !== 'string' || !run.endedAt
          || input.kind === 'registered' && run.worktreePath !== input.workspace
          || input.workspace !== join(input.checkout.path, '.worktrees', input.runId)) {
          throw new PersistenceConflictError('Legacy terminal run changed before reconciliation');
        }
        const legacy = sql.prepare("SELECT repo,status,source,host,protected FROM legacy_execution_obligations WHERE runId=?").get(input.runId) as
          { repo: string; status: string; source: string; host: string; protected: number } | undefined;
        if (!legacy || typeof legacy.repo !== 'string' || legacy.repo.toLowerCase() !== previous.footprint.repo || legacy.status !== run.status
          || ![0, 1].includes(legacy.protected) || input.kind === 'orphan' && legacy.protected !== 0
          || input.kind === 'absent' && legacy.protected === 1 && run.status !== 'succeeded'
          || input.kind === 'registered' && (legacy.source === 'unknown' || legacy.host === 'unknown')) {
          throw new PersistenceConflictError('Legacy execution identity remains unverified');
        }
        for (const table of ['execution_attempts', 'execution_reservations', 'execution_checkpoints', 'execution_evidence']) {
          if (sql.prepare(`SELECT 1 FROM ${table} WHERE runId=? LIMIT 1`).get(input.runId)) {
            throw new PersistenceConflictError(`Legacy execution still has ${table.replaceAll('_', ' ')}`);
          }
        }
        if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_admissions'").get()
          && sql.prepare('SELECT 1 FROM execution_admissions WHERE runId=? LIMIT 1').get(input.runId)) {
          throw new PersistenceConflictError('Legacy execution still has execution admissions');
        }
        if (sql.prepare('SELECT 1 FROM artifact_pins WHERE ownerId=? LIMIT 1').get(input.runId)) {
          throw new PersistenceConflictError('Legacy execution still has artifact pins');
        }
        if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operations'").get()
          && sql.prepare('SELECT 1 FROM operations WHERE runId=? LIMIT 1').get(input.runId)) {
          throw new PersistenceConflictError('Legacy execution still has external operations');
        }
        if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_claims'").get()) {
          const claims = sql.prepare('SELECT json FROM work_claims').all() as { json: string }[];
          if (claims.some(row => { const claim = JSON.parse(row.json) as { runId?: unknown }; return claim?.runId === input.runId; })) {
            throw new PersistenceConflictError('Legacy execution still has task source claims');
          }
        }
        if (input.kind === 'absent') {
          evidence(input.runId, 'legacy-terminal-reconciled', { kind: input.kind, previous: previous.footprint });
          release(input.runId);
          return get(input.runId)!;
        }
        const candidate = parseExecutionFootprint({ version: 1, runId: input.runId, repo: previous.footprint.repo,
          completeness: 'verified', checkout: input.checkout, resources: [
            { kind: 'workspace', namespace: 'filesystem', identity: input.workspace },
            ...(input.kind === 'registered' ? [
              { kind: 'branch', namespace: `github.com/${previous.footprint.repo}`, identity: input.branchRef },
              { kind: 'branch', namespace: `git:${input.checkout.commonDirectory}`, identity: input.branchRef },
            ] : []),
          ] });
        if (held().some(other => other.footprint.runId !== input.runId && other.footprint.completeness === 'verified'
          && executionFootprintsConflict(candidate, other.footprint))) throw new PersistenceConflictError('Verified execution resources are already retained');
        sql.prepare('DELETE FROM execution_resource_claims WHERE runId=?').run(input.runId);
        for (const resource of candidate.resources) sql.prepare('INSERT INTO execution_resource_claims VALUES (?,?,?,?)')
          .run(resource.kind, resource.namespace, resource.identity, input.runId);
        const updated = sql.prepare("UPDATE execution_footprints SET json=?,contentHash=? WHERE runId=? AND contentHash=? AND state='held'")
          .run(stableJson(candidate), persistenceHash(candidate), input.runId, input.expectedFootprintHash);
        if (updated.changes !== 1) throw new PersistenceConflictError('Legacy exclusive ownership changed before reconciliation');
        evidence(input.runId, 'resources-reconciled', { kind: input.kind, previous: previous.footprint, retained: candidate });
        return get(input.runId)!;
      });
    },
    abandon(runId: string) {
      return persistence.transaction(() => {
        if (sql.prepare('SELECT runId FROM execution_attempts WHERE runId=?').get(runId)) throw new PersistenceConflictError('Attempt ownership requires verified cleanup');
        const ownership = get(runId);
        if (ownership?.state === 'cleanup-pending') throw new PersistenceConflictError('Execution cleanup remains unresolved');
        release(runId);
      });
    },
    beginCleanup(runId: string, eligible: () => boolean): string {
      return persistence.transaction(() => {
        if (!eligible()) throw new PersistenceConflictError('Execution resources are not eligible for cleanup');
        const ownership = get(runId);
        if (!ownership || ownership.state === 'released') throw new PersistenceConflictError('Execution cleanup has no retained ownership');
        if (ownership.cleanupToken) return ownership.cleanupToken;
        const token = randomUUID();
        sql.prepare("UPDATE execution_footprints SET state='cleanup-pending',cleanupToken=? WHERE runId=?").run(token, runId);
        evidence(runId, 'cleanup-started', { token, footprintHash: persistenceHash(ownership.footprint) });
        return token;
      });
    },
    completeDetach(runId: string, token: string, input: ExecutionFootprint, eligible: () => boolean) {
      return persistence.transaction(() => {
        const previous = get(runId); const candidate = parseExecutionFootprint(input);
        if (!previous || previous.state !== 'cleanup-pending' || previous.cleanupToken !== token || !eligible()
          || candidate.runId !== runId || candidate.repo !== previous.footprint.repo || candidate.completeness !== 'verified'
          || candidate.resources.length !== 1 || candidate.resources[0]?.kind !== 'workspace'
          || previous.footprint.checkout && stableJson(previous.footprint.checkout) !== stableJson(candidate.checkout)) throw new PersistenceConflictError('Detached execution ownership changed');
        sql.prepare('DELETE FROM execution_resource_claims WHERE runId=?').run(runId);
        const workspace = candidate.resources[0]!;
        sql.prepare('INSERT INTO execution_resource_claims VALUES (?,?,?,?)').run(workspace.kind, workspace.namespace, workspace.identity, runId);
        sql.prepare("UPDATE execution_footprints SET json=?,contentHash=?,state='held',cleanupToken=NULL WHERE runId=?").run(stableJson(candidate), persistenceHash(candidate), runId);
        evidence(runId, 'resources-detached', { token, previous: previous.footprint, retained: candidate });
      });
    },
    completeCleanup(runId: string, token: string, eligible: () => boolean) {
      return persistence.transaction(() => {
        const ownership = get(runId);
        if (!ownership || ownership.state !== 'cleanup-pending' || ownership.cleanupToken !== token || !eligible()) throw new PersistenceConflictError('Execution cleanup owner changed');
        evidence(runId, 'cleanup-confirmed', { token });
        release(runId);
      });
    },
  };
}
