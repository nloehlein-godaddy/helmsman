import { apiFetch } from './api-client';
export interface TaskSourceView {
  id: string;
  sourceId: string;
  label: string;
  revision: number;
  desiredEnabled: boolean;
  available: boolean;
  identityLevel: string;
  commands: string[];
  providerId: string;
  allowedRepos: string[];
  settings: Record<string, unknown>;
}
export interface SourceScheduleView { repo: string; instanceIds: string[]; revision: number }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await apiFetch(path, { signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(object(value) && typeof value.error === 'string' ? value.error : 'Task source request failed. Reload and retry.');
  return value;
}
export async function getTaskSources(repo: string | null): Promise<TaskSourceView[]> {
  const value = await request(`/api/task-sources${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
  if (!object(value) || !Array.isArray(value.instances) || !value.instances.every(item => object(item)
    && ['id', 'sourceId', 'label', 'identityLevel', 'providerId'].every(key => typeof item[key] === 'string')
    && Number.isSafeInteger(item.revision) && (item.revision as number) > 0 && typeof item.desiredEnabled === 'boolean'
    && typeof item.available === 'boolean' && strings(item.commands) && strings(item.allowedRepos) && object(item.settings))) throw new Error('Task sources returned an invalid response.');
  return value.instances as TaskSourceView[];
}
export async function getSourceSchedule(repo: string): Promise<SourceScheduleView> {
  const value = await request(`/api/task-sources/schedule?repo=${encodeURIComponent(repo)}`);
  if (!object(value) || value.repo !== repo || !strings(value.instanceIds) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error('Automatic source selection returned an invalid response.');
  return value as unknown as SourceScheduleView;
}
export async function configureTaskSource(source: TaskSourceView, changes: { label: string; desiredEnabled: boolean; allowedRepos: string[]; settings: Record<string, unknown> }): Promise<void> {
  const value = await request(`/api/task-sources/${encodeURIComponent(source.id)}/configuration`, { instanceRevision: source.revision, ...changes });
  const instance = object(value) && object(value.instance) ? value.instance : null;
  if (instance?.id !== source.id || instance.revision !== source.revision + 1 || instance.desiredEnabled !== changes.desiredEnabled) throw new Error('Unable to confirm the source configuration. Your draft is kept.');
}
export async function configureSourceSchedule(schedule: SourceScheduleView, instanceIds: string[]): Promise<void> {
  const value = await request(`/api/task-sources/schedule?repo=${encodeURIComponent(schedule.repo)}`, { instanceIds, revision: schedule.revision });
  if (!object(value) || value.repo !== schedule.repo || value.revision !== schedule.revision + 1 || !strings(value.instanceIds)
    || value.instanceIds.length !== instanceIds.length || new Set(value.instanceIds).size !== instanceIds.length || !value.instanceIds.every(id => instanceIds.includes(id))) throw new Error('Unable to confirm automatic source selection. Your selection is kept.');
}

export type SourceReplacementMode = 'adoption' | 'refresh';
export interface SourceAdoptionOptions { sourceId: string; sourceRevision: number; currentInstanceId: string; candidates: { providerId: string; artifactHash: string }[] }
export interface SourceAdoptionReceipt { validationId: string; sourceId: string; instanceId: string; evidenceHash: string }
export async function getSourceAdoption(sourceId: string, mode: SourceReplacementMode = 'adoption'): Promise<SourceAdoptionOptions> {
  const value = await request(`/api/task-sources/${mode}?sourceId=${encodeURIComponent(sourceId)}`);
  if (!object(value) || value.sourceId !== sourceId || typeof value.currentInstanceId !== 'string' || !Number.isSafeInteger(value.sourceRevision)
    || !Array.isArray(value.candidates) || !value.candidates.every(item => object(item) && typeof item.providerId === 'string' && typeof item.artifactHash === 'string')) throw new Error('Source adoption options returned an invalid response.');
  return value as unknown as SourceAdoptionOptions;
}
export async function validateSourceAdoption(input: { sourceId: string; sourceRevision: number; providerId: string; artifactHash: string; repo: string; actor: string; reason: string }, mode: SourceReplacementMode = 'adoption'): Promise<SourceAdoptionReceipt> {
  const value = await request(`/api/task-sources/${mode}/validate`, input);
  if (!object(value) || value.sourceId !== input.sourceId || !['validationId', 'instanceId', 'evidenceHash'].every(key => typeof value[key] === 'string' && Boolean(value[key]))) throw new Error('Source adoption validation returned an invalid response.');
  return value as unknown as SourceAdoptionReceipt;
}
export async function commitSourceAdoption(receipt: SourceAdoptionReceipt, mode: SourceReplacementMode = 'adoption'): Promise<void> {
  const value = await request(`/api/task-sources/${mode}/commit`, { validationId: receipt.validationId });
  if (!object(value) || value.sourceId !== receipt.sourceId || value.currentInstanceId !== receipt.instanceId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Unable to confirm adoption. Retry the validated replacement.');
}
