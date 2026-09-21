import type { ClarificationReadResultV1 } from './clarification-read';

export interface JiraSettingsSnapshotV1 {
  readonly version: 1; readonly scope: 'global'; readonly namespace: 'helmsman.jira/settings'; readonly revision: string;
  readonly tokenSet: boolean; readonly sourceConfigured: boolean; readonly bootstrapEnabled: boolean;
}
export interface JiraSettingsRotateTokenInputV1 {
  readonly version: 1; readonly scope: 'global'; readonly namespace: 'helmsman.jira/settings'; readonly expectedRevision: string; readonly token: string;
}
export interface JiraSettingsServiceV1 {
  readonly version: 1;
  snapshot(input: { readonly version: 1; readonly scope: 'global' }, signal?: AbortSignal): Promise<ClarificationReadResultV1<JiraSettingsSnapshotV1>>;
  rotateToken(input: JiraSettingsRotateTokenInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<JiraSettingsSnapshotV1>>;
}
export const JIRA_SETTINGS_SCHEMA_V1: Readonly<{
  version: 1; scope: 'global'; namespace: 'helmsman.jira/settings';
  fields: Readonly<{ token: Readonly<{ type: 'string'; label: string; minLength: number; maxLength: number; writeOnly: true; persistInBrowser: false }> }>;
}> = Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.jira/settings', fields: Object.freeze({
  token: Object.freeze({ type: 'string', label: 'API token', minLength: 1, maxLength: 8192, writeOnly: true, persistInBrowser: false }),
}) });

import { clarificationBoolean, clarificationFields, clarificationJson, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
function revision(value: unknown): string { const parsed = sourceText(value, 64); if (!/^[a-f\d]{64}$/.test(parsed)) invalidClarification(); return parsed; }
export function parseJiraSettingsSnapshotInputV1(input: unknown): { readonly version: 1; readonly scope: 'global' } {
  const value = clarificationVersion(input); clarificationFields(value, ['version', 'scope']); if (value.scope !== 'global') invalidClarification(); return Object.freeze({ version: 1, scope: 'global' });
}
export function parseJiraSettingsRotateTokenInputV1(input: unknown): JiraSettingsRotateTokenInputV1 {
  const value = clarificationVersion(clarificationJson(input, 16_384)); clarificationFields(value, ['version', 'scope', 'namespace', 'expectedRevision', 'token']);
  if (value.scope !== 'global' || value.namespace !== 'helmsman.jira/settings') invalidClarification();
  const token = sourceText(value.token, 8192); if (/\s/.test(token)) invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.jira/settings', expectedRevision: revision(value.expectedRevision), token });
}
export function parseJiraSettingsSnapshotV1(input: unknown): JiraSettingsSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, 16_384)); clarificationFields(value, ['version', 'scope', 'namespace', 'revision', 'tokenSet', 'sourceConfigured', 'bootstrapEnabled']);
  if (value.scope !== 'global' || value.namespace !== 'helmsman.jira/settings') invalidClarification();
  return Object.freeze({ version: 1, scope: 'global', namespace: 'helmsman.jira/settings', revision: revision(value.revision), tokenSet: clarificationBoolean(value.tokenSet), sourceConfigured: clarificationBoolean(value.sourceConfigured), bootstrapEnabled: clarificationBoolean(value.bootstrapEnabled) });
}
