import type { WorkRefV1 } from './tasks';
import { sourceFields, sourceInteger, sourceObject, sourceText } from './source-contract-validation';

export interface SchedulingSourceV1 { readonly instanceId: string; readonly sourceId: string; readonly label: string; }
export interface SchedulingCandidateV1 {
  readonly candidateId: string; readonly ref: WorkRefV1; readonly revision: string;
  readonly displayKey: string; readonly title: string; readonly priority: number | null;
}
export interface SchedulingPageV1 { readonly items: readonly SchedulingCandidateV1[]; readonly nextCursor: string | null; }
export interface SchedulingInputV1 {
  readonly version: 1; readonly repo: string; readonly sources: readonly SchedulingSourceV1[]; readonly lastInstanceId: string | null;
}
export interface SchedulingDiscoveryInputV1 { readonly instanceId: string; readonly cursor: string | null; readonly limit: number; }
export interface SchedulingContextV1 {
  readonly signal: AbortSignal;
  list(input: SchedulingDiscoveryInputV1): Promise<SchedulingPageV1>;
}
export interface SchedulingChoiceV1 { readonly candidateId: string; }
export interface SchedulingProviderV1 {
  readonly intervalMs: number;
  select(input: SchedulingInputV1, context: SchedulingContextV1): Promise<SchedulingChoiceV1 | null>;
}
export interface SchedulingDeclaration { readonly access: readonly ['task-discovery']; }

export function parseSchedulingDiscoveryInputV1(input: unknown): SchedulingDiscoveryInputV1 {
  const value = sourceObject(input); sourceFields(value, ['instanceId', 'cursor', 'limit']);
  const limit = sourceInteger(value.limit);
  if (limit > 100) throw new TypeError('Scheduling page limit exceeds 100');
  return Object.freeze({ instanceId: sourceText(value.instanceId, 160), cursor: value.cursor === null ? null : sourceText(value.cursor, 128), limit });
}
export function parseSchedulingChoiceV1(input: unknown): SchedulingChoiceV1 | null {
  if (input === null) return null;
  const value = sourceObject(input); sourceFields(value, ['candidateId']);
  return Object.freeze({ candidateId: sourceText(value.candidateId, 128) });
}
