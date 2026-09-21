import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parsePullRequestCommandInputV1, parsePullRequestCommandReceiptQueryV1, parsePullRequestCommandReceiptV1, parsePullRequestCommandV1 } from './pull-request-command';
import type { PullRequestCommandInputV1, PullRequestCommandReceiptQueryV1, PullRequestCommandReceiptV1, PullRequestCommandV1 } from './pull-request-command';

export type PullRequestCommandJournal = ClarificationJournal<PullRequestCommandInputV1, PullRequestCommandV1, PullRequestCommandReceiptV1, PullRequestCommandReceiptQueryV1>;
export function createPullRequestCommandJournal(caller: string, options: ClarificationJournalOptions = {}): PullRequestCommandJournal {
  return createClarificationJournal<PullRequestCommandInputV1, PullRequestCommandV1, PullRequestCommandReceiptV1, PullRequestCommandReceiptQueryV1>(caller, options, {
    database: 'helmsman.pull-request-commands', parseInput: parsePullRequestCommandInputV1, parseCommand: parsePullRequestCommandV1,
    parseReceipt: parsePullRequestCommandReceiptV1, parseQuery: parsePullRequestCommandReceiptQueryV1,
    key: input => [input.repo, input.number],
    terminal: receipt => receipt.status === 'succeeded' || receipt.status === 'rejected',
    input(command) { const { requestId: _id, ...input } = command; return parsePullRequestCommandInputV1(input); },
    create: (input, uuid) => parsePullRequestCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.repo === query.repo,
  });
}
