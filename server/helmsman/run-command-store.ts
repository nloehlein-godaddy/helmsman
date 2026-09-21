import { randomUUID } from 'node:crypto';
import { parseRunCommandReceiptV1, parseRunCommandV1, type RunCommandReceiptV1, type RunCommandV1 } from '../../src/plugins/run-command';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson, type Persistence } from './persistence';
import type { OperatorResolution } from './operations';

export interface RunCommandResolutionInput extends OperatorResolution {
  readonly caller: string;
  readonly requestId: string;
  readonly repo: string;
  readonly receiptHash: string;
}

export interface RunCommandOwner { readonly token: string; readonly pid: number; }
export interface StoredRunCommand {
  readonly caller: string;
  readonly command: RunCommandV1;
  readonly assignedRunId: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly owner: RunCommandOwner | null;
  readonly receipt: RunCommandReceiptV1;
}
export interface RunCommandStore {
  transaction<T>(callback: () => T): T;
  get(caller: string, requestId: string): StoredRunCommand | null;
  put(caller: string, command: RunCommandV1): StoredRunCommand;
  claim(caller: string, requestId: string, owner: RunCommandOwner, isAlive: (owner: RunCommandOwner) => boolean): StoredRunCommand | null;
  settle(caller: string, receipt: RunCommandReceiptV1, owner?: RunCommandOwner): RunCommandReceiptV1;
  recovery(repo?: string | null): readonly StoredRunCommand[];
  resolveNotAdmitted(input: RunCommandResolutionInput, assertAbsent: (record: StoredRunCommand) => void): RunCommandReceiptV1;
}
const DDL = `CREATE TABLE run_commands (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, command TEXT NOT NULL, assignedRunId TEXT NOT NULL,
  contentHash TEXT NOT NULL, createdAt TEXT NOT NULL, ownerToken TEXT, ownerPid INTEGER, receipt TEXT NOT NULL,
  PRIMARY KEY(caller,requestId)
)`;
const RETRY_INDEX = `CREATE UNIQUE INDEX run_commands_retry_active ON run_commands (
  json_extract(command,'$.repo'),json_extract(command,'$.target.runId'),json_extract(command,'$.target.expectedAttempt')
) WHERE json_extract(command,'$.action')='retry' AND json_extract(receipt,'$.status')!='rejected'`;
const RESOLUTION_DDL = `CREATE TABLE run_command_resolutions (
  id TEXT PRIMARY KEY, caller TEXT NOT NULL, requestId TEXT NOT NULL, commandHash TEXT NOT NULL,
  priorReceiptHash TEXT NOT NULL, inputHash TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
  evidence TEXT NOT NULL, createdAt TEXT NOT NULL, receipt TEXT NOT NULL, UNIQUE(caller,requestId)
)`;
interface ResolutionRow { id: string; caller: string; requestId: string; commandHash: string; priorReceiptHash: string; inputHash: string; actor: string; reason: string; evidence: string; createdAt: string; receipt: string; }
interface Row { caller: string; requestId: string; command: string; assignedRunId: string; contentHash: string; createdAt: string; ownerToken: string | null; ownerPid: number | null; receipt: string; }
export function validateRunCommandCaller(input: unknown): asserts input is string {
  if (typeof input !== 'string' || !/^[a-z\d][a-z\d._/-]{0,319}$/i.test(input)) throw new PersistenceValidationError('Invalid command caller');
}
function validOwner(owner: RunCommandOwner): void {
  if (typeof owner?.token !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw new PersistenceValidationError('Invalid command dispatcher identity');
  }
}
function sameOwner(left: RunCommandOwner | null, right: RunCommandOwner): boolean { return left?.token === right.token && left.pid === right.pid; }
function immutable(value: Pick<StoredRunCommand, 'caller' | 'command' | 'assignedRunId' | 'createdAt'>) {
  return { caller: value.caller, command: value.command, assignedRunId: value.assignedRunId, createdAt: value.createdAt };
}
function validateReceipt(record: Pick<StoredRunCommand, 'command' | 'assignedRunId'>, input: RunCommandReceiptV1): RunCommandReceiptV1 {
  const receipt = parseRunCommandReceiptV1(input, record.command);
  if (receipt.runId !== null && (receipt.runId !== record.assignedRunId
    || receipt.attempt !== (record.command.action === 'stop' ? record.command.target.expectedAttempt : 1))) {
    throw new PersistenceValidationError('Command receipt execution identity changed');
  }
  return receipt;
}
export function openRunCommandStore(persistence: Persistence): RunCommandStore {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.run-commands', version: 2, checksum: persistenceHash([DDL, RETRY_INDEX]), tables: ['run_commands'], validateLegacy: () => null,
    apply: (_sql, from) => { if (from === 0) sql.exec(DDL); sql.exec(RETRY_INDEX); },
    validateCurrent: () => {
      validateTableColumns(sql, 'run_commands', ['caller', 'requestId', 'command', 'assignedRunId', 'contentHash', 'createdAt', 'ownerToken', 'ownerPid', 'receipt']);
      const index = sql.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='run_commands_retry_active'").get() as { sql: string } | undefined;
      if (index?.sql !== RETRY_INDEX) throw new PersistenceValidationError('Command retry uniqueness index is unavailable');
    } });
  migrateOwned(sql, { owner: 'core.run-command-resolutions', version: 1, checksum: persistenceHash(RESOLUTION_DDL), tables: ['run_command_resolutions'], validateLegacy: () => null,
    apply: () => sql.exec(RESOLUTION_DDL), validateCurrent: () => validateTableColumns(sql, 'run_command_resolutions',
      ['id', 'caller', 'requestId', 'commandHash', 'priorReceiptHash', 'inputHash', 'actor', 'reason', 'evidence', 'createdAt', 'receipt']) });
  const resolution = (caller: string, requestId: string) => sql.prepare('SELECT * FROM run_command_resolutions WHERE caller=? AND requestId=?').get(caller, requestId) as ResolutionRow | undefined;
  function decode(row: Row): StoredRunCommand {
    validateRunCommandCaller(row.caller);
    const command = parseRunCommandV1(JSON.parse(row.command));
    const owner = row.ownerToken === null && row.ownerPid === null ? null : { token: row.ownerToken!, pid: row.ownerPid! };
    if (owner) validOwner(owner);
    const value = { caller: row.caller, command, assignedRunId: row.assignedRunId, createdAt: row.createdAt };
    if (command.requestId !== row.requestId || !/^[a-z\d_-]{1,128}$/i.test(row.assignedRunId)
      || command.action === 'stop' && row.assignedRunId !== command.target.runId
      || !Number.isFinite(Date.parse(row.createdAt)) || persistenceHash(immutable(value)) !== row.contentHash) {
      throw new PersistenceValidationError('Command integrity check failed');
    }
    const receipt = validateReceipt(value, JSON.parse(row.receipt) as RunCommandReceiptV1);
    const audit = resolution(row.caller, row.requestId);
    if (receipt.resolution || audit) {
      if (!receipt.resolution || !audit || audit.id !== receipt.resolution.id || audit.commandHash !== row.contentHash || stableJson(receipt) !== audit.receipt
        || receipt.resolution.runId !== value.assignedRunId || receipt.resolution.attempt !== (command.action === 'stop' ? command.target.expectedAttempt : 1)
        || audit.inputHash !== persistenceHash({ caller: audit.caller, requestId: audit.requestId, repo: command.repo,
          receiptHash: audit.priorReceiptHash, actor: audit.actor, reason: audit.reason, evidence: JSON.parse(audit.evidence) })) {
        throw new PersistenceValidationError('Command resolution audit integrity failed');
      }
    }
    return Object.freeze({ ...value, contentHash: row.contentHash, owner: owner ? Object.freeze(owner) : null, receipt });
  }
  function get(caller: string, requestId: string): StoredRunCommand | null {
    validateRunCommandCaller(caller);
    const row = sql.prepare('SELECT * FROM run_commands WHERE caller=? AND requestId=?').get(caller, requestId) as Row | undefined;
    return row ? decode(row) : null;
  }
  return {
    transaction: callback => persistence.transaction(callback), get,
    put(caller, input) {
      validateRunCommandCaller(caller); const command = parseRunCommandV1(input);
      return persistence.transaction(() => {
        const existing = get(caller, command.requestId);
        if (existing) {
          if (persistenceHash(existing.command) !== persistenceHash(command)) throw new PersistenceConflictError('Request ID already has different command content');
          return existing;
        }
        const assignedRunId = command.action === 'stop' ? command.target.runId : randomUUID();
        const createdAt = new Date().toISOString();
        const receipt: RunCommandReceiptV1 = { version: 1, requestId: command.requestId, repo: command.repo, action: command.action,
          status: 'pending', runId: assignedRunId, attempt: command.action === 'stop' ? command.target.expectedAttempt : 1, message: null };
        const priorRetryRow = command.action === 'retry' ? sql.prepare(`SELECT * FROM run_commands
          WHERE json_extract(command,'$.action')='retry' AND json_extract(receipt,'$.status')!='rejected'
          AND json_extract(command,'$.repo')=? AND json_extract(command,'$.target.runId')=? AND json_extract(command,'$.target.expectedAttempt')=?`)
          .get(command.repo, command.target.runId, command.target.expectedAttempt) as Row | undefined : undefined;
        const priorRetry = priorRetryRow ? decode(priorRetryRow) : null;
        const result = priorRetry ? { ...receipt, status: 'rejected' as const, runId: null, attempt: null,
          message: `Retry already requested for this voyage attempt. Open voyage ${priorRetry.assignedRunId}.` } : receipt;
        const contentHash = persistenceHash(immutable({ caller, command, assignedRunId, createdAt }));
        sql.prepare('INSERT INTO run_commands VALUES (?,?,?,?,?,?,NULL,NULL,?)')
          .run(caller, command.requestId, stableJson(command), assignedRunId, contentHash, createdAt, stableJson(result));
        return get(caller, command.requestId)!;
      });
    },
    claim(caller, requestId, owner, isAlive) {
      validOwner(owner);
      return persistence.transaction(() => {
        const current = get(caller, requestId);
        if (!current || current.receipt.status !== 'pending' || current.owner && isAlive(current.owner)) return null;
        sql.prepare('UPDATE run_commands SET ownerToken=?,ownerPid=? WHERE caller=? AND requestId=?').run(owner.token, owner.pid, caller, requestId);
        return get(caller, requestId);
      });
    },
    settle(caller, input, owner) {
      return persistence.transaction(() => {
        const current = get(caller, input.requestId);
        if (!current) throw new PersistenceConflictError('Command is missing');
        const receipt = validateReceipt(current, input);
        if (current.receipt.status === 'accepted' || current.receipt.status === 'rejected') {
          if (stableJson(current.receipt) !== stableJson(receipt)) throw new PersistenceConflictError('Command receipt already settled');
          return current.receipt;
        }
        if (receipt.resolution) throw new PersistenceConflictError('Command resolution requires an operator audit');
        if (owner && !sameOwner(current.owner, owner)) throw new PersistenceConflictError('Command dispatcher ownership changed');
        if (receipt.status === 'pending' || current.receipt.status === 'recovery-required' && receipt.status !== 'accepted' && receipt.status !== 'recovery-required') {
          throw new PersistenceConflictError('Invalid command receipt transition');
        }
        sql.prepare('UPDATE run_commands SET receipt=? WHERE caller=? AND requestId=?').run(stableJson(receipt), caller, receipt.requestId);
        return receipt;
      });
    },
    recovery(repo = null) {
      return (sql.prepare(`SELECT * FROM run_commands WHERE json_extract(receipt,'$.status')='recovery-required'
        ${repo === null ? '' : "AND json_extract(command,'$.repo')=? COLLATE NOCASE"} ORDER BY createdAt,caller,requestId LIMIT 1001`)
        .all(...(repo === null ? [] : [repo])) as Row[]).map(decode);
    },
    resolveNotAdmitted(input, assertAbsent) {
      validateRunCommandCaller(input.caller);
      if (!/^[a-f\d]{64}$/.test(input.receiptHash) || typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 256
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000
        || /[\x00-\x1f\x7f]/.test(input.actor) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.reason)
        || input.evidence === null || input.evidence === undefined || Buffer.byteLength(JSON.stringify(input.evidence)) > 16_384) {
        throw new PersistenceValidationError('A current receipt proof, actor, reason and bounded evidence are required');
      }
      const normalized = { caller: input.caller, requestId: input.requestId, repo: input.repo, receiptHash: input.receiptHash,
        actor: input.actor.trim(), reason: input.reason.trim(), evidence: persistedJson(input.evidence) };
      const inputHash = persistenceHash(normalized);
      return persistence.transaction(() => {
        const current = get(input.caller, input.requestId);
        if (!current || current.command.repo !== input.repo) throw new PersistenceConflictError('Command resolution target changed');
        const prior = resolution(input.caller, input.requestId);
        if (prior) {
          if (prior.inputHash !== inputHash || !current.receipt.resolution || prior.id !== current.receipt.resolution.id) throw new PersistenceConflictError('Command resolution proof changed');
          return current.receipt;
        }
        if (current.receipt.status !== 'recovery-required' || persistenceHash(current.receipt) !== input.receiptHash) throw new PersistenceConflictError('Command receipt changed before resolution');
        assertAbsent(current);
        const latest = get(input.caller, input.requestId);
        if (!latest || latest.contentHash !== current.contentHash || persistenceHash(latest.receipt) !== input.receiptHash) throw new PersistenceConflictError('Command changed during resolution');
        const resolutionId = randomUUID();
        const receipt = validateReceipt(current, { ...current.receipt, status: 'rejected', runId: null, attempt: null,
          message: 'Operator verified this command was not admitted. No execution was started by resolution.',
          resolution: { version: 1, id: resolutionId, kind: 'not-admitted', runId: current.assignedRunId,
            attempt: current.command.action === 'stop' ? current.command.target.expectedAttempt : 1 } });
        sql.prepare('INSERT INTO run_command_resolutions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(resolutionId, input.caller, input.requestId,
          current.contentHash, input.receiptHash, inputHash, normalized.actor, normalized.reason, stableJson(normalized.evidence), new Date().toISOString(), stableJson(receipt));
        sql.prepare('UPDATE run_commands SET receipt=? WHERE caller=? AND requestId=?').run(stableJson(receipt), input.caller, input.requestId);
        return get(input.caller, input.requestId)!.receipt;
      });
    },
  };
}
