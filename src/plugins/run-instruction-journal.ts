import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseRunInstructionInputV1, parseRunInstructionReceiptQueryV1, parseRunInstructionReceiptV1, parseRunInstructionCommandV1 } from './run-instructions';
import type { RunInstructionInputV1, RunInstructionReceiptQueryV1, RunInstructionReceiptV1, RunInstructionCommandV1 } from './run-instructions';

export type RunInstructionJournal = ClarificationJournal<RunInstructionInputV1, RunInstructionCommandV1, RunInstructionReceiptV1, RunInstructionReceiptQueryV1>;
export function createRunInstructionJournal(caller: string, options: ClarificationJournalOptions = {}): RunInstructionJournal {
  return createClarificationJournal<RunInstructionInputV1, RunInstructionCommandV1, RunInstructionReceiptV1, RunInstructionReceiptQueryV1>(caller, options, {
    database: 'helmsman.run-instructions', terminal: receipt => receipt.status !== 'sending' && receipt.status !== 'unknown', parseInput: parseRunInstructionInputV1, parseCommand: parseRunInstructionCommandV1,
    parseReceipt: parseRunInstructionReceiptV1, parseQuery: parseRunInstructionReceiptQueryV1,
    key: input => [input.repo, input.runId, input.expectedAttempt, input.expectedChannelId, input.targetId],
    input(command) { const { requestId: _id, ...input } = command; return parseRunInstructionInputV1(input); },
    create: (input, uuid) => parseRunInstructionCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.repo === query.repo,
  });
}
