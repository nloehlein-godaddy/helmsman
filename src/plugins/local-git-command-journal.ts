import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseLocalGitControlCommandV1, parseLocalGitControlInputV1, parseLocalGitControlReceiptV1, parseLocalGitReceiptQueryV1,
  type LocalGitControlInputV1, type LocalGitControlCommandV1, type LocalGitControlReceiptV1, type LocalGitReceiptQueryV1 } from './local-git';

export type LocalGitCommandJournal = ClarificationJournal<LocalGitControlInputV1, LocalGitControlCommandV1, LocalGitControlReceiptV1, LocalGitReceiptQueryV1>;
export function createLocalGitCommandJournal(caller: string, options: ClarificationJournalOptions = {}): LocalGitCommandJournal {
  return createClarificationJournal<LocalGitControlInputV1, LocalGitControlCommandV1, LocalGitControlReceiptV1, LocalGitReceiptQueryV1>(caller, options, {
    database: 'helmsman.local-git-commands', parseInput: parseLocalGitControlInputV1, parseCommand: parseLocalGitControlCommandV1,
    parseReceipt: parseLocalGitControlReceiptV1, parseQuery: parseLocalGitReceiptQueryV1,
    key: input => [input.target.repo],
    terminal: receipt => receipt.status !== 'pending',
    input(command) { const { requestId: _id, ...input } = command; return parseLocalGitControlInputV1(input); },
    create: (input, uuid) => parseLocalGitControlCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.target.repo === query.repo,
  });
}
