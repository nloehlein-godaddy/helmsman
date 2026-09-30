import { createClarificationTransport, clarificationAbortable, type ClarificationHostOptions } from './clarification-transport';
import type { ClarificationReadResultV1 } from './clarification-read';
import { SourceContractValidationError } from './source-contract-validation';
import { parseTaskReadSelectionV1 } from './task-read';
import { SOURCE_REMOTE_ACTION_LIMITS, parseSourceRemoteActionInputV1, parseSourceRemoteActionReceiptQueryV1, parseSourceRemoteActionReceiptV1, parseSourceRemoteActionDiscoveryV1,
  type SourceRemoteActionReceiptV1, type TaskActionServiceV1 } from './task-actions';
import type { SourceCommandResultV1 } from './source-command';
import { createTaskActionJournal, TaskActionJournalConflictError, TaskActionJournalValidationError, type TaskActionJournal } from './task-action-journal';

const normalize = <T>(result: ClarificationReadResultV1<T>): SourceCommandResultV1<T> => result.status === 'available' ? result
  : { status: 'unavailable', reason: result.reason === 'cursor-invalid' ? 'invalid-response' : result.reason };

export function createHostTaskActionService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: TaskActionJournal }): TaskActionServiceV1 {
  const journal = options.journal ?? createTaskActionJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, SOURCE_REMOTE_ACTION_LIMITS.responseBytes);
  async function record(result: ClarificationReadResultV1<SourceRemoteActionReceiptV1 | null>, call: ReturnType<typeof operation>): Promise<SourceCommandResultV1<SourceRemoteActionReceiptV1 | null>> {
    if (result.status === 'unavailable' || result.value === null) return normalize(result);
    try { const receipt = await clarificationAbortable(journal.record(result.value), call.signal); call.check(); return { status: 'available', value: receipt }; }
    catch (error) {
      call.check(); return { status: 'unavailable', reason: error instanceof TaskActionJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable' };
    }
  }
  async function send(command: Awaited<ReturnType<typeof journal.reserve>>, call: ReturnType<typeof operation>, retry = false): Promise<SourceCommandResultV1<SourceRemoteActionReceiptV1>> {
    const response = await call.request(retry ? '/api/task-action/retry' : '/api/task-action', value => parseSourceRemoteActionReceiptV1(value, command),
      retry ? { query: { repo: command.selection.repo, requestId: command.requestId }, scopeRepo: call.scope.repo } : { command, scopeRepo: call.scope.repo });
    if (retry && response.status === 'unavailable' && response.reason === 'not-found') return send(command, call);
    const result = await record(response, call);
    return result.status === 'unavailable' ? result : result.value === null ? { status: 'unavailable', reason: 'invalid-response' } : { status: 'available', value: result.value };
  }
  return Object.freeze<TaskActionServiceV1>({
    version: 1,
    async discover(value, signal) {
      const selection = parseTaskReadSelectionV1(value); const call = operation(signal);
      if (!call.allowed(selection.repo)) return { status: 'unavailable', reason: 'forbidden' };
      return normalize(await call.request('/api/task-action/discover', data => parseSourceRemoteActionDiscoveryV1(data, selection), { selection, scopeRepo: call.scope.repo }));
    },
    async submit(value, signal) {
      const input = parseSourceRemoteActionInputV1(value); const call = operation(signal);
      if (!call.allowed(input.selection.repo)) return { status: 'unavailable', reason: 'forbidden' };
      let command;
      try { command = await clarificationAbortable(journal.reserve(input, call.signal), call.signal); }
      catch (error) { call.check(); return { status: 'unavailable', reason: error instanceof TaskActionJournalConflictError ? 'conflict' : 'service-unavailable' }; }
      call.check(); return send(command, call);
    },
    async retry(value, signal) {
      const query = parseSourceRemoteActionReceiptQueryV1(value); const call = operation(signal);
      if (!call.allowed(query.repo)) return { status: 'unavailable', reason: 'forbidden' };
      let command;
      try { command = await clarificationAbortable(journal.retained(query, call.signal), call.signal); }
      catch (error) { call.check(); return { status: 'unavailable', reason: error instanceof TaskActionJournalValidationError || error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable' }; }
      call.check(); if (!command) return { status: 'unavailable', reason: 'not-found' };
      return send(command, call, true);
    },
    async receipt(value, signal) {
      const query = parseSourceRemoteActionReceiptQueryV1(value); const call = operation(signal);
      if (!call.allowed(query.repo)) return { status: 'unavailable', reason: 'forbidden' };
      const params = new URLSearchParams({ repo: query.repo }); if (call.scope.repo !== null) params.set('scopeRepo', call.scope.repo);
      return record(await call.request(`/api/task-action/receipts/${encodeURIComponent(query.requestId)}?${params}`,
        value => value === null ? null : parseSourceRemoteActionReceiptV1(value, query)), call);
    },
    async pending() {
      const call = operation(); const entries = await clarificationAbortable(journal.pending(call.signal), call.signal); call.check();
      return Object.freeze(entries.filter(entry => call.allowed(entry.command.selection.repo)));
    },
    async acknowledge(value) {
      const query = parseSourceRemoteActionReceiptQueryV1(value); const call = operation();
      if (!call.allowed(query.repo)) throw new TypeError('Assignment is outside the current scope');
      await clarificationAbortable(journal.acknowledge(query, call.signal), call.signal); call.check();
    },
  });
}
