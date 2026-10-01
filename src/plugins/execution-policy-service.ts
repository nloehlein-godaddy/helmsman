import { clarificationUnavailable, createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { parseExecutionPolicyCommandV1, parseExecutionPolicyQueryV1, parseExecutionPolicySnapshotV1, parseExecutionPolicyValueV1, type ExecutionPolicyServiceV1 } from './execution-policy';

export function createHostExecutionPolicyService(lifetime: AbortSignal, options: ClarificationHostOptions): ExecutionPolicyServiceV1 {
  const operation = createClarificationTransport(lifetime, options, 262144);
  return Object.freeze<ExecutionPolicyServiceV1>({ version: 1,
    async read(raw, signal) {
      const input = parseExecutionPolicyQueryV1(raw); const call = operation(signal);
      if (call.scope.repo !== null && call.scope.repo.toLowerCase() !== input.repo) return clarificationUnavailable('forbidden');
      const query = new URLSearchParams({ version: '1', repo: input.repo }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/execution-policy?${query}`, value => { const result = parseExecutionPolicySnapshotV1(value); if (result.repo !== input.repo) throw new TypeError('Execution policy scope changed'); return result; });
    },
    async set(raw, signal) {
      const input = parseExecutionPolicyCommandV1(raw); const call = operation(signal);
      if (call.scope.repo !== null && call.scope.repo.toLowerCase() !== input.repo) return clarificationUnavailable('forbidden');
      return call.request('/api/execution-policy', value => { const result = parseExecutionPolicyValueV1(value);
        if (result.repo !== input.repo || result.revision !== input.expectedRevision + 1 || result.maxConcurrentRuns !== input.maxConcurrentRuns) throw new TypeError('Execution policy receipt changed'); return result;
      }, { command: input, scopeRepo: call.scope.repo });
    },
  });
}
