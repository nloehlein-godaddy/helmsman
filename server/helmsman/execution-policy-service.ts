import { isContributionId } from '../../src/plugins/manifest';
import { parseExecutionPolicyCommandV1, parseExecutionPolicyQueryV1, parseExecutionPolicySnapshotV1, parseExecutionPolicyValueV1,
  type ExecutionPolicySnapshotV1, type ExecutionPolicyValueV1 } from '../../src/plugins/execution-policy';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { openExecutionPolicy } from './execution-policy';
import { executionMigrationReadiness } from './execution-schema';
import type { Persistence } from './persistence';

export interface ExecutionPolicyServerService {
  read(caller: string, input: unknown, scopeRepo: string | null): ExecutionPolicySnapshotV1;
  set(caller: string, input: unknown, scopeRepo: string | null): ExecutionPolicyValueV1;
}
export function createExecutionPolicyService(options: {
  persistence: Persistence; repos(): readonly string[]; authorize(caller: string): void; safetyReady(): boolean;
  limits(repo: string): ExecutionPolicySnapshotV1['limits'];
}): ExecutionPolicyServerService {
  const policy = openExecutionPolicy(options.persistence);
  function authorize(caller: string, repo: string, scope: string | null) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller);
    clarificationScope(options.repos().map(value => value.toLowerCase()), scope?.toLowerCase() ?? null, repo);
  }
  return Object.freeze<ExecutionPolicyServerService>({
    read(caller, raw, scopeRepo) {
      const input = parseExecutionPolicyQueryV1(raw); authorize(caller, input.repo, scopeRepo);
      if (!options.safetyReady()) throw new ClarificationServiceError(503, 'service-unavailable');
      return parseExecutionPolicySnapshotV1({ ...input, policy: policy.read(input.repo), limits: options.limits(input.repo), readiness: executionMigrationReadiness(options.persistence.sql) });
    },
    set(caller, raw, scopeRepo) {
      const input = parseExecutionPolicyCommandV1(raw); authorize(caller, input.repo, scopeRepo);
      if (!options.safetyReady()) throw new ClarificationServiceError(503, 'service-unavailable');
      const { version: _version, ...command } = input;
      return parseExecutionPolicyValueV1(policy.set({ ...command, caller }));
    },
  });
}
