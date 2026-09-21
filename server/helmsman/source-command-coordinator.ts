import { awaitSourceResult } from './source-await';
import { randomUUID } from 'node:crypto';
import { isContributionId } from '../../src/plugins/manifest';
import { parseSourceCommandV1, parseSourceCommandReceiptQueryV1, parseSourceCommandDefiniteRejectionV1,
  type SourceCommandV1, type SourceCommandReceiptV1, type SourceCommandReceiptQueryV1, type SourceCommandOutcomeV1 } from '../../src/plugins/source-command';
import { parseLocalSourceCommandPlanV1, parseWorkRefV1, type LocalSourceCommandPlanV1, type LocalSourceRecordV1 } from '../../src/plugins/tasks';
import { resolveTaskEditor, type TaskEditorServerOptions } from './task-edit-service';
import type { LocalSourceAdapter } from './task-sources/local-records';
import type { SourceCommandStore, StoredSourceCommand, SourceCommandResolutionInput } from './source-command-store';
import type { RunCommandOwner } from './run-command-store';
import { PersistenceConflictError, PersistenceValidationError, persistenceHash, stableJson } from './persistence';

export class SourceCommandAccessError extends Error { readonly status = 403; }
export interface SourceCommandServerService {
  submit(caller: string, command: SourceCommandV1): Promise<SourceCommandReceiptV1>;
  receipt(caller: string, query: SourceCommandReceiptQueryV1): SourceCommandReceiptV1 | null;
  recovery(repo?: string | null): readonly SourceCommandRecoveryRecord[];
  resolveNotApplied(input: SourceCommandResolutionInput): SourceCommandReceiptV1;
}
export interface SourceCommandRecoveryRecord {
  readonly caller: string; readonly requestId: string; readonly repo: string; readonly sourceId: string; readonly instanceId: string;
  readonly action: SourceCommandV1['action']; readonly commandId: string; readonly target: SourceCommandV1['target'];
  readonly status: 'recovery-required'; readonly message: string | null; readonly receiptHash: string; readonly canResolve: boolean;
}
export function projectSourceCommandRecovery(record: StoredSourceCommand, canResolve: boolean): SourceCommandRecoveryRecord {
  const command = record.command;
  return { caller: record.caller, requestId: command.requestId, repo: command.selection.repo, sourceId: command.selection.sourceId,
    instanceId: command.selection.instanceId, action: command.action, commandId: command.commandId, target: command.target,
    status: 'recovery-required', message: record.receipt.message, receiptHash: persistenceHash(record.receipt), canResolve };
}
export function createSourceCommandCoordinator(options: TaskEditorServerOptions & {
  commands: SourceCommandStore; local: LocalSourceAdapter; authorize(caller: string, command: SourceCommandV1): void;
  prepareTimeoutMs?: number; owner?: RunCommandOwner; ownerAlive?(owner: RunCommandOwner): boolean;
}): SourceCommandServerService {
  const commands = options.commands; const owner = options.owner ?? { token: randomUUID(), pid: process.pid };
  const alive = options.ownerAlive ?? ((owner: RunCommandOwner) => { try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'; } });
  function callerValid(caller: string): void { if (!isContributionId(caller)) throw new SourceCommandAccessError('Invalid source command contribution'); }
  function current(record: StoredSourceCommand): StoredSourceCommand {
    const value = commands.get(record.caller, record.command.requestId);
    if (!value || value.contentHash !== record.contentHash) throw new PersistenceConflictError('Source command identity changed'); return value;
  }
  function owned(record: StoredSourceCommand): void {
    const value = current(record);
    if (value.receipt.status !== 'pending' || value.owner?.token !== owner.token || value.owner.pid !== owner.pid) throw new PersistenceConflictError('Source command dispatch is no longer owned');
  }
  function localInput(record: StoredSourceCommand) {
    if (!record.authority) throw new PersistenceConflictError('Source command authority is unavailable');
    return { requestId: record.localRequestId, instance: record.authority.instance, repo: record.command.selection.repo,
      commandId: record.command.commandId, commandInput: record.command.input };
  }
  function outcome(record: StoredSourceCommand, value: LocalSourceRecordV1 | null): SourceCommandOutcomeV1 {
    const command = record.command;
    if (command.action === 'delete') {
      if (value !== null || !command.target) throw new PersistenceConflictError('Source deletion receipt does not match command');
      return { kind: 'deleted', ref: command.target.ref, repo: command.selection.repo, previousRevision: command.target.expectedRevision };
    }
    if (!value || value.repo !== command.destinationRepo || value.ref?.sourceId !== command.selection.sourceId || !value.revision
      || command.target && stableJson(value.ref) !== stableJson(command.target.ref)) throw new PersistenceConflictError('Source mutation receipt does not match command');
    return { kind: 'changed', ref: parseWorkRefV1(value.ref), repo: value.repo, revision: value.revision };
  }
  function reconcile(record: StoredSourceCommand): SourceCommandReceiptV1 | null {
    if (record.receipt.status === 'succeeded' || record.receipt.status === 'rejected') return record.receipt;
    if (!options.local.hasCommandResult(record.localRequestId)) return null;
    const applied = options.local.recordedCommandResult(localInput(record));
    if (!applied.found) throw new PersistenceConflictError('Source mutation receipt disappeared');
    return commands.settle(record.caller, { ...record.receipt, status: 'succeeded', message: null, result: outcome(record, applied.result) });
  }
  function selection(command: SourceCommandV1, caller: string) {
    options.authorize(caller, command);
    const selected = resolveTaskEditor(options, command);
    if (selected.sourceRevision !== command.sourceRevision || selected.declaration.commands[command.action] !== command.commandId
      || command.destinationRepo !== null && (!selected.instance.allowedRepos.includes(command.destinationRepo) || !options.repos().includes(command.destinationRepo))) throw new PersistenceConflictError('Source command selection or destination changed');
    return selected;
  }
  function checkedSelection(record: StoredSourceCommand) {
    const selected = selection(record.command, record.caller);
    if (!record.authority || stableJson(record.authority.instance) !== stableJson(selected.instance)) throw new PersistenceConflictError('Source command authority changed');
    return selected;
  }
  function validatePlan(record: StoredSourceCommand, plan: LocalSourceCommandPlanV1): void {
    const command = record.command;
    if (plan.kind !== command.action || plan.kind === 'create' && plan.repo !== command.destinationRepo
      || plan.kind !== 'create' && (!command.target || stableJson(plan.ref) !== stableJson(command.target.ref) || plan.expectedRevision !== command.target.expectedRevision)
      || plan.kind === 'update' && plan.next.repo !== command.destinationRepo) throw new PersistenceConflictError('Source command plan changed its target or destination');
  }
  function reject(record: StoredSourceCommand, message: string): SourceCommandReceiptV1 {
    return commands.settle(record.caller, { ...current(record).receipt, status: 'rejected', message, result: null });
  }
  function providerRejection(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'sourceCommandRejection');
    if (!descriptor || !('value' in descriptor)) return null;
    try { return parseSourceCommandDefiniteRejectionV1(descriptor.value).message; } catch { return null; }
  }
  async function dispatch(record: StoredSourceCommand): Promise<SourceCommandReceiptV1> {
    let phase: 'prepare' | 'apply' = 'prepare';
    try {
      const selected = checkedSelection(record); const registration = options.registry.resolve(selected.instance, 'admission');
      const handler = registration.provider.commands?.[record.command.commandId];
      if (!handler || !registration.provider.prepareEditorCommand) throw new PersistenceConflictError('Source command handler is unavailable');
      const signal = AbortSignal.timeout(options.prepareTimeoutMs ?? 30_000);
      const plan = parseLocalSourceCommandPlanV1(await awaitSourceResult(registration.provider.prepareEditorCommand({ editor: record.command.editor, action: record.command.action, commandId: record.command.commandId,
        target: record.command.target, destinationRepo: record.command.destinationRepo, value: record.command.input }, options.service.context(selected.instance, record.command.selection.repo, signal)), signal));
      signal.throwIfAborted(); validatePlan(record, plan); phase = 'apply';
      return commands.transaction(() => {
        const existing = reconcile(current(record)); if (existing) return existing;
        owned(record); checkedSelection(record); validatePlan(record, plan);
        const result = options.local.applyCommand({ ...localInput(record), plan });
        return commands.settle(record.caller, { ...record.receipt, status: 'succeeded', result: outcome(record, result), message: null });
      });
    } catch (error) {
      return commands.transaction(() => {
        const value = current(record); const settled = reconcile(value); if (settled) return settled;
        if (value.receipt.status !== 'pending' || value.owner?.token !== owner.token || value.owner.pid !== owner.pid) return value.receipt;
        const message = phase === 'prepare' ? providerRejection(error) : null;
        if (message || error instanceof PersistenceConflictError || error instanceof PersistenceValidationError || error instanceof SourceCommandAccessError) {
          return reject(value, message ?? 'The source, task revision, ownership or destination changed. Refresh before trying again.');
        }
        return commands.settle(record.caller, { ...value.receipt, status: 'recovery-required', result: null, message: 'Source command delivery needs reconciliation.' });
      });
    }
  }
  return {
    async submit(caller, raw) {
      callerValid(caller); const command = parseSourceCommandV1(raw);
      const record = commands.transaction(() => {
        const prior = commands.get(caller, command.requestId);
        if (prior) return commands.reserve(caller, command, prior.authority);
        try {
          const selected = selection(command, caller);
          return commands.reserve(caller, command, { instance: selected.instance, sourceRevision: selected.sourceRevision });
        } catch (error) {
          const saved = commands.reserve(caller, command, null);
          if (error instanceof PersistenceConflictError || error instanceof PersistenceValidationError || error instanceof SourceCommandAccessError) reject(saved, 'The source selection, contribution or destination is unavailable.');
          else commands.settle(caller, { ...saved.receipt, status: 'recovery-required', message: 'Source command authority needs reconciliation.' });
          return current(saved);
        }
      });
      const receipt = reconcile(record); if (receipt) return receipt;
      const claimed = commands.claim(caller, command.requestId, owner, alive); return claimed ? dispatch(claimed) : current(record).receipt;
    },
    receipt(caller, raw) {
      callerValid(caller); const query = parseSourceCommandReceiptQueryV1(raw); const record = commands.get(caller, query.requestId);
      if (!record) return null;
      if (record.command.selection.repo !== query.repo) throw new SourceCommandAccessError('Source command scope does not match');
      return reconcile(record) ?? record.receipt;
    },
    recovery(repo = null) {
      return commands.recovery(repo).flatMap(record => {
        let canResolve = false;
        try { if (reconcile(record)?.status === 'succeeded') return []; canResolve = !options.local.hasCommandResult(record.localRequestId); } catch {}
        return [projectSourceCommandRecovery(current(record), canResolve)];
      });
    },
    resolveNotApplied(input) {
      callerValid(input.caller); parseSourceCommandReceiptQueryV1({ repo: input.repo, requestId: input.requestId });
      return commands.resolve(input, record => { if (options.local.hasCommandResult(record.localRequestId)) throw new PersistenceConflictError('Source command has retained mutation evidence'); });
    },
  };
}
