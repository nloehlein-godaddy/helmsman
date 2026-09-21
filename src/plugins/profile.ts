import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationJson, clarificationObject, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';

export interface ProfileIdentityV1 { readonly displayName: string | null; readonly login: string | null; }
export interface ProfileSnapshotV1 { readonly version: 1; readonly scope: 'global'; readonly profile: ProfileIdentityV1; }
export interface ProfileServiceV1 {
  readonly version: 1;
  snapshot(input: { readonly version: 1; readonly scope: 'global' }, signal?: AbortSignal): Promise<ClarificationReadResultV1<ProfileSnapshotV1>>;
}
export function parseProfileSnapshotInputV1(input: unknown): { readonly version: 1; readonly scope: 'global' } {
  const value = clarificationVersion(input); clarificationFields(value, ['version', 'scope']);
  if (value.scope !== 'global') invalidClarification();
  return Object.freeze({ version: 1, scope: 'global' });
}
export function parseProfileIdentityV1(input: unknown): ProfileIdentityV1 {
  const value = clarificationObject(clarificationJson(input, 4096)); clarificationFields(value, ['displayName', 'login']);
  return Object.freeze({ displayName: value.displayName === null ? null : sourceText(value.displayName, 256), login: value.login === null ? null : sourceText(value.login, 128) });
}
export function parseProfileSnapshotV1(input: unknown): ProfileSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, 4096)); clarificationFields(value, ['version', 'scope', 'profile']);
  if (value.scope !== 'global') invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', profile: parseProfileIdentityV1(value.profile) });
}
