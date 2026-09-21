import { randomUUID } from 'node:crypto';
import { parseRunCommandReceiptQueryV1, parseRunCommandV1, type RunCommandReceiptQueryV1, type RunCommandReceiptV1, type RunCommandV1 } from '../../src/plugins/run-command';
import { persistenceHash, PersistenceConflictError } from './persistence';
import { validateRunCommandCaller, type RunCommandOwner, type RunCommandStore, type StoredRunCommand } from './run-command-store';

export type TargetRunCommand = Exclude<RunCommandV1, { action: 'launch' }>;
export type LaunchRunCommand = RunCommandV1 & { action: 'launch' | 'retry' };
export type RunCommandEvidence = { readonly status: 'absent' }
  | { readonly status: 'accepted' | 'recovery-required'; readonly runId: string; readonly attempt: number; readonly message: string | null };
export class RunCommandError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503;
  constructor(status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); this.status = status; }
}
export class RunCommandRejection extends Error {}
export interface RunCommandServerService {
  submit(caller: string, command: RunCommandV1): Promise<RunCommandReceiptV1>;
  receipt(caller: string, query: RunCommandReceiptQueryV1): RunCommandReceiptV1 | null;
}
export interface RunCommandCoordinatorOptions<Prepared> {
  readonly store: RunCommandStore;
  authorizeRead(caller: string, repo: string): void;
  authorizeWrite(caller: string, command: RunCommandV1): void;
  validateTarget(command: TargetRunCommand): void;
  prepareLaunch(command: LaunchRunCommand): Promise<Prepared>;
  launch(prepared: Prepared, record: StoredRunCommand): { runId: string; attempt: number };
  recordStop(command: TargetRunCommand): void;
  signalStop(command: TargetRunCommand): void | Promise<void>;
  inspect(record: StoredRunCommand): RunCommandEvidence;
  readonly owner?: RunCommandOwner;
  ownerAlive?(owner: RunCommandOwner): boolean;
}
function ownerAlive(owner: RunCommandOwner): boolean {
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}
export function createRunCommandCoordinator<Prepared>(options: RunCommandCoordinatorOptions<Prepared>): RunCommandServerService {
  const { store } = options;
  const owner = options.owner ?? { token: randomUUID(), pid: process.pid };
  const alive = options.ownerAlive ?? ownerAlive;
  function current(record: StoredRunCommand): StoredRunCommand {
    const value = store.get(record.caller, record.command.requestId);
    if (!value || value.contentHash !== record.contentHash) throw new PersistenceConflictError('Command identity changed');
    return value;
  }
  function owned(record: StoredRunCommand): void {
    const value = current(record);
    if (value.owner?.token !== owner.token || value.owner.pid !== owner.pid || value.receipt.status !== 'pending') {
      throw new PersistenceConflictError('Command dispatch is no longer pending under this owner');
    }
  }
  function finish(record: StoredRunCommand, status: RunCommandReceiptV1['status'], message: string | null, checkOwner = false): RunCommandReceiptV1 {
    const value = current(record);
    if (value.receipt.status === 'accepted' || value.receipt.status === 'rejected') return value.receipt;
    return store.settle(record.caller, { ...value.receipt, status, message }, checkOwner ? owner : undefined);
  }
  function reconcile(record: StoredRunCommand): RunCommandReceiptV1 | null {
    if (record.receipt.status === 'accepted' || record.receipt.status === 'rejected') return record.receipt;
    const evidence = options.inspect(record);
    if (evidence.status === 'absent') return null;
    if (evidence.runId !== record.assignedRunId || evidence.attempt !== (record.command.action === 'stop' ? record.command.target.expectedAttempt : 1)) {
      throw new PersistenceConflictError('Command evidence execution identity changed');
    }
    return finish(record, evidence.status, evidence.message);
  }
  async function dispatch(record: StoredRunCommand): Promise<RunCommandReceiptV1> {
    const command = record.command;
    try {
      options.authorizeWrite(record.caller, command);
      if (command.action === 'stop') {
        const receipt = store.transaction(() => {
          owned(record);
          options.validateTarget(command);
          options.recordStop(command);
          return finish(record, 'accepted', null, true);
        });
        try { void Promise.resolve(options.signalStop(command)).catch(() => {}); } catch {}
        return receipt;
      }
      if (command.action === 'retry') options.validateTarget(command);
      const prepared = await options.prepareLaunch(command as LaunchRunCommand);
      owned(record);
      options.authorizeWrite(record.caller, command);
      if (command.action === 'retry') options.validateTarget(command);
      const reconciled = reconcile(current(record));
      if (reconciled) return reconciled;
      const launched = options.launch(prepared, record);
      if (!launched || launched.runId !== record.assignedRunId || launched.attempt !== 1) throw new Error('Launch callback changed command identity');
      return finish(record, 'accepted', null, true);
    } catch (error) {
      const value = current(record);
      if (value.receipt.status === 'accepted' || value.receipt.status === 'rejected') return value.receipt;
      if (value.owner?.token !== owner.token || value.owner.pid !== owner.pid) return value.receipt;
      const reconciled = reconcile(value);
      if (reconciled) return reconciled;
      return finish(value, error instanceof RunCommandRejection ? 'rejected' : 'recovery-required',
        error instanceof RunCommandRejection ? error.message : 'Command delivery needs reconciliation.', true);
    }
  }
  return {
    async submit(caller, input) {
      validateRunCommandCaller(caller);
      const command = parseRunCommandV1(input);
      options.authorizeRead(caller, command.repo);
      const record = store.transaction(() => {
        const existing = store.get(caller, command.requestId);
        if (existing) {
          if (persistenceHash(existing.command) !== persistenceHash(command)) throw new PersistenceConflictError('Request ID already has different command content');
          return existing;
        }
        options.authorizeWrite(caller, command);
        return store.put(caller, command);
      });
      const reconciled = reconcile(record);
      if (reconciled) return reconciled;
      const claimed = store.claim(caller, command.requestId, owner, alive);
      if (!claimed) return current(record).receipt;
      return dispatch(claimed);
    },
    receipt(caller, input) {
      validateRunCommandCaller(caller);
      const query = parseRunCommandReceiptQueryV1(input);
      options.authorizeRead(caller, query.repo);
      const record = store.get(caller, query.requestId);
      if (!record) return null;
      if (record.command.repo !== query.repo) throw new RunCommandError(404, 'Command receipt not found');
      return reconcile(record) ?? record.receipt;
    },
  };
}
