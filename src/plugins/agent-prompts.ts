import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationJson, clarificationObject, clarificationText, clarificationVersion, invalidClarification } from './clarification-validation';

export const AGENT_PROMPT_LIMITS_V1: Readonly<{ textBytes: number; snapshotBytes: number; roles: number }> = Object.freeze({ textBytes: 4096, snapshotBytes: 2 * 1024 * 1024, roles: 32 });
export interface AgentPromptRoleV1 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly providerLabel: string;
  readonly defaultText: string;
  readonly text: string;
  readonly overridden: boolean;
}
export interface AgentPromptSettingsSnapshotV1 { readonly version: 1; readonly revision: string; readonly roles: readonly AgentPromptRoleV1[]; }
export interface AgentPromptSettingsSaveV1 { readonly version: 1; readonly expectedRevision: string; readonly roleId: string; readonly text: string | null; }
export interface AgentPromptSettingsServiceV1 {
  readonly version: 1;
  snapshot(signal?: AbortSignal): Promise<ClarificationReadResultV1<AgentPromptSettingsSnapshotV1>>;
  save(input: AgentPromptSettingsSaveV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<AgentPromptSettingsSnapshotV1>>;
}
function revision(value: unknown): string { if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) invalidClarification(); return value; }
function roleId(value: unknown): string { if (typeof value !== 'string' || !/^[a-z][a-z\d.-]{0,127}$/.test(value)) invalidClarification(); return value; }
function promptText(value: unknown): string {
  const text = clarificationText(value, AGENT_PROMPT_LIMITS_V1.textBytes);
  if (new TextEncoder().encode(text).byteLength > AGENT_PROMPT_LIMITS_V1.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) invalidClarification();
  return text;
}
export function parseAgentPromptSettingsSaveV1(input: unknown): AgentPromptSettingsSaveV1 {
  const value = clarificationVersion(clarificationJson(input, AGENT_PROMPT_LIMITS_V1.textBytes * 2 + 1024));
  clarificationFields(value, ['version', 'expectedRevision', 'roleId', 'text']);
  return { version: 1, expectedRevision: revision(value.expectedRevision), roleId: roleId(value.roleId), text: value.text === null ? null : promptText(value.text) };
}
export function parseAgentPromptSettingsSnapshotV1(input: unknown): AgentPromptSettingsSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, AGENT_PROMPT_LIMITS_V1.snapshotBytes));
  clarificationFields(value, ['version', 'revision', 'roles']);
  if (!Array.isArray(value.roles) || value.roles.length > AGENT_PROMPT_LIMITS_V1.roles) invalidClarification();
  const roles = value.roles.map(raw => {
    const role = clarificationObject(raw); clarificationFields(role, ['id', 'label', 'description', 'providerLabel', 'defaultText', 'text', 'overridden']);
    if (typeof role.overridden !== 'boolean') invalidClarification();
    const defaultText = promptText(role.defaultText); const text = promptText(role.text);
    if (!role.overridden && text !== defaultText) invalidClarification();
    return { id: roleId(role.id), label: clarificationText(role.label, 256), description: clarificationText(role.description, 1024), providerLabel: clarificationText(role.providerLabel, 256), defaultText, text, overridden: role.overridden };
  });
  if (new Set(roles.map(role => role.id)).size !== roles.length) invalidClarification();
  return { version: 1, revision: revision(value.revision), roles };
}
