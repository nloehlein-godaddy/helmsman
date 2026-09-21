import { createClarificationJournal, type ClarificationJournal, type ClarificationJournalOptions } from './clarification-journal';
import { parseCampaignCommandInputV1, parseCampaignCommandV1, parseCampaignCommandReceiptV1, parseCampaignReceiptQueryV1,
  type CampaignCommandInputV1, type CampaignCommandV1, type CampaignCommandReceiptV1, type CampaignReceiptQueryV1 } from './campaigns';
export type CampaignCommandJournal = ClarificationJournal<CampaignCommandInputV1, CampaignCommandV1, CampaignCommandReceiptV1, CampaignReceiptQueryV1>;
export function createCampaignCommandJournal(caller: string, options: ClarificationJournalOptions = {}): CampaignCommandJournal {
  return createClarificationJournal<CampaignCommandInputV1, CampaignCommandV1, CampaignCommandReceiptV1, CampaignReceiptQueryV1>(caller, options, {
    database: 'helmsman.campaign-commands', parseInput: parseCampaignCommandInputV1, parseCommand: parseCampaignCommandV1, parseReceipt: parseCampaignCommandReceiptV1, parseQuery: parseCampaignReceiptQueryV1,
    key: input => [input.repo], input(command) { const { requestId: _id, ...input } = command; return parseCampaignCommandInputV1(input); },
    create: (input, uuid) => parseCampaignCommandV1({ ...input, requestId: uuid() }), matches: (command, query) => command.repo === query.repo,
  });
}
