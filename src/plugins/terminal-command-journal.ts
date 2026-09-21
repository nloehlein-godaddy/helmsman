import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseTerminalControlCommandV1, parseTerminalControlInputV1, parseTerminalControlReceiptV1, parseTerminalReceiptQueryV1,
  type TerminalControlInputV1, type TerminalControlCommandV1, type TerminalControlReceiptV1, type TerminalReceiptQueryV1 } from './terminal';

export type TerminalCommandJournal = ClarificationJournal<TerminalControlInputV1, TerminalControlCommandV1, TerminalControlReceiptV1, TerminalReceiptQueryV1>;
export function createTerminalCommandJournal(caller: string, options: ClarificationJournalOptions = {}): TerminalCommandJournal {
  return createClarificationJournal<TerminalControlInputV1, TerminalControlCommandV1, TerminalControlReceiptV1, TerminalReceiptQueryV1>(caller, options, {
    database: 'helmsman.terminal-commands', parseInput: parseTerminalControlInputV1, parseCommand: parseTerminalControlCommandV1,
    parseReceipt: parseTerminalControlReceiptV1, parseQuery: parseTerminalReceiptQueryV1,
    key: input => [input.target.repo, input.target.surfaceRef],
    terminal: receipt => receipt.status !== 'pending',
    input(command) { const { requestId: _id, ...input } = command; return parseTerminalControlInputV1(input); },
    create: (input, uuid) => parseTerminalControlCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.target.repo === query.repo,
  });
}
