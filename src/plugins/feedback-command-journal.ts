import {
  createClarificationJournal,
  type ClarificationJournal,
  type ClarificationJournalOptions,
} from "./clarification-journal";
import {
  parseFeedbackInputV1,
  parseFeedbackReceiptQueryV1,
  parseFeedbackReceiptV1,
  parseFeedbackCommandV1,
  type FeedbackCommandInputV1,
  type FeedbackReceiptQueryV1,
  type FeedbackReceiptV1,
  type FeedbackCommandV1,
} from "./feedback-command";

export type FeedbackCommandJournal = ClarificationJournal<
  FeedbackCommandInputV1,
  FeedbackCommandV1,
  FeedbackReceiptV1,
  FeedbackReceiptQueryV1
>;

export function createFeedbackCommandJournal(
  caller: string,
  options: ClarificationJournalOptions = {},
): FeedbackCommandJournal {
  return createClarificationJournal<
    FeedbackCommandInputV1,
    FeedbackCommandV1,
    FeedbackReceiptV1,
    FeedbackReceiptQueryV1
  >(caller, options, {
    database: "helmsman.feedback-commands",
    parseInput: parseFeedbackInputV1,
    parseCommand: parseFeedbackCommandV1,
    parseReceipt: parseFeedbackReceiptV1,
    parseQuery: parseFeedbackReceiptQueryV1,
    key: (input) => [input.draftId],
    terminal: (receipt) =>
      receipt.status === "succeeded" || receipt.status === "rejected",
    input(command) {
      const { requestId: _requestId, ...input } = command;
      return parseFeedbackInputV1(input);
    },
    create: (input, uuid) =>
      parseFeedbackCommandV1({ ...input, requestId: uuid() }),
    matches: (command, query) => command.context.repo === query.repo,
  });
}
