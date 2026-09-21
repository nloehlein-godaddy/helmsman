import { ClarificationJournalConflictError } from './clarification-journal';
import { clarificationAvailable, clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { createTerminalCommandJournal, type TerminalCommandJournal } from './terminal-command-journal';
import { TERMINAL_LIMITS, parseTerminalControlInputV1, parseTerminalControlReceiptV1, parseTerminalLines, parseTerminalReceiptQueryV1,
  parseTerminalRepo, parseTerminalScreenV1, parseTerminalSnapshotV1, parseTerminalTargetV1, type TerminalControlReceiptV1, type TerminalReceiptQueryV1, type TerminalServiceV1 } from './terminal';
import type { ClarificationReadResultV1 } from './clarification-read';

export function createHostTerminalService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: TerminalCommandJournal }): TerminalServiceV1 {
  const journal = options.journal ?? createTerminalCommandJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, TERMINAL_LIMITS.responseBytes);
  type Call = ReturnType<typeof operation>;
  const allowed = (call: Call, repo: string | null) => call.scope.repo === null || call.scope.repo === repo;
  let queue: Promise<unknown> = Promise.resolve();
  async function record(result: ClarificationReadResultV1<TerminalControlReceiptV1 | null>, call: Call) {
    if (result.status === 'unavailable' || result.value === null) return result;
    try { const receipt = await journal.record(result.value); call.check(); return clarificationAvailable(receipt); }
    catch { call.check(); return clarificationUnavailable('service-unavailable'); }
  }
  async function receipt(input: TerminalReceiptQueryV1, call: Call) {
    const query = new URLSearchParams();
    if (input.repo !== null) query.set('repo', input.repo);
    if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
    return record(await call.request(`/api/terminal/receipts/${encodeURIComponent(input.requestId)}?${query}`, value => value === null ? null : parseTerminalControlReceiptV1(value, input)), call);
  }
  return Object.freeze<TerminalServiceV1>({
    version: 1,
    async list(input, signal) {
      if (input?.version !== 1) throw new TypeError('Invalid terminal version');
      const repo = parseTerminalRepo(input.repo); const call = operation(signal);
      if (!allowed(call, repo)) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ version: '1' });
      if (repo !== null) query.set('repo', repo);
      if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/terminal/tabs?${query}`, value => { const result = parseTerminalSnapshotV1(value); if (result.repo !== repo) throw new TypeError('Terminal scope changed'); return result; });
    },
    async screen(input, signal) {
      const target = parseTerminalTargetV1(input?.target); const lines = parseTerminalLines(input?.lines); const call = operation(signal);
      if (!allowed(call, target.repo)) return clarificationUnavailable('forbidden');
      return call.request('/api/terminal/screen', value => parseTerminalScreenV1(value, target), { target, lines, scopeRepo: call.scope.repo });
    },
    control(value, signal) {
      const input = parseTerminalControlInputV1(value); const call = operation(signal);
      if (!allowed(call, input.target.repo)) return Promise.resolve(clarificationUnavailable('forbidden'));
      const next = queue.then(async (): Promise<ClarificationReadResultV1<TerminalControlReceiptV1>> => {
        call.check(); call.signal.throwIfAborted();
        try {
          const pending = await journal.pending(call.signal); call.check();
          const prior = pending.find(item => item.command.target.repo === input.target.repo && item.command.target.surfaceRef === input.target.surfaceRef);
          if (prior) {
            const { requestId: _id, ...original } = prior.command;
            if (JSON.stringify(original) !== JSON.stringify(input)) return clarificationUnavailable('conflict');
            if (prior.receipt) return clarificationAvailable(prior.receipt);
            const result = await receipt({ repo: input.target.repo, requestId: prior.command.requestId }, call);
            return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('conflict') : clarificationAvailable(result.value);
          }
          const command = await journal.reserve(input, call.signal); call.check(); call.signal.throwIfAborted();
          const result = await record(await call.request('/api/terminal/control', data => parseTerminalControlReceiptV1(data, command), { command, scopeRepo: call.scope.repo }), call);
          return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
        } catch (error) {
          call.check(); call.signal.throwIfAborted();
          return clarificationUnavailable(error instanceof ClarificationJournalConflictError ? 'conflict' : 'service-unavailable');
        }
      });
      queue = next.catch(() => undefined); return next;
    },
    async receipt(value, signal) {
      const input = parseTerminalReceiptQueryV1(value); const call = operation(signal);
      if (!allowed(call, input.repo)) return clarificationUnavailable('forbidden');
      const retained = await journal.retained(input, call.signal); call.check();
      if (!retained) return clarificationUnavailable('not-found');
      return receipt(input, call);
    },
    async pending(signal) {
      const call = operation(signal); const entries = await journal.pending(call.signal); call.check();
      return Object.freeze(entries.filter(entry => allowed(call, entry.command.target.repo)));
    },
    async acknowledge(value, signal) {
      const input = parseTerminalReceiptQueryV1(value); const call = operation(signal);
      if (!allowed(call, input.repo)) throw new TypeError('Terminal command is outside the current scope');
      await journal.acknowledge(input, call.signal); call.check();
    },
  });
}
