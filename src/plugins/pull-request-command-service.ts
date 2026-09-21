import { SourceContractValidationError } from './source-contract-validation';
import { PULL_REQUEST_COMMAND_LIMITS, parsePullRequestCommandInputV1, parsePullRequestCommandReceiptQueryV1, parsePullRequestCommandReceiptV1 } from './pull-request-command';
import type { PullRequestCommandReceiptV1, PullRequestCommandServiceV1 } from './pull-request-command';
import type { ClarificationReadResultV1 } from './clarification-read';
import { createPullRequestCommandJournal, type PullRequestCommandJournal } from './pull-request-command-journal';
import { ClarificationJournalConflictError, ClarificationJournalValidationError } from './clarification-journal';
import { clarificationAbortable, clarificationAvailable, clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';

export function createHostPullRequestCommandService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: PullRequestCommandJournal }): PullRequestCommandServiceV1 {
  const journal = options.journal ?? createPullRequestCommandJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, PULL_REQUEST_COMMAND_LIMITS.responseBytes);
  async function record(result: ClarificationReadResultV1<PullRequestCommandReceiptV1 | null>, call: ReturnType<typeof operation>): Promise<ClarificationReadResultV1<PullRequestCommandReceiptV1 | null>> {
    if (result.status === 'unavailable' || result.value === null) return result;
    try { const receipt = await clarificationAbortable(journal.record(result.value), call.signal); call.check(); return clarificationAvailable(receipt); }
    catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable'); }
  }
  return Object.freeze<PullRequestCommandServiceV1>({
    version: 1,
    async submit(value, signal) {
      const input = parsePullRequestCommandInputV1(value); const call = operation(signal);
      if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      let command;
      try { command = await clarificationAbortable(journal.reserve(input, call.signal), call.signal); }
      catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalConflictError ? 'conflict' : 'service-unavailable'); }
      call.check(); const result = await record(await call.request('/api/pull-request-command', value => parsePullRequestCommandReceiptV1(value, command), { command, scopeRepo: call.scope.repo }), call);
      return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
    },
    async retry(value, signal) {
      const input = parsePullRequestCommandReceiptQueryV1(value); const call = operation(signal);
      if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      let command;
      try { command = await clarificationAbortable(journal.retained(input, call.signal), call.signal); }
      catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable'); }
      call.check();
      if (!command) return clarificationUnavailable('not-found');
      const result = await record(await call.request('/api/pull-request-command', value => parsePullRequestCommandReceiptV1(value, command), { command, scopeRepo: call.scope.repo }), call);
      return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
    },
    async receipt(value, signal) {
      const input = parsePullRequestCommandReceiptQueryV1(value); const call = operation(signal);
      if (!call.allowed(input.repo)) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ repo: input.repo }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return record(await call.request(`/api/pull-request-command/receipts/${encodeURIComponent(input.requestId)}?${query}`, value => value === null ? null : parsePullRequestCommandReceiptV1(value, input)), call);
    },
    async pending() {
      const call = operation(); const pending = await clarificationAbortable(journal.pending(call.signal), call.signal); call.check();
      return Object.freeze(pending.filter(entry => call.allowed(entry.command.repo)));
    },
    async acknowledge(value, signal) {
      const input = parsePullRequestCommandReceiptQueryV1(value); const call = operation(signal);
      if (!call.allowed(input.repo)) throw new TypeError('Command is outside the current scope');
      await clarificationAbortable(journal.acknowledge(input, call.signal), call.signal); call.check();
    },
  });
}
