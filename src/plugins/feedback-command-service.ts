import type { ClarificationReadResultV1 } from "./clarification-read";
import {
  ClarificationJournalConflictError,
  ClarificationJournalValidationError,
} from "./clarification-journal";
import {
  parseFeedbackDestinationV1,
  parseFeedbackInputV1,
  parseFeedbackReceiptQueryV1,
  parseFeedbackReceiptV1,
  type FeedbackReceiptV1,
  type FeedbackCommandServiceV1,
} from "./feedback-command";
import {
  createFeedbackCommandJournal,
  type FeedbackCommandJournal,
} from "./feedback-command-journal";
import { SourceContractValidationError } from "./source-contract-validation";
import {
  clarificationAbortable,
  clarificationAvailable,
  clarificationUnavailable,
  createClarificationTransport,
  type ClarificationHostOptions,
} from "./clarification-transport";

export function createHostFeedbackCommandService(
  lifetime: AbortSignal,
  options: ClarificationHostOptions & {
    readonly journal?: FeedbackCommandJournal;
  },
): FeedbackCommandServiceV1 {
  const journal =
    options.journal ?? createFeedbackCommandJournal(options.caller);
  const operation = createClarificationTransport(
    lifetime,
    options,
    128 * 1024,
  );

  async function record(
    result: ClarificationReadResultV1<FeedbackReceiptV1 | null>,
    call: ReturnType<typeof operation>,
  ): Promise<ClarificationReadResultV1<FeedbackReceiptV1 | null>> {
    if (result.status === "unavailable" || result.value === null) return result;
    try {
      const receipt = await clarificationAbortable(
        journal.record(result.value),
        call.signal,
      );
      call.check();
      return clarificationAvailable(receipt);
    } catch (error) {
      call.check();
      return clarificationUnavailable(
        error instanceof ClarificationJournalValidationError ||
          error instanceof SourceContractValidationError
          ? "invalid-response"
          : "service-unavailable",
      );
    }
  }

  async function send(
    command: Awaited<ReturnType<typeof journal.reserve>>,
    call: ReturnType<typeof operation>,
    retry = false,
  ): Promise<ClarificationReadResultV1<FeedbackReceiptV1>> {
    const response = await call.request(
      retry ? "/api/feedback-command/retry" : "/api/feedback-command",
      (value) => parseFeedbackReceiptV1(value, command),
      { command, scopeRepo: call.scope.repo },
    );
    if (retry && response.status === 'unavailable' && response.reason === 'not-found') return send(command, call);
    const result = await record(response, call);
    if (result.status === "unavailable") return result;
    return result.value === null
      ? clarificationUnavailable("invalid-response")
      : clarificationAvailable(result.value);
  }

  return Object.freeze<FeedbackCommandServiceV1>({
    version: 1,
    context() { const call = operation(); return { version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown', repo: call.scope.repo, page: options.caller }; },
    async destination(signal) { return operation(signal).request("/api/feedback-command/destination", value => value === null ? null : parseFeedbackDestinationV1(value)); },
    async submit(value, signal) {
      const input = parseFeedbackInputV1(value);
      const call = operation(signal);
      if (!(input.context.repo === null ? call.scope.repo === null : call.allowed(input.context.repo)))
        return clarificationUnavailable("forbidden");
      let command: Awaited<ReturnType<typeof journal.reserve>>;
      try {
        command = await clarificationAbortable(
          journal.reserve(input, call.signal),
          call.signal,
        );
      } catch (error) {
        call.check();
        return clarificationUnavailable(
          error instanceof ClarificationJournalConflictError
            ? "conflict"
            : "service-unavailable",
        );
      }
      call.check();
      return send(command, call);
    },
    async retry(value, signal) {
      const input = parseFeedbackReceiptQueryV1(value);
      const call = operation(signal);
      if (!(input.repo === null ? call.scope.repo === null : call.allowed(input.repo)))
        return clarificationUnavailable("forbidden");
      let command: Awaited<ReturnType<typeof journal.retained>>;
      try {
        command = await clarificationAbortable(
          journal.retained(input, call.signal),
          call.signal,
        );
      } catch (error) {
        call.check();
        return clarificationUnavailable(
          error instanceof ClarificationJournalValidationError ||
            error instanceof SourceContractValidationError
            ? "invalid-response"
            : "service-unavailable",
        );
      }
      call.check();
      if (!command) return clarificationUnavailable("not-found");
      return send(command, call, true);
    },
    async receipt(value, signal) {
      const input = parseFeedbackReceiptQueryV1(value);
      const call = operation(signal);
      if (!(input.repo === null ? call.scope.repo === null : call.allowed(input.repo)))
        return clarificationUnavailable("forbidden");
      const query = new URLSearchParams(input.repo === null ? {} : { repo: input.repo });
      if (call.scope.repo !== null) query.set("scopeRepo", call.scope.repo);
      return record(
        await call.request(
          `/api/feedback-command/receipts/${encodeURIComponent(input.requestId)}?${query}`,
          (value) =>
            value === null
              ? null
              : (() => { const receipt = parseFeedbackReceiptV1(value); if (receipt.requestId !== input.requestId || receipt.input.context.repo !== input.repo) throw new TypeError("Feedback receipt scope changed"); return receipt; })(),
        ),
        call,
      );
    },
    async pending() {
      const call = operation();
      const pending = await clarificationAbortable(
        journal.pending(call.signal),
        call.signal,
      );
      call.check();
      return Object.freeze(
        pending.filter((entry) => (entry.command.context.repo === null ? call.scope.repo === null : call.allowed(entry.command.context.repo))),
      );
    },
    async acknowledge(value, signal) {
      const input = parseFeedbackReceiptQueryV1(value);
      const call = operation(signal);
      if (!(input.repo === null ? call.scope.repo === null : call.allowed(input.repo)))
        throw new TypeError("Command is outside the current scope");
      await clarificationAbortable(
        journal.acknowledge(input, call.signal),
        call.signal,
      );
      call.check();
    },
  });
}
