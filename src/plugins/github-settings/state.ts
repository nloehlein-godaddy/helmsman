import type { GithubSettingsSnapshotV1, GithubSettingsValuesV1 } from '@helmsman/plugin-sdk';
export const schema = {version:1,scope:'global',namespace:'helmsman.github/settings',fields:{defaultRepo:{label:'Default repository',maxLength:200},author:{label:'Pull request author',maxLength:100},reviewWatchEnabled:{label:'Watch GitHub review requests'}}} as const;
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
export function validValues(value: unknown): value is GithubSettingsValuesV1 { return object(value) && Object.keys(value).length === 3 && Object.keys(value).every(key => ['defaultRepo','author','reviewWatchEnabled'].includes(key)) && typeof value.defaultRepo === 'string' && value.defaultRepo.length <= schema.fields.defaultRepo.maxLength && typeof value.author === 'string' && value.author.length <= schema.fields.author.maxLength && typeof value.reviewWatchEnabled === 'boolean'; }
export function validSnapshot(value: unknown): value is GithubSettingsSnapshotV1 { return object(value) && Object.keys(value).every(key => ['version','scope','namespace','revision','values','tokenSet'].includes(key)) && value.version === 1 && value.scope === 'global' && value.namespace === schema.namespace && revision(value.revision) && validValues(value.values) && typeof value.tokenSet === 'boolean'; }
export interface Draft { version: 1; namespace: 'helmsman.github/settings'; revision: string; values: GithubSettingsValuesV1; }
export const fromSnapshot = (value: GithubSettingsSnapshotV1): Draft => ({version:1,namespace:schema.namespace,revision:value.revision,values:{...value.values}});
export function sameValues(a: GithubSettingsValuesV1, b: GithubSettingsValuesV1) { return a.defaultRepo === b.defaultRepo && a.author === b.author && a.reviewWatchEnabled === b.reviewWatchEnabled; }
export const normalized = (value: GithubSettingsValuesV1): GithubSettingsValuesV1 => ({defaultRepo:value.defaultRepo.trim(),author:value.author.trim(),reviewWatchEnabled:value.reviewWatchEnabled});
export function valuesReady(value: GithubSettingsValuesV1) {
  const next = normalized(value);
  return validValues(next)
    && (!next.defaultRepo || /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(next.defaultRepo) && !['.', '..'].includes(next.defaultRepo.split('/')[1]!))
    && (!next.author || /^[a-z\d][a-z\d-]*(?:\[bot\])?$/i.test(next.author));
}
export class DraftStorage {
  private readonly key: string;
  constructor(contribution: string | undefined, instance: string) { if (!contribution || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(contribution) || !instance) throw new Error('GitHub settings storage requires its mounted contribution and instance identity.'); this.key = `helmsman.github-settings.v1:${contribution}:${encodeURIComponent(instance)}:draft`; }
  read(): Draft | null { const raw = localStorage.getItem(this.key); if (raw === null) return null; if (raw.length > 8192) throw new Error('Saved GitHub settings draft is too large. Original data is kept.'); const value: unknown = JSON.parse(raw); if (!object(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['version','namespace','revision','values'].includes(key)) || value.version !== 1 || value.namespace !== schema.namespace || !revision(value.revision) || !validValues(value.values)) throw new Error('Saved GitHub settings draft uses an unsupported format. Original data is kept.'); return value as unknown as Draft; }
  save(value: Draft) { localStorage.setItem(this.key,JSON.stringify(value)); }
}
export const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
