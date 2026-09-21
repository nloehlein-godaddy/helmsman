import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseClarificationCommandInputV1, parseClarificationCommandReceiptQueryV1, parseClarificationCommandReceiptV1, parseClarificationCommandV1 } from './clarification-command';
import type { ClarificationCommandInputV1, ClarificationCommandReceiptQueryV1, ClarificationCommandReceiptV1, ClarificationCommandV1 } from './clarification-command';

export type ClarificationCommandJournal = ClarificationJournal<ClarificationCommandInputV1, ClarificationCommandV1, ClarificationCommandReceiptV1, ClarificationCommandReceiptQueryV1>;
export function createClarificationCommandJournal(caller: string, options: ClarificationJournalOptions = {}): ClarificationCommandJournal {
  return createClarificationJournal<ClarificationCommandInputV1, ClarificationCommandV1, ClarificationCommandReceiptV1, ClarificationCommandReceiptQueryV1>(caller, options, {
    database: 'helmsman.clarification-commands', parseInput: parseClarificationCommandInputV1, parseCommand: parseClarificationCommandV1,
    parseReceipt: parseClarificationCommandReceiptV1, parseQuery: parseClarificationCommandReceiptQueryV1,
    key: input => [input.repo, input.runId, input.questionId],
    input(command) { const { requestId: _id, ...input } = command; return parseClarificationCommandInputV1(input); },
    create: (input, uuid) => parseClarificationCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.repo === query.repo,
  });
}
