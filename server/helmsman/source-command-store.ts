import { randomUUID } from 'node:crypto';
import { parseSourceCommandV1, parseSourceCommandReceiptV1, type SourceCommandV1, type SourceCommandReceiptV1 } from '../../src/plugins/source-command';
import { parseSourceInstanceV1, type SourceInstanceV1 } from '../../src/plugins/tasks';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, persistedJson, stableJson, PersistenceConflictError, PersistenceValidationError, type Persistence } from './persistence';
import { validateRunCommandCaller, type RunCommandOwner } from './run-command-store';
import type { OperatorResolution } from './operations';

export interface SourceCommandAuthority { readonly instance: SourceInstanceV1; readonly sourceRevision: number; }
export interface StoredSourceCommand {
  readonly caller: string; readonly command: SourceCommandV1; readonly contentHash: string; readonly localRequestId: string;
  readonly authority: SourceCommandAuthority | null; readonly receipt: SourceCommandReceiptV1; readonly owner: RunCommandOwner | null;
}
export interface SourceCommandResolutionInput extends OperatorResolution { readonly caller: string; readonly requestId: string; readonly repo: string; readonly receiptHash: string; }
export interface SourceCommandStore {
  transaction<T>(fn: () => T): T;
  get(caller: string, requestId: string): StoredSourceCommand | null;
  reserve(caller: string, command: SourceCommandV1, authority: SourceCommandAuthority | null): StoredSourceCommand;
  claim(caller: string, requestId: string, owner: RunCommandOwner, alive: (owner: RunCommandOwner) => boolean): StoredSourceCommand | null;
  settle(caller: string, receipt: SourceCommandReceiptV1): SourceCommandReceiptV1;
  recovery(repo?: string | null): readonly StoredSourceCommand[];
  resolve(input: SourceCommandResolutionInput, assertAbsent: (record: StoredSourceCommand) => void): SourceCommandReceiptV1;
}
const DDL = `CREATE TABLE public_source_commands (
  caller TEXT NOT NULL,requestId TEXT NOT NULL,command TEXT NOT NULL,authority TEXT NOT NULL,contentHash TEXT NOT NULL,
  localRequestId TEXT NOT NULL UNIQUE,receipt TEXT NOT NULL,ownerToken TEXT,ownerPid INTEGER,PRIMARY KEY(caller,requestId)
);
CREATE TABLE public_source_command_resolutions (
  caller TEXT NOT NULL,requestId TEXT NOT NULL,id TEXT NOT NULL UNIQUE,input TEXT NOT NULL,inputHash TEXT NOT NULL,receipt TEXT NOT NULL,
  PRIMARY KEY(caller,requestId)
)`;
interface Row { caller: string; requestId: string; command: string; authority: string; contentHash: string; localRequestId: string; receipt: string; ownerToken: string | null; ownerPid: number | null; }
interface Audit { id: string; input: string; inputHash: string; receipt: string; }
function ownerValid(owner: RunCommandOwner): void {
  if (typeof owner?.token !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new PersistenceValidationError('Invalid source command owner');
}
export function openSourceCommandStore(persistence: Persistence): SourceCommandStore {
  const sql = persistence.sql;
  migrateOwned(sql, { owner: 'core.public-source-commands', version: 1, checksum: persistenceHash(DDL), tables: ['public_source_commands', 'public_source_command_resolutions'],
    validateLegacy: () => null, apply: () => sql.exec(DDL), validateCurrent: () => {
      validateTableColumns(sql, 'public_source_commands', ['caller', 'requestId', 'command', 'authority', 'contentHash', 'localRequestId', 'receipt', 'ownerToken', 'ownerPid']);
      validateTableColumns(sql, 'public_source_command_resolutions', ['caller', 'requestId', 'id', 'input', 'inputHash', 'receipt']);
    } });
  const audit = (caller: string, requestId: string) => sql.prepare('SELECT * FROM public_source_command_resolutions WHERE caller=? AND requestId=?').get(caller, requestId) as Audit | undefined;
  function decode(row: Row): StoredSourceCommand {
    validateRunCommandCaller(row.caller); const command = parseSourceCommandV1(JSON.parse(row.command));
    const raw = persistedJson(JSON.parse(row.authority)) as unknown as SourceCommandAuthority | null;
    const authority = raw === null ? null : { instance: parseSourceInstanceV1(raw.instance), sourceRevision: raw.sourceRevision };
    const localRequestId = `public-source:${persistenceHash({ caller: row.caller, requestId: command.requestId })}`;
    if (command.requestId !== row.requestId || row.localRequestId !== localRequestId
      || authority && (authority.sourceRevision !== command.sourceRevision || authority.instance.sourceId !== command.selection.sourceId
        || authority.instance.id !== command.selection.instanceId || authority.instance.revision !== command.selection.instanceRevision)
      || row.contentHash !== persistenceHash({ caller: row.caller, command, authority, localRequestId })) throw new PersistenceValidationError('Source command integrity failed');
    const receipt = parseSourceCommandReceiptV1(JSON.parse(row.receipt), command); const resolution = audit(row.caller, row.requestId);
    if (receipt.resolution || resolution) {
      if (!receipt.resolution || !resolution || resolution.id !== receipt.resolution.id || resolution.receipt !== stableJson(receipt)
        || persistenceHash(JSON.parse(resolution.input)) !== resolution.inputHash) throw new PersistenceValidationError('Source command resolution audit integrity failed');
    }
    const owner = row.ownerToken === null && row.ownerPid === null ? null : { token: row.ownerToken!, pid: row.ownerPid! }; if (owner) ownerValid(owner);
    return Object.freeze({ caller: row.caller, command, contentHash: row.contentHash, localRequestId, authority, receipt, owner });
  }
  function get(caller: string, requestId: string): StoredSourceCommand | null {
    validateRunCommandCaller(caller);
    const row = sql.prepare('SELECT * FROM public_source_commands WHERE caller=? AND requestId=?').get(caller, requestId) as Row | undefined;
    return row ? decode(row) : null;
  }
  function write(caller: string, receipt: SourceCommandReceiptV1): SourceCommandReceiptV1 {
    sql.prepare('UPDATE public_source_commands SET receipt=? WHERE caller=? AND requestId=?').run(stableJson(receipt), caller, receipt.requestId);
    return get(caller, receipt.requestId)!.receipt;
  }
  return {
    transaction: fn => persistence.transaction(fn), get,
    reserve(caller, input, authority) {
      const command = parseSourceCommandV1(input); validateRunCommandCaller(caller);
      return persistence.transaction(() => {
        const existing = get(caller, command.requestId);
        if (existing) {
          if (persistenceHash(existing.command) !== persistenceHash(command)) throw new PersistenceConflictError('Source command request content changed');
          return existing;
        }
        const { input: _input, ...identity } = command;
        const receipt: SourceCommandReceiptV1 = { ...identity, status: 'pending', result: null, message: null };
        const localRequestId = `public-source:${persistenceHash({ caller, requestId: command.requestId })}`;
        sql.prepare('INSERT INTO public_source_commands VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(caller, command.requestId, stableJson(command), stableJson(authority),
          persistenceHash({ caller, command, authority, localRequestId }), localRequestId, stableJson(receipt));
        return get(caller, command.requestId)!;
      });
    },
    claim(caller, requestId, owner, alive) {
      ownerValid(owner);
      return persistence.transaction(() => {
        const record = get(caller, requestId);
        if (!record || record.receipt.status !== 'pending' || record.owner && alive(record.owner)) return null;
        sql.prepare('UPDATE public_source_commands SET ownerToken=?,ownerPid=? WHERE caller=? AND requestId=?').run(owner.token, owner.pid, caller, requestId);
        return get(caller, requestId);
      });
    },
    settle(caller, input) {
      return persistence.transaction(() => {
        const record = get(caller, input.requestId); if (!record) throw new PersistenceConflictError('Source command disappeared');
        const receipt = parseSourceCommandReceiptV1(input, record.command);
        if (['succeeded', 'rejected'].includes(record.receipt.status)) {
          if (stableJson(record.receipt) !== stableJson(receipt)) throw new PersistenceConflictError('Source command already settled');
          return record.receipt;
        }
        if (receipt.resolution || receipt.status === 'pending' || record.receipt.status === 'recovery-required' && receipt.status === 'rejected') throw new PersistenceConflictError('Invalid source command transition');
        return write(caller, receipt);
      });
    },
    recovery(repo = null) {
      return (sql.prepare(`SELECT * FROM public_source_commands WHERE json_extract(receipt,'$.status')='recovery-required'
        ${repo === null ? '' : "AND json_extract(command,'$.selection.repo')=? COLLATE NOCASE"} ORDER BY caller,requestId LIMIT 1001`).all(...(repo === null ? [] : [repo])) as Row[]).map(decode);
    },
    resolve(raw, assertAbsent) {
      const input = persistedJson(raw) as unknown as SourceCommandResolutionInput;
      if (!input || typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 256 || /[\x00-\x1f\x7f]/.test(input.actor)
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.reason)
        || typeof input.receiptHash !== 'string' || !/^[a-f\d]{64}$/.test(input.receiptHash) || input.evidence == null
        || Buffer.byteLength(JSON.stringify(input.evidence)) > 16_384) throw new PersistenceValidationError('Current proof, actor, reason and bounded evidence are required');
      const normalized = { caller: input.caller, requestId: input.requestId, repo: input.repo, receiptHash: input.receiptHash,
        actor: input.actor.trim(), reason: input.reason.trim(), evidence: input.evidence };
      return persistence.transaction(() => {
        const record = get(input.caller, input.requestId); if (!record || record.command.selection.repo !== input.repo) throw new PersistenceConflictError('Source command target changed');
        const prior = audit(input.caller, input.requestId);
        if (prior) {
          if (prior.inputHash !== persistenceHash(normalized)) throw new PersistenceConflictError('Source resolution proof changed');
          return record.receipt;
        }
        if (record.receipt.status !== 'recovery-required' || persistenceHash(record.receipt) !== input.receiptHash) throw new PersistenceConflictError('Source command receipt changed');
        assertAbsent(record);
        const latest = get(input.caller, input.requestId);
        if (!latest || latest.contentHash !== record.contentHash || persistenceHash(latest.receipt) !== input.receiptHash) throw new PersistenceConflictError('Source command changed during resolution');
        const id = randomUUID();
        const receipt = parseSourceCommandReceiptV1({ ...record.receipt, status: 'rejected', message: 'Operator verified the command was not applied.',
          resolution: { version: 1, id, kind: 'not-applied' } }, record.command);
        sql.prepare('INSERT INTO public_source_command_resolutions VALUES (?,?,?,?,?,?)').run(input.caller, input.requestId, id, stableJson(normalized), persistenceHash(normalized), stableJson(receipt));
        return write(input.caller, receipt);
      });
    },
  };
}
