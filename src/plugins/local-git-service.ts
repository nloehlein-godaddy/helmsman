import { ClarificationJournalConflictError } from './clarification-journal';
import { clarificationAvailable, clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { createLocalGitCommandJournal, type LocalGitCommandJournal } from './local-git-command-journal';
import { LOCAL_GIT_LIMITS, parseLocalGitControlInputV1, parseLocalGitControlReceiptV1, parseLocalGitReceiptQueryV1,
  parseLocalGitPreviewV1, parseLocalGitSnapshotV1, parseLocalGitTargetV1, type LocalGitControlReceiptV1, type LocalGitReceiptQueryV1, type LocalGitServiceV1 } from './local-git';
import { parseTaskRepo } from './tasks';
import { clarificationBoolean } from './clarification-validation';
import type { ClarificationReadResultV1 } from './clarification-read';

export function createHostLocalGitService(lifetime: AbortSignal, options: ClarificationHostOptions & { journal?: LocalGitCommandJournal }): LocalGitServiceV1 {
  const journal = options.journal ?? createLocalGitCommandJournal(options.caller);
  const operation = createClarificationTransport(lifetime, options, LOCAL_GIT_LIMITS.responseBytes);
  type Call = ReturnType<typeof operation>;
  const allowed = (call: Call, repo: string) => call.scope.repo === null || call.scope.repo === repo;
  let queue: Promise<unknown> = Promise.resolve();
  async function record(result: ClarificationReadResultV1<LocalGitControlReceiptV1 | null>, call: Call) {
    if (result.status === 'unavailable' || result.value === null) return result;
    try { const receipt = await journal.record(result.value); call.check(); return clarificationAvailable(receipt); }
    catch { call.check(); return clarificationUnavailable('service-unavailable'); }
  }
  async function receipt(input: LocalGitReceiptQueryV1, call: Call) {
    const query = new URLSearchParams();
    if (input.repo !== null) query.set('repo', input.repo);
    if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
    return record(await call.request(`/api/local-git/receipts/${encodeURIComponent(input.requestId)}?${query}`, value => value === null ? null : parseLocalGitControlReceiptV1(value, input)), call);
  }
  return Object.freeze<LocalGitServiceV1>({
    version: 1,
    async snapshot(input, signal) {
      if (input?.version !== 1) throw new TypeError('Invalid local Git version');
      const repo = parseTaskRepo(input.repo); const call = operation(signal);
      if (!allowed(call, repo)) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ version: '1', repo }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/local-git/snapshot?${query}`, value => { const result = parseLocalGitSnapshotV1(value); if (result.repo !== repo) throw new TypeError('Local Git scope changed'); return result; });
    },
    async preview(input, signal) {
      const target = parseLocalGitTargetV1(input?.target); const force = clarificationBoolean(input?.force); const call = operation(signal);
      if (!allowed(call, target.repo)) return clarificationUnavailable('forbidden');
      return call.request('/api/local-git/preview', value => { const result = parseLocalGitPreviewV1(value, target); if (result.cleanup.force !== force) throw new TypeError('Cleanup force selection changed'); return result; }, { target, force, scopeRepo: call.scope.repo });
    },
    control(value, signal) {
      const input = parseLocalGitControlInputV1(value); const call = operation(signal);
      if (!allowed(call, input.target.repo)) return Promise.resolve(clarificationUnavailable('forbidden'));
      const next = queue.then(async (): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1>> => {
        call.check(); call.signal.throwIfAborted();
        try {
          const pending = await journal.pending(call.signal); call.check();
          const prior = pending.find(item => item.command.target.repo === input.target.repo);
          if (prior) {
            const { requestId: _id, ...original } = prior.command;
            if (JSON.stringify(original) !== JSON.stringify(input)) return clarificationUnavailable('conflict');
            if (prior.receipt) return clarificationAvailable(prior.receipt);
            const result = await receipt({ repo: input.target.repo, requestId: prior.command.requestId }, call);
            return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('conflict') : clarificationAvailable(result.value);
          }
          const command = await journal.reserve(input, call.signal); call.check(); call.signal.throwIfAborted();
          const result = await record(await call.request('/api/local-git/control', data => parseLocalGitControlReceiptV1(data, command), { command, scopeRepo: call.scope.repo }), call);
          return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
        } catch (error) {
          call.check(); call.signal.throwIfAborted();
          return clarificationUnavailable(error instanceof ClarificationJournalConflictError ? 'conflict' : 'service-unavailable');
        }
      });
      queue = next.catch(() => undefined); return next;
    },
    async receipt(value, signal) {
      const input = parseLocalGitReceiptQueryV1(value); const call = operation(signal);
      if (!allowed(call, input.repo)) return clarificationUnavailable('forbidden');
      const retained = await journal.retained(input, call.signal); call.check();
      if (!retained) return clarificationUnavailable('not-found');
      return receipt(input, call);
    },
    async inspect(value, signal) {
      const input = parseLocalGitReceiptQueryV1(value); const call = operation(signal);
      if (!allowed(call, input.repo)) return clarificationUnavailable('forbidden');
      const command = await journal.retained(input, call.signal); call.check(); call.signal.throwIfAborted();
      if (!command) return clarificationUnavailable('not-found');
      const result = await record(await call.request('/api/local-git/inspect', data => parseLocalGitControlReceiptV1(data, command), { command, scopeRepo: call.scope.repo }), call);
      return result.status === 'unavailable' ? result : result.value === null ? clarificationUnavailable('invalid-response') : clarificationAvailable(result.value);
    },
    async pending(signal) {
      const call = operation(signal); const entries = await journal.pending(call.signal); call.check();
      return Object.freeze(entries.filter(entry => allowed(call, entry.command.target.repo)));
    },
    async acknowledge(value, signal) {
      const input = parseLocalGitReceiptQueryV1(value); const call = operation(signal);
      if (!allowed(call, input.repo)) throw new TypeError('LocalGit command is outside the current scope');
      await journal.acknowledge(input, call.signal); call.check();
    },
  });
}
