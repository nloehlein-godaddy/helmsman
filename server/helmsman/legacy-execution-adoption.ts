import { isGithubRepo } from '../pr-lists';
import type { RunRow } from './db';
import type { ExecutionStore } from './execution-store';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceValidationError, stableJson, type Persistence } from './persistence';

export interface LegacyExecutionRecord {
  runId: string; attempt: number; repo: string; status: RunRow['status'];
  source: 'jira' | 'todos' | 'freeform' | 'github-review' | 'unknown';
  host: 'detached' | 'cmux' | 'wezterm' | 'docker' | 'unknown';
  state: 'historical' | 'blocked'; protected: boolean; diagnosticCodes: readonly string[];
}
export interface LegacyExecutionAdoption {
  audit(rows: readonly RunRow[]): readonly LegacyExecutionRecord[];
  list(): readonly LegacyExecutionRecord[];
  reservations(): readonly { runId: string; repo: string; reason: 'unresolved' }[];
  cleanupEligibility(runId: string): { allowed: boolean; reasons: readonly string[] };
}
const DDL = `CREATE TABLE legacy_execution_obligations (
  runId TEXT PRIMARY KEY,attempt INTEGER NOT NULL,repo TEXT NOT NULL,status TEXT NOT NULL,
  source TEXT NOT NULL,host TEXT NOT NULL,state TEXT NOT NULL,protected INTEGER NOT NULL,
  diagnosticCodes TEXT NOT NULL,rowHash TEXT NOT NULL
)`;
const COLUMNS = ['runId', 'attempt', 'repo', 'status', 'source', 'host', 'state', 'protected', 'diagnosticCodes', 'rowHash'];
const STATES = ['running', 'succeeded', 'failed', 'stopped'];
const SOURCES = ['jira', 'todos', 'freeform', 'github-review', 'unknown'];
const HOSTS = ['detached', 'cmux', 'wezterm', 'docker', 'unknown'];
const DIAGNOSTICS = ['legacy-runtime-unverified', 'legacy-connection-unverified', 'legacy-ownership-unverified', 'legacy-checkpoint-unverified',
  'legacy-task-missing', 'legacy-task-invalid', 'legacy-host-missing', 'legacy-host-invalid', 'legacy-path-invalid', 'legacy-record-changed'];
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d][a-z\d_.:-]{0,255}$/i.test(value);
function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try { return object(persistedJson(JSON.parse(value))); } catch { return null; }
}
function inspect(row: RunRow): LegacyExecutionRecord {
  if (!identity(row?.id) || !isGithubRepo(row.repo) || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !STATES.includes(row.status)) {
    throw new PersistenceValidationError('Legacy execution identity is invalid; retain the original database for recovery');
  }
  const diagnosticCodes: string[] = [];
  const task = parse(row.taskJson);
  let source: LegacyExecutionRecord['source'] = 'unknown';
  const invalidTask = !task || !text(task.ticketId) || task.ticketId !== row.ticketId || task.repo !== row.repo
    || !text(task.title) || typeof task.jiraBaseUrl !== 'string' || task.todoId !== undefined && !text(task.todoId)
    || task.review !== undefined && typeof task.review !== 'boolean' || task.task !== undefined && !text(task.task)
    || task.prNumber !== undefined && (!Number.isSafeInteger(task.prNumber) || Number(task.prNumber) < 1)
    || task.review === true && (!Number.isSafeInteger(task.prNumber) || !text(task.prBranch));
  if (invalidTask) diagnosticCodes.push(row.taskJson == null ? 'legacy-task-missing' : 'legacy-task-invalid');
  else source = task.todoId ? 'todos' : task.review === true ? 'github-review' : task.task ? 'freeform' : 'jira';
  const ref = parse(row.hostRef);
  let host: LegacyExecutionRecord['host'] = 'unknown';
  const validRef = ref && (ref.kind === 'detached' && Number.isSafeInteger(ref.pid) && Number(ref.pid) > 0
    || ref.kind === 'cmux' && text(ref.workspace)
    || ref.kind === 'wezterm' && text(ref.paneId) && (ref.socket == null || text(ref.socket))
    || ref.kind === 'docker' && typeof ref.containerId === 'string' && /^[a-f\d]{12,64}$/.test(ref.containerId));
  if (!validRef || row.hostKind != null && row.hostKind !== ref?.kind) diagnosticCodes.push(row.hostRef == null ? 'legacy-host-missing' : 'legacy-host-invalid');
  else host = ref.kind as LegacyExecutionRecord['host'];
  if ([row.worktreePath, row.logPath, row.exitPath, row.specPath].some(path => path != null && !text(path))) diagnosticCodes.push('legacy-path-invalid');
  const checkpoint = Boolean(row.worktreePath) && (task?.prePrResume !== undefined || row.status !== 'succeeded' && row.adapter?.startsWith('pre-pr:'));
  const protectedResources = row.status === 'running' || checkpoint;
  if (protectedResources) {
    diagnosticCodes.push('legacy-runtime-unverified', 'legacy-connection-unverified', 'legacy-ownership-unverified');
    if (checkpoint) diagnosticCodes.push('legacy-checkpoint-unverified');
  }
  return { runId: row.id, repo: row.repo, attempt: row.attempt, status: row.status, source, host,
    state: protectedResources ? 'blocked' : 'historical', protected: protectedResources, diagnosticCodes: Object.freeze(diagnosticCodes) };
}

export function openLegacyExecutionAdoption(options: { persistence: Persistence; executions: ExecutionStore }): LegacyExecutionAdoption {
  const { persistence, executions } = options;
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.legacy-executions', version: 1, checksum: persistenceHash(DDL), tables: ['legacy_execution_obligations'],
    validateLegacy: () => null, apply: () => { sql.exec(DDL); },
    validateCurrent: () => validateTableColumns(sql, 'legacy_execution_obligations', COLUMNS) });
  interface Stored extends Omit<LegacyExecutionRecord, 'protected' | 'diagnosticCodes'> { protected: number; diagnosticCodes: string; rowHash: string }
  function decode(value: Stored): LegacyExecutionRecord {
    const codes: unknown = JSON.parse(value.diagnosticCodes);
    if (!identity(value.runId) || !isGithubRepo(value.repo) || !Number.isSafeInteger(value.attempt) || value.attempt < 1
      || !STATES.includes(value.status) || !SOURCES.includes(value.source) || !HOSTS.includes(value.host) || !['historical', 'blocked'].includes(value.state)
      || ![0, 1].includes(value.protected) || value.state === 'blocked' !== (value.protected === 1) || !/^[a-f\d]{64}$/.test(value.rowHash)
      || !Array.isArray(codes) || codes.some(code => typeof code !== 'string' || !DIAGNOSTICS.includes(code))) throw new PersistenceValidationError('Legacy recovery metadata is invalid');
    return Object.freeze({ runId: value.runId, repo: value.repo, attempt: value.attempt, status: value.status, source: value.source,
      host: value.host, state: value.state, protected: value.protected === 1, diagnosticCodes: Object.freeze([...codes]) });
  }
  const list = () => (sql.prepare('SELECT * FROM legacy_execution_obligations ORDER BY runId').all() as Stored[]).map(decode);
  return {
    list,
    audit(rows) {
      return persistence.transaction(() => {
        for (const row of rows) {
          const record = inspect(row);
          if (executions.attempt({ runId: record.runId, attempt: record.attempt })) continue;
          const rowHash = persistenceHash(JSON.parse(JSON.stringify(row)));
          const prior = sql.prepare('SELECT * FROM legacy_execution_obligations WHERE runId=?').get(record.runId) as Stored | undefined;
          if (prior) {
            const decoded = decode(prior);
            if (prior.rowHash !== rowHash && !decoded.diagnosticCodes.includes('legacy-record-changed')) {
              sql.prepare('UPDATE legacy_execution_obligations SET diagnosticCodes=? WHERE runId=?')
                .run(stableJson([...decoded.diagnosticCodes, 'legacy-record-changed']), record.runId);
            }
            continue;
          }
          sql.prepare(`INSERT INTO legacy_execution_obligations VALUES(@runId,@attempt,@repo,@status,@source,@host,@state,@protected,@diagnosticCodes,@rowHash)`)
            .run({ ...record, protected: Number(record.protected), diagnosticCodes: stableJson(record.diagnosticCodes), rowHash });
        }
        return list();
      });
    },
    reservations: () => list().filter(row => row.status === 'running' && row.protected).map(row => ({ runId: row.runId, repo: row.repo, reason: 'unresolved' })),
    cleanupEligibility(runId) {
      const row = list().find(item => item.runId === runId);
      return row?.protected ? { allowed: false, reasons: [row.diagnosticCodes.includes('legacy-checkpoint-unverified')
        ? 'Legacy checkpoint lacks verified runtime and process ownership' : 'Legacy execution ownership remains unresolved'] } : { allowed: true, reasons: [] };
    },
  };
}
