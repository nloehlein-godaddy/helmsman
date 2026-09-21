import { CLARIFICATION_READ_LIMITS, parseClarificationReadItemV1, parseClarificationReadListQueryV1, parseClarificationReadLoadQueryV1, parseClarificationReadPageV1 } from './clarification-read';
import type { ClarificationReadServiceV1 } from './clarification-read';
import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';

export function createHostClarificationReadService(lifetime: AbortSignal, options: ClarificationHostOptions): ClarificationReadServiceV1 {
  const operation = createClarificationTransport(lifetime, options, CLARIFICATION_READ_LIMITS.responseBytes);
  return Object.freeze<ClarificationReadServiceV1>({
    version: 1,
    async list(value, signal) {
      const input = parseClarificationReadListQueryV1(value); const call = operation(signal); const permission = await call.permitted(input.repo);
      if (permission.status === 'unavailable') return permission;
      const query = new URLSearchParams({ states: JSON.stringify(input.states), limit: String(input.limit) });
      if (input.repo !== null) query.set('repo', input.repo); if (input.runId !== null) query.set('runId', input.runId);
      if (input.cursor !== null) query.set('cursor', input.cursor); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/clarification-read?${query}`, result => parseClarificationReadPageV1(result, input, permission.value));
    },
    async load(value, signal) {
      const input = parseClarificationReadLoadQueryV1(value); const call = operation(signal); const permission = await call.permitted(input.repo);
      if (permission.status === 'unavailable') return permission;
      const query = new URLSearchParams({ repo: input.repo, runId: input.runId }); if (call.scope.repo !== null) query.set('scopeRepo', call.scope.repo);
      return call.request(`/api/clarification-read/${encodeURIComponent(input.questionId)}?${query}`, result => parseClarificationReadItemV1(result, input));
    },
  });
}
