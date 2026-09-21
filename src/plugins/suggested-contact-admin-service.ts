import { SourceContractValidationError } from './source-contract-validation';
import { SUGGESTED_CONTACT_ADMIN_LIMITS, parseSuggestedContactAdminContactV1, parseSuggestedContactAdminInputV1, parseSuggestedContactAdminListQueryV1,
  parseSuggestedContactAdminLoadQueryV1, parseSuggestedContactAdminPageV1, parseSuggestedContactAdminReceiptQueryV1, parseSuggestedContactAdminReceiptV1 } from './suggested-contact-admin';
import type { SuggestedContactAdminReceiptV1, SuggestedContactAdminServiceV1 } from './suggested-contact-admin';
import type { ClarificationReadResultV1 } from './clarification-read';
import { createSuggestedContactAdminJournal, type SuggestedContactAdminJournal } from './suggested-contact-admin-journal';
import { ClarificationJournalConflictError, ClarificationJournalValidationError } from './clarification-journal';
import { clarificationAbortable, clarificationAvailable, clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';

export function createHostSuggestedContactAdminService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: SuggestedContactAdminJournal }): SuggestedContactAdminServiceV1 {
  const journal = options.journal ?? createSuggestedContactAdminJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, SUGGESTED_CONTACT_ADMIN_LIMITS.responseBytes);
  async function record(result: ClarificationReadResultV1<SuggestedContactAdminReceiptV1 | null>, call: ReturnType<typeof operation>): Promise<ClarificationReadResultV1<SuggestedContactAdminReceiptV1 | null>> {
    if (result.status === 'unavailable' || result.value === null) return result;
    try { const receipt = await clarificationAbortable(journal.record(result.value), call.signal); call.check(); return clarificationAvailable(receipt); }
    catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable'); }
  }
  return Object.freeze<SuggestedContactAdminServiceV1>({
    version: 1,
    async list(value, signal) {
      const input = parseSuggestedContactAdminListQueryV1(value); const call = operation(signal); const query = new URLSearchParams({ scope: 'global', limit: String(input.limit) });
      if (input.cursor !== null) query.set('cursor', input.cursor);
      return call.request(`/api/suggested-contact-admin?${query}`, value => parseSuggestedContactAdminPageV1(value, input));
    },
    async load(value, signal) {
      const input = parseSuggestedContactAdminLoadQueryV1(value); const call = operation(signal);
      return call.request(`/api/suggested-contact-admin/${encodeURIComponent(input.id)}?scope=global`, value => parseSuggestedContactAdminContactV1(value, input.id));
    },
    async submit(value, signal) {
      const input = parseSuggestedContactAdminInputV1(value); const call = operation(signal); let command;
      try { command = await clarificationAbortable(journal.reserve(input, call.signal), call.signal); }
      catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalConflictError ? 'conflict' : 'service-unavailable'); }
      call.check(); const result = await record(await call.request('/api/suggested-contact-admin/commands', value => parseSuggestedContactAdminReceiptV1(value, command), command), call);
      return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
    },
    async retry(value, signal) {
      const input = parseSuggestedContactAdminReceiptQueryV1(value); const call = operation(signal); let command;
      try { command = await clarificationAbortable(journal.retained(input, call.signal), call.signal); }
      catch (error) { call.check(); return clarificationUnavailable(error instanceof ClarificationJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable'); }
      call.check();
      if (!command) return clarificationUnavailable('not-found');
      const result = await record(await call.request('/api/suggested-contact-admin/commands', value => parseSuggestedContactAdminReceiptV1(value, command), command), call);
      return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
    },
    async receipt(value, signal) {
      const input = parseSuggestedContactAdminReceiptQueryV1(value); const call = operation(signal);
      return record(await call.request(`/api/suggested-contact-admin/receipts/${encodeURIComponent(input.requestId)}?scope=global`, value => value === null ? null : parseSuggestedContactAdminReceiptV1(value, input)), call);
    },
    async pending() { const call = operation(); const pending = await clarificationAbortable(journal.pending(call.signal), call.signal); call.check(); return pending; },
    async acknowledge(value, signal) {
      const input = parseSuggestedContactAdminReceiptQueryV1(value); const call = operation(signal);
      await clarificationAbortable(journal.acknowledge(input, call.signal), call.signal); call.check();
    },
  });
}
