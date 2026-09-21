import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseSuggestedContactAdminCommandV1, parseSuggestedContactAdminInputV1, parseSuggestedContactAdminReceiptQueryV1, parseSuggestedContactAdminReceiptV1 } from './suggested-contact-admin';
import type { SuggestedContactAdminCommandV1, SuggestedContactAdminInputV1, SuggestedContactAdminReceiptQueryV1, SuggestedContactAdminReceiptV1 } from './suggested-contact-admin';

export type SuggestedContactAdminJournal = ClarificationJournal<SuggestedContactAdminInputV1, SuggestedContactAdminCommandV1, SuggestedContactAdminReceiptV1, SuggestedContactAdminReceiptQueryV1>;
export function createSuggestedContactAdminJournal(caller: string, options: ClarificationJournalOptions = {}): SuggestedContactAdminJournal {
  return createClarificationJournal<SuggestedContactAdminInputV1, SuggestedContactAdminCommandV1, SuggestedContactAdminReceiptV1, SuggestedContactAdminReceiptQueryV1>(caller, options, {
    database: 'helmsman.suggested-contact-commands', parseInput: parseSuggestedContactAdminInputV1, parseCommand: parseSuggestedContactAdminCommandV1,
    parseReceipt: parseSuggestedContactAdminReceiptV1, parseQuery: parseSuggestedContactAdminReceiptQueryV1,
    key: input => input.kind === 'create' ? ['global', 'create'] : ['global', 'update', input.id],
    input(command) {
      const { requestId: _requestId, ...intent } = command;
      if (intent.kind === 'create') { const { id: _id, ...input } = intent; return parseSuggestedContactAdminInputV1(input); }
      return parseSuggestedContactAdminInputV1(intent);
    },
    create: (input, uuid) => parseSuggestedContactAdminCommandV1({ ...input, ...(input.kind === 'create' ? { id: uuid() } : {}), requestId: uuid() }),
    matches: (command, query) => command.scope === query.scope,
  });
}
