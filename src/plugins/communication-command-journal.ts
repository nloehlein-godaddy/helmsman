import {
  createClarificationJournal,
  type ClarificationJournal,
  type ClarificationJournalOptions,
} from "./clarification-journal";
import {
  parseCommunicationCommandInputV1,
  parseCommunicationCommandReceiptQueryV1,
  parseCommunicationCommandReceiptV1,
  parseCommunicationCommandV1,
  type CommunicationCommandInputV1,
  type CommunicationCommandReceiptQueryV1,
  type CommunicationCommandReceiptV1,
  type CommunicationCommandV1,
} from "./communication-command";

export type CommunicationCommandJournal = ClarificationJournal<
  CommunicationCommandInputV1,
  CommunicationCommandV1,
  CommunicationCommandReceiptV1,
  CommunicationCommandReceiptQueryV1
>;

export function createCommunicationCommandJournal(
  caller: string,
  options: ClarificationJournalOptions = {},
): CommunicationCommandJournal {
  return createClarificationJournal<
    CommunicationCommandInputV1,
    CommunicationCommandV1,
    CommunicationCommandReceiptV1,
    CommunicationCommandReceiptQueryV1
  >(caller, options, {
    database: "helmsman.communication-commands",
    parseInput: parseCommunicationCommandInputV1,
    parseCommand: parseCommunicationCommandV1,
    parseReceipt: parseCommunicationCommandReceiptV1,
    parseQuery: parseCommunicationCommandReceiptQueryV1,
    key: (input) => [input.repo, input.number],
    terminal: (receipt) =>
      receipt.status === "succeeded" || receipt.status === "rejected",
    input(command) {
      const { requestId: _requestId, ...input } = command;
      return parseCommunicationCommandInputV1(input);
    },
    create: (input, uuid) =>
      parseCommunicationCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.repo === query.repo,
  });
}
