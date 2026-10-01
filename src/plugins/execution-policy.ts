import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationJson, clarificationObject, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export interface ExecutionPolicyQueryV1 { readonly version: 1; readonly repo: string; }
export interface ExecutionPolicyValueV1 { readonly version: 1; readonly repo: string; readonly revision: number; readonly maxConcurrentRuns: number; }
export interface ExecutionPolicyCommandV1 extends ExecutionPolicyQueryV1 { readonly requestId: string; readonly expectedRevision: number; readonly maxConcurrentRuns: number; }
export interface ExecutionPolicySnapshotV1 extends ExecutionPolicyQueryV1 {
  readonly policy: ExecutionPolicyValueV1;
  readonly limits: { readonly globalMaxConcurrentRuns: number; readonly perRunCostCapUsd: number | null; readonly activeRuns: number };
  readonly readiness: { readonly currentVersion: 1 | 2; readonly targetVersion: 2; readonly ready: boolean;
    readonly blockers: readonly { readonly source: 'execution-snapshot' | 'plugin-artifact'; readonly identity: string;
      readonly range: { readonly owner: string; readonly minimum: number; readonly maximum: number } }[] };
}
export interface ExecutionPolicyServiceV1 {
  readonly version: 1;
  read(input: ExecutionPolicyQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ExecutionPolicySnapshotV1>>;
  set(input: ExecutionPolicyCommandV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<ExecutionPolicyValueV1>>;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalidClarification(); return value;
}
export function parseExecutionPolicyQueryV1(input: unknown): ExecutionPolicyQueryV1 {
  const value = clarificationVersion(input); clarificationFields(value, ['version', 'repo']);
  return Object.freeze({ version: 1, repo: parseTaskRepo(value.repo).toLowerCase() });
}
export function parseExecutionPolicyValueV1(input: unknown): ExecutionPolicyValueV1 {
  const value = clarificationVersion(input); clarificationFields(value, ['version', 'repo', 'revision', 'maxConcurrentRuns']);
  return Object.freeze({ version: 1, repo: parseTaskRepo(value.repo).toLowerCase(), revision: integer(value.revision), maxConcurrentRuns: integer(value.maxConcurrentRuns, 1, 20) });
}
export function parseExecutionPolicyCommandV1(input: unknown): ExecutionPolicyCommandV1 {
  const value = clarificationVersion(clarificationJson(input, 8192)); clarificationFields(value, ['version', 'repo', 'requestId', 'expectedRevision', 'maxConcurrentRuns']);
  const requestId = sourceText(value.requestId, 128); if (!/^[a-z\d_-]+$/i.test(requestId)) invalidClarification();
  return Object.freeze({ version: 1, repo: parseTaskRepo(value.repo).toLowerCase(), requestId, expectedRevision: integer(value.expectedRevision), maxConcurrentRuns: integer(value.maxConcurrentRuns, 1, 20) });
}
export function parseExecutionPolicySnapshotV1(input: unknown): ExecutionPolicySnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, 262144)); clarificationFields(value, ['version', 'repo', 'policy', 'limits', 'readiness']);
  const repo = parseTaskRepo(value.repo).toLowerCase(); const policy = parseExecutionPolicyValueV1(value.policy); if (repo !== policy.repo) invalidClarification();
  const limits = clarificationObject(value.limits); clarificationFields(limits, ['globalMaxConcurrentRuns', 'perRunCostCapUsd', 'activeRuns']);
  if (limits.perRunCostCapUsd !== null && (typeof limits.perRunCostCapUsd !== 'number' || !Number.isFinite(limits.perRunCostCapUsd) || limits.perRunCostCapUsd < 0)) invalidClarification();
  const readiness = clarificationObject(value.readiness); clarificationFields(readiness, ['currentVersion', 'targetVersion', 'ready', 'blockers']);
  if (readiness.currentVersion !== 1 && readiness.currentVersion !== 2 || readiness.targetVersion !== 2 || typeof readiness.ready !== 'boolean' || !Array.isArray(readiness.blockers) || readiness.blockers.length > 1000) invalidClarification();
  const blockers = readiness.blockers.map(item => {
    const blocker = clarificationObject(item); clarificationFields(blocker, ['source', 'identity', 'range']);
    if (blocker.source !== 'execution-snapshot' && blocker.source !== 'plugin-artifact') invalidClarification();
    const range = clarificationObject(blocker.range); clarificationFields(range, ['owner', 'minimum', 'maximum']);
    const minimum = integer(range.minimum, 1); const maximum = integer(range.maximum, minimum);
    return Object.freeze({ source: blocker.source, identity: sourceText(blocker.identity, 512), range: Object.freeze({ owner: sourceText(range.owner, 128), minimum, maximum }) });
  });
  return Object.freeze({ version: 1, repo, policy, limits: Object.freeze({ globalMaxConcurrentRuns: integer(limits.globalMaxConcurrentRuns, 1), perRunCostCapUsd: limits.perRunCostCapUsd as number | null, activeRuns: integer(limits.activeRuns) }),
    readiness: Object.freeze({ currentVersion: readiness.currentVersion as 1 | 2, targetVersion: 2, ready: readiness.ready, blockers: Object.freeze(blockers) }) });
}
