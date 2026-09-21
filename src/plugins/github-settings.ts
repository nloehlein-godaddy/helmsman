import type { ClarificationReadResultV1 } from './clarification-read';

export interface GithubSettingsValuesV1 { readonly defaultRepo: string; readonly author: string; readonly reviewWatchEnabled: boolean; }
export interface GithubSettingsSnapshotV1 {
  readonly version: 1; readonly scope: 'global'; readonly namespace: 'helmsman.github/settings'; readonly revision: string;
  readonly values: GithubSettingsValuesV1; readonly tokenSet: boolean;
}
export interface GithubSettingsSaveInputV1 {
  readonly version: 1; readonly scope: 'global'; readonly namespace: 'helmsman.github/settings'; readonly expectedRevision: string; readonly values: GithubSettingsValuesV1;
}
export interface GithubSettingsServiceV1 {
  readonly version: 1;
  snapshot(input: { readonly version: 1; readonly scope: 'global' }, signal?: AbortSignal): Promise<ClarificationReadResultV1<GithubSettingsSnapshotV1>>;
  save(input: GithubSettingsSaveInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<GithubSettingsSnapshotV1>>;
}
export const GITHUB_SETTINGS_SCHEMA_V1: Readonly<{
  version: 1; scope: 'global'; namespace: 'helmsman.github/settings';
  fields: Readonly<{ defaultRepo: Readonly<{ type: 'string'; label: string; maxLength: number; default: string }>; author: Readonly<{ type: 'string'; label: string; maxLength: number; default: string }>; reviewWatchEnabled: Readonly<{ type: 'boolean'; label: string; default: boolean }> }>;
}> = Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.github/settings', fields: Object.freeze({
  defaultRepo: Object.freeze({ type: 'string', label: 'Default repository', maxLength: 200, default: '' }),
  author: Object.freeze({ type: 'string', label: 'Pull request author', maxLength: 100, default: '' }),
  reviewWatchEnabled: Object.freeze({ type: 'boolean', label: 'Watch review requests', default: false }),
}) });

import { clarificationBoolean, clarificationFields, clarificationJson, clarificationObject, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';
function revision(value: unknown): string { const parsed = sourceText(value, 64); if (!/^[a-f\d]{64}$/.test(parsed)) invalidClarification(); return parsed; }
export function parseGithubSettingsSnapshotInputV1(input: unknown): { readonly version: 1; readonly scope: 'global' } {
  const value = clarificationVersion(input); clarificationFields(value, ['version', 'scope']); if (value.scope !== 'global') invalidClarification(); return Object.freeze({ version: 1, scope: 'global' });
}
export function parseGithubSettingsValuesV1(input: unknown): GithubSettingsValuesV1 {
  const value = clarificationObject(input); clarificationFields(value, ['defaultRepo', 'author', 'reviewWatchEnabled']);
  const defaultRepo = value.defaultRepo === '' ? '' : parseTaskRepo(value.defaultRepo);
  const author = value.author === '' ? '' : sourceText(value.author, 100);
  if (author && !/^[a-z\d][a-z\d-]*(?:\[bot\])?$/i.test(author)) invalidClarification();
  return Object.freeze({ defaultRepo, author, reviewWatchEnabled: clarificationBoolean(value.reviewWatchEnabled) });
}
export function parseGithubSettingsSaveInputV1(input: unknown): GithubSettingsSaveInputV1 {
  const value = clarificationVersion(clarificationJson(input, 16_384)); clarificationFields(value, ['version', 'scope', 'namespace', 'expectedRevision', 'values']);
  if (value.scope !== 'global' || value.namespace !== 'helmsman.github/settings') invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.github/settings', expectedRevision: revision(value.expectedRevision), values: parseGithubSettingsValuesV1(value.values) });
}
export function parseGithubSettingsSnapshotV1(input: unknown): GithubSettingsSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, 16_384)); clarificationFields(value, ['version', 'scope', 'namespace', 'revision', 'values', 'tokenSet']);
  if (value.scope !== 'global' || value.namespace !== 'helmsman.github/settings') invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.github/settings', revision: revision(value.revision), values: parseGithubSettingsValuesV1(value.values), tokenSet: clarificationBoolean(value.tokenSet) });
}
