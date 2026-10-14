import type { AgentPromptRoleV1, AgentPromptSettingsSnapshotV1 } from '@helmsman/plugin-sdk';
export const maximumTextLength = 4096;
export interface Draft { revision: string; text: string | null; }
export interface SavedDrafts { version: 1; selectedRole: string; drafts: Record<string, Draft>; }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
export const validRoleId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.length <= maximumTextLength && new TextEncoder().encode(value).length <= maximumTextLength && !value.includes('\0');
export const validText = (value: unknown): value is string => boundedText(value) && value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export function validSnapshot(value: unknown): value is AgentPromptSettingsSnapshotV1 {
  return object(value) && value.version === 1 && validRevision(value.revision) && Array.isArray(value.roles) && value.roles.length <= 32
    && value.roles.every(role => object(role) && validRoleId(role.id) && typeof role.label === 'string' && role.label.length <= 256 && typeof role.description === 'string' && role.description.length <= 1024 && typeof role.providerLabel === 'string' && role.providerLabel.length <= 256 && validText(role.defaultText) && validText(role.text) && typeof role.overridden === 'boolean' && (role.overridden || role.text === role.defaultText))
    && new Set(value.roles.map(role => role.id)).size === value.roles.length;
}
export const fromRole = (role: AgentPromptRoleV1, revision: string): Draft => ({ revision, text: role.overridden ? role.text : null });
export const sameDraft = (a: Draft, b: Draft) => a.revision === b.revision && a.text === b.text;
export const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
export class DraftStorage {
  private readonly key: string;
  constructor(contribution: string | undefined, instance: string) {
    if (!contribution || !instance) throw new Error('Agent prompt drafts require their mounted identity.');
    this.key = `helmsman.agent-prompts.v1:${contribution}:${encodeURIComponent(instance)}:draft`;
  }
  read(): SavedDrafts | null {
    const raw = localStorage.getItem(this.key); if (raw === null) return null;
    if (raw.length > 4 * 1024 * 1024) throw new Error('Saved prompt drafts are too large. Original data is kept.');
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || typeof value.selectedRole !== 'string' || value.selectedRole && !validRoleId(value.selectedRole) || !object(value.drafts) || Object.keys(value.drafts).length > 32
      || Object.keys(value).some(key => !['version', 'selectedRole', 'drafts'].includes(key))
      || Object.entries(value.drafts).some(([id, draft]) => !validRoleId(id) || !object(draft) || !validRevision(draft.revision) || draft.text !== null && (typeof draft.text !== 'string' || draft.text.length > maximumTextLength) || Object.keys(draft).some(key => !['revision', 'text'].includes(key)))) throw new Error('Saved prompt drafts use an unsupported format. Original data is kept.');
    return value as unknown as SavedDrafts;
  }
  save(value: SavedDrafts) { localStorage.setItem(this.key, JSON.stringify(value)); }
}
