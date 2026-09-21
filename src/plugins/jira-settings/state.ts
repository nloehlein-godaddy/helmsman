import type { JiraSettingsSnapshotV1 } from '@helmsman/plugin-sdk';
export const schema = {version:1,scope:'global',namespace:'helmsman.jira/settings',fields:{token:{label:'Jira API token',maxLength:8192,writeOnly:true,persistInBrowser:false}}} as const;
export function validSnapshot(value: unknown): value is JiraSettingsSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<JiraSettingsSnapshotV1>;
  return Object.keys(value).every(key => ['version','scope','namespace','revision','tokenSet','sourceConfigured','bootstrapEnabled'].includes(key)) && data.version === 1 && data.scope === 'global' && data.namespace === schema.namespace && typeof data.revision === 'string' && /^[a-f\d]{64}$/.test(data.revision) && typeof data.tokenSet === 'boolean' && typeof data.sourceConfigured === 'boolean' && typeof data.bootstrapEnabled === 'boolean';
}
