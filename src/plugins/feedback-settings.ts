import type { PluginJson, PluginSetting } from './backend';
import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields, clarificationJson, clarificationObject, clarificationText, clarificationVersion, invalidClarification } from './clarification-validation';
const isContributionId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9_-]*$/.test(value);

export interface FeedbackSettingsProviderV1 { readonly id: string; readonly label: string; readonly fields: Readonly<Record<string, PluginSetting>>; readonly values: Readonly<Record<string, PluginJson>>; }
export interface FeedbackSettingsSnapshotV1 { readonly version: 1; readonly revision: string; readonly selected: string | null; readonly providers: readonly FeedbackSettingsProviderV1[]; }
export interface FeedbackSettingsSaveV1 { readonly version: 1; readonly expectedRevision: string; readonly selected: string | null; readonly values: Readonly<Record<string, PluginJson>>; }
export interface FeedbackSettingsServiceV1 {
  readonly version: 1;
  snapshot(signal?: AbortSignal): Promise<ClarificationReadResultV1<FeedbackSettingsSnapshotV1>>;
  save(input: FeedbackSettingsSaveV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<FeedbackSettingsSnapshotV1>>;
}
function revision(value: unknown): string { if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) invalidClarification(); return value; }
function selected(value: unknown): string | null { if (value !== null && !isContributionId(value)) invalidClarification(); return value as string | null; }
export function parseFeedbackSettingsSaveV1(input: unknown): FeedbackSettingsSaveV1 {
  const value = clarificationVersion(clarificationJson(input, 64 * 1024)); clarificationFields(value, ['version', 'expectedRevision', 'selected', 'values']);
  return { version: 1, expectedRevision: revision(value.expectedRevision), selected: selected(value.selected), values: clarificationObject(value.values) as Readonly<Record<string, PluginJson>> };
}
export function parseFeedbackSettingsSnapshotV1(input: unknown): FeedbackSettingsSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, 256 * 1024)); clarificationFields(value, ['version', 'revision', 'selected', 'providers']);
  if (!Array.isArray(value.providers) || value.providers.length > 128) invalidClarification();
  const providers = value.providers.map(raw => {
    const provider = clarificationObject(raw); clarificationFields(provider, ['id', 'label', 'fields', 'values']);
    const id = selected(provider.id); if (!id) invalidClarification();
    const fields = clarificationObject(provider.fields); const values = clarificationObject(provider.values);
    if (Object.keys(fields).length > 64 || Object.keys(values).length !== Object.keys(fields).length) invalidClarification();
    for (const [key, raw] of Object.entries(fields)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(key)) invalidClarification();
      const field = clarificationObject(raw);
      if (field.type === 'string') { clarificationFields(field, ['type', 'default', 'maxLength']); if (!Number.isSafeInteger(field.maxLength) || Number(field.maxLength) < 0 || Number(field.maxLength) > 64 * 1024 || typeof field.default !== 'string' || field.default.length > Number(field.maxLength) || typeof values[key] !== 'string' || String(values[key]).length > Number(field.maxLength)) invalidClarification(); }
      else if (field.type === 'boolean') { clarificationFields(field, ['type', 'default']); if (typeof field.default !== 'boolean' || typeof values[key] !== 'boolean') invalidClarification(); }
      else if (field.type === 'number') { clarificationFields(field, ['type', 'default', 'minimum', 'maximum']); if ([field.default, field.minimum, field.maximum, values[key]].some(item => typeof item !== 'number' || !Number.isFinite(item)) || Number(field.minimum) > Number(field.maximum) || Number(values[key]) < Number(field.minimum) || Number(values[key]) > Number(field.maximum)) invalidClarification(); }
      else invalidClarification();
    }
    return { id, label: clarificationText(provider.label, 256), fields: fields as unknown as Readonly<Record<string, PluginSetting>>, values: values as Readonly<Record<string, PluginJson>> };
  });
  if (new Set(providers.map(item => item.id)).size !== providers.length) invalidClarification();
  return { version: 1, revision: revision(value.revision), selected: selected(value.selected), providers };
}
