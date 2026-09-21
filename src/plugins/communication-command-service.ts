import type { ClarificationReadResultV1 } from "./clarification-read";
import {
  ClarificationJournalConflictError,
  ClarificationJournalValidationError,
} from "./clarification-journal";
import {
  COMMUNICATION_COMMAND_LIMITS,
  parseCommunicationCommandInputV1,
  parseCommunicationCommandReceiptQueryV1,
  parseCommunicationCommandReceiptV1,
  type CommunicationCommandReceiptV1,
  type CommunicationCommandServiceV1,
} from "./communication-command";
import {
  createCommunicationCommandJournal,
  type CommunicationCommandJournal,
} from "./communication-command-journal";
import { SourceContractValidationError } from "./source-contract-validation";
import {
  clarificationAbortable,
  clarificationAvailable,
  clarificationUnavailable,
  createClarificationTransport,
  type ClarificationHostOptions,
} from "./clarification-transport";

export function createHostCommunicationCommandService(
  lifetime: AbortSignal,
  options: ClarificationHostOptions & {
    readonly journal?: CommunicationCommandJournal;
  },
): CommunicationCommandServiceV1 {
  const journal =
    options.journal ?? createCommunicationCommandJournal(options.caller);
  const operation = createClarificationTransport(
    lifetime,
    options,
    COMMUNICATION_COMMAND_LIMITS.responseBytes,
  );

  async function record(
    result: ClarificationReadResultV1<CommunicationCommandReceiptV1 | null>,
    call: ReturnType<typeof operation>,
  ): Promise<ClarificationReadResultV1<CommunicationCommandReceiptV1 | null>> {
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
  ): Promise<ClarificationReadResultV1<CommunicationCommandReceiptV1>> {
    const result = await record(
      await call.request(
        "/api/communication-command",
        (value) => parseCommunicationCommandReceiptV1(value, command),
        { command, scopeRepo: call.scope.repo },
      ),
      call,
    );
    if (result.status === "unavailable") return result;
    return result.value === null
      ? clarificationUnavailable("invalid-response")
      : clarificationAvailable(result.value);
  }

  return Object.freeze<CommunicationCommandServiceV1>({
    version: 1,
    async submit(value, signal) {
      const input = parseCommunicationCommandInputV1(value);
      const call = operation(signal);
      if (!call.allowed(input.repo))
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
      const input = parseCommunicationCommandReceiptQueryV1(value);
      const call = operation(signal);
      if (!call.allowed(input.repo))
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
      return send(command, call);
    },
    async receipt(value, signal) {
      const input = parseCommunicationCommandReceiptQueryV1(value);
      const call = operation(signal);
      if (!call.allowed(input.repo))
        return clarificationUnavailable("forbidden");
      const query = new URLSearchParams({ repo: input.repo });
      if (call.scope.repo !== null) query.set("scopeRepo", call.scope.repo);
      return record(
        await call.request(
          `/api/communication-command/receipts/${encodeURIComponent(input.requestId)}?${query}`,
          (value) =>
            value === null
              ? null
              : parseCommunicationCommandReceiptV1(value, input),
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
        pending.filter((entry) => call.allowed(entry.command.repo)),
      );
    },
    async acknowledge(value, signal) {
      const input = parseCommunicationCommandReceiptQueryV1(value);
      const call = operation(signal);
      if (!call.allowed(input.repo))
        throw new TypeError("Command is outside the current scope");
      await clarificationAbortable(
        journal.acknowledge(input, call.signal),
        call.signal,
      );
      call.check();
    },
  });
}
