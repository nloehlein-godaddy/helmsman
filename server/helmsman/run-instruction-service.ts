import { randomUUID } from 'node:crypto';
import { parseRunInstructionCommandV1, parseRunInstructionQueryV1, parseRunInstructionReceiptQueryV1, parseRunInstructionSnapshotV1,
  type RunInstructionCommandV1, type RunInstructionQueryV1, type RunInstructionReceiptQueryV1, type RunInstructionReceiptV1 } from '../../src/plugins/run-instructions';
import { isContributionId } from '../../src/plugins/manifest';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { openRunInstructionStore } from './run-instruction-store';
import { PersistenceConflictError, stableJson, type Persistence } from './persistence';
import { instructionDirectory, readInstructions, sendInstruction, InstructionError } from './instruction-channel';

export interface RunInstructionBinding { readonly repo: string; readonly attempt: number; readonly channelId: string | null; readonly active: boolean; readonly supported: boolean; }
export interface RunInstructionServerOptions {
  persistence: Persistence; runsDir: string; repos(): readonly string[]; authorize(caller: string): void;
  resolve(runId: string): RunInstructionBinding | null;
  read?: typeof readInstructions; send?: typeof sendInstruction;
}
export function createRunInstructionService(options: RunInstructionServerOptions) {
  const store = openRunInstructionStore(options.persistence); const dispatching = new Set<string>();
  const read = options.read ?? readInstructions; const send = options.send ?? sendInstruction;
  function authorize(caller: string, repo: string, scopeRepo: string | null) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller); clarificationScope(options.repos(), scopeRepo, repo);
  }
  const key = (caller: string, requestId: string) => JSON.stringify([caller, requestId]);
  const directory = (input: RunInstructionCommandV1 | RunInstructionReceiptV1['input']) => instructionDirectory(options.runsDir, input.runId, input.expectedAttempt, input.expectedChannelId);
  function binding(input: RunInstructionQueryV1) {
    const current = options.resolve(input.runId);
    if (!current || current.repo !== input.repo) throw new ClarificationServiceError(404, 'not-found');
    return current;
  }
  async function reconcile(caller: string, requestId: string) {
    const saved = store.read(caller, requestId);
    if (!saved || !['sending', 'unknown'].includes(saved.receipt.status)) return saved?.receipt ?? null;
    const { receipt, deliveryId } = saved; const input = receipt.input; const current = options.resolve(input.runId);
    const active = current?.repo === input.repo && current.attempt === input.expectedAttempt && current.channelId === input.expectedChannelId && current.active;
    const snapshot = await read(directory(input), active);
    const record = snapshot.instructions.find(item => item.id === deliveryId && item.targetId === input.targetId);
    if (record && record.text !== input.text) throw new PersistenceConflictError('Instruction acknowledgment content changed');
    const status = record?.status ?? (dispatching.has(key(caller, requestId)) ? 'sending' : 'unknown');
    const next = { ...receipt, status, message: record?.error?.slice(0, 2000) ?? (status === 'unknown' ? 'Delivery could not be confirmed. This request will not be sent again.' : null) };
    return options.persistence.transaction(() => {
      const latest = store.read(caller, requestId);
      if (latest && ['delivered', 'failed', 'rejected'].includes(latest.receipt.status)) return latest.receipt;
      return store.save(caller, deliveryId, next);
    });
  }
  return {
    async read(caller: string, raw: RunInstructionQueryV1, scopeRepo: string | null) {
      const input = parseRunInstructionQueryV1(raw); authorize(caller, input.repo, scopeRepo); const current = binding(input);
      let reason = current.attempt !== input.expectedAttempt ? 'This run has moved to another attempt.'
        : !current.active ? 'This run is no longer accepting instructions.' : !current.supported ? 'Live instructions are unavailable for this execution.'
        : !current.channelId ? 'This execution has no instruction channel.' : null;
      const snapshot = reason || !current.channelId ? null : await read(instructionDirectory(options.runsDir, input.runId, input.expectedAttempt, current.channelId), true);
      const latest = binding(input);
      if (latest.attempt !== current.attempt || latest.channelId !== current.channelId || !latest.active) reason = 'This execution has changed. Refresh the run.';
      const targets = reason ? [] : snapshot?.targets ?? [];
      return parseRunInstructionSnapshotV1({ ...input, channelId: current.attempt === input.expectedAttempt ? current.channelId : null,
        available: targets.length > 0, reason: targets.length ? null : reason ?? snapshot?.reason ?? 'Waiting for an agent that can receive instructions.', targets: targets.map(({ id, provider, stage }) => ({ id, provider, stage })) });
    },
    async submit(caller: string, raw: RunInstructionCommandV1, scopeRepo: string | null) {
      const command = parseRunInstructionCommandV1(raw); authorize(caller, command.repo, scopeRepo);
      const { requestId, ...input } = command; const dispatchKey = key(caller, requestId);
      const previous = store.read(caller, requestId);
      if (previous) {
        if (stableJson(previous.receipt.input) !== stableJson(input)) throw new PersistenceConflictError('Instruction request content changed');
        return (await reconcile(caller, requestId))!;
      }
      const deliveryId = randomUUID();
      const receipt = options.persistence.transaction(() => {
        const current = binding(input);
        const valid = current.active && current.supported && current.attempt === input.expectedAttempt && current.channelId === input.expectedChannelId;
        return store.save(caller, deliveryId, { version: 1, requestId, input, status: valid ? 'sending' : 'rejected',
          message: valid ? null : 'The selected execution is no longer accepting this instruction.' });
      });
      if (receipt.status === 'rejected') return receipt;
      dispatching.add(dispatchKey);
      try {
        const current = binding(input);
        if (!current.active || !current.supported || current.attempt !== input.expectedAttempt || current.channelId !== input.expectedChannelId)
          return options.persistence.transaction(() => store.save(caller, deliveryId, { ...receipt, status: 'rejected', message: 'The selected execution changed before delivery.' }));
        await send(directory(input), { id: deliveryId, targetId: input.targetId, text: input.text });
      } catch (error) {
        if (error instanceof InstructionError && error.status >= 400 && error.status < 500)
          return options.persistence.transaction(() => store.save(caller, deliveryId, { ...receipt, status: 'rejected', message: error.message.slice(0, 2000) }));
        // A lost transport response does not prove that the agent rejected the instruction.
      } finally { dispatching.delete(dispatchKey); }
      return (await reconcile(caller, requestId))!;
    },
    async receipt(caller: string, raw: RunInstructionReceiptQueryV1, scopeRepo: string | null) {
      const input = parseRunInstructionReceiptQueryV1(raw); authorize(caller, input.repo, scopeRepo);
      const saved = store.read(caller, input.requestId);
      if (saved && saved.receipt.input.repo !== input.repo) throw new ClarificationServiceError(404, 'not-found');
      return reconcile(caller, input.requestId);
    },
  };
}
