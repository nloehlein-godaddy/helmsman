import type { PanelOpaqueStateV1, PluginJson, SourceAdminSourceV1, SourceAdminTargetV1, SourceSettingSchemaV1, SourceAdminPendingV1 } from '@helmsman/plugin-sdk';

export interface ConfigValues { label: string; enabled: boolean; allowed: string; fields: Record<string, string | boolean>; }
export interface ConfigDraft { target: SourceAdminTargetV1; values: ConfigValues; baseline: ConfigValues; }
export interface ScheduleDraft { repo: string; revision: number; instances: string[]; baseline: string[]; }
export interface ReplacementDraft { target: SourceAdminTargetV1; candidate: string; actor: string; reason: string; }
export interface SavedState { selected: string | null; configurations: ConfigDraft[]; schedules: ScheduleDraft[]; replacements: ReplacementDraft[]; consumed: string[]; }
export const emptyState = (): SavedState => ({ selected: null, configurations: [], schedules: [], replacements: [], consumed: [] });
export const targetKey = (target: SourceAdminTargetV1) => JSON.stringify([target.sourceId, target.sourceRevision, target.instanceId, target.instanceRevision]);
export function sameTarget(left: SourceAdminTargetV1, right: SourceAdminTargetV1) { return targetKey(left) === targetKey(right); }
export function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) return null;
  return value as Record<string, unknown>;
}
const validRepo = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && /^[a-z\d_-][a-z\d_.-]*\/[a-z\d_-][a-z\d_.-]*$/i.test(value);
function target(value: unknown): SourceAdminTargetV1 | null {
  const input = record(value);
  if (!input || typeof input.sourceId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.sourceId)
    || typeof input.instanceId !== 'string' || !input.instanceId || input.instanceId.length > 160
    || !Number.isSafeInteger(input.sourceRevision) || Number(input.sourceRevision) < 1 || !Number.isSafeInteger(input.instanceRevision) || Number(input.instanceRevision) < 1) return null;
  return { sourceId: input.sourceId, sourceRevision: Number(input.sourceRevision), instanceId: input.instanceId, instanceRevision: Number(input.instanceRevision) };
}
function configValues(input: unknown): ConfigValues | null {
  const value = record(input); const fields = record(value?.fields);
  if (!value || !fields || typeof value.label !== 'string' || value.label.length > 240 || typeof value.enabled !== 'boolean' || typeof value.allowed !== 'string' || value.allowed.length > 128 * 1024
    || Object.keys(fields).length > 64 || Object.entries(fields).some(([key, item]) => key.length > 64 || typeof item !== 'boolean' && (typeof item !== 'string' || item.length > 64 * 1024))) return null;
  return { label: value.label, enabled: value.enabled, allowed: value.allowed, fields: { ...fields } as ConfigValues['fields'] };
}
export function readState(saved: PanelOpaqueStateV1 | null): SavedState | null {
  if (saved === null) return emptyState();
  try {
    if (saved.version !== 1 || new TextEncoder().encode(JSON.stringify(saved)).length > 512 * 1024) return null;
    const input = record(saved.value);
    if (!input || input.selected !== null && (typeof input.selected !== 'string' || input.selected.length > 160)
      || !Array.isArray(input.configurations) || input.configurations.length > 100 || !Array.isArray(input.schedules) || input.schedules.length > 1000
      || !Array.isArray(input.replacements) || input.replacements.length > 100 || !Array.isArray(input.consumed) || input.consumed.length > 1000
      || input.consumed.some(value => typeof value !== 'string' || value.length > 128)) return null;
    const configurations: ConfigDraft[] = []; const schedules: ScheduleDraft[] = []; const replacements: ReplacementDraft[] = [];
    for (const raw of input.configurations) {
      const value = record(raw); const identity = target(value?.target); const values = configValues(value?.values); const baseline = configValues(value?.baseline);
      if (!identity || !values || !baseline || configurations.some(draft => sameTarget(draft.target, identity))) return null;
      configurations.push({ target: identity, values, baseline });
    }
    for (const raw of input.schedules) {
      const value = record(raw);
      if (!value || !validRepo(value.repo) || schedules.some(draft => draft.repo === value.repo) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
        || !Array.isArray(value.instances) || !Array.isArray(value.baseline) || [value.instances, value.baseline].some(items => items.length > 32 || new Set(items).size !== items.length || items.some(id => typeof id !== 'string' || !id || id.length > 160))) return null;
      schedules.push({ repo: value.repo, revision: Number(value.revision), instances: value.instances as string[], baseline: value.baseline as string[] });
    }
    for (const raw of input.replacements) {
      const value = record(raw); const identity = target(value?.target);
      if (!value || !identity || replacements.some(draft => sameTarget(draft.target, identity)) || typeof value.candidate !== 'string' || value.candidate.length > 512
        || typeof value.actor !== 'string' || value.actor.length > 240 || typeof value.reason !== 'string' || value.reason.length > 2048) return null;
      replacements.push({ target: identity, candidate: value.candidate, actor: value.actor, reason: value.reason });
    }
    return { selected: input.selected as string | null, configurations, schedules, replacements, consumed: input.consumed as string[] };
  } catch { return null; }
}
export function saveValue(state: SavedState): PanelOpaqueStateV1 {
  const value = JSON.parse(JSON.stringify({ version: 1, value: state })) as PanelOpaqueStateV1;
  if (!readState(value)) throw new Error('Saved settings exceed their supported bounds. Your current text is kept.'); return value;
}
export function rawValues(source: Pick<SourceAdminSourceV1, 'label' | 'desiredEnabled' | 'allowedRepos' | 'settings'>): ConfigValues {
  return { label: source.label, enabled: source.desiredEnabled, allowed: source.allowedRepos.join('\n'), fields: Object.fromEntries(Object.entries(source.settings).map(([key, value]) =>
    [key, typeof value === 'boolean' ? value : typeof value === 'string' ? value : JSON.stringify(value, null, 2)])) };
}
function setting(schema: SourceSettingSchemaV1, raw: string | boolean | undefined): PluginJson {
  if (schema.type === 'boolean') { if (typeof raw !== 'boolean') throw new Error('Choose a boolean value.'); return raw; }
  if (typeof raw !== 'string') throw new Error('Enter a value.');
  if (schema.type === 'string') { if (raw.length > schema.maxLength) throw new Error(`Use at most ${schema.maxLength} characters.`); return raw; }
  if (schema.type === 'number') {
    const value = Number(raw); if (!raw.trim() || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) throw new Error(`Enter a number from ${schema.minimum} to ${schema.maximum}.`); return value;
  }
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(schema.type === 'string-list' ? 'Enter a JSON list of text values.' : 'Enter a JSON object with text values.'); }
  if (schema.type === 'string-list') {
    if (!Array.isArray(parsed) || parsed.length > schema.maxItems || parsed.some(value => typeof value !== 'string' || value.length > schema.maxLength)) throw new Error(`Use at most ${schema.maxItems} text values of ${schema.maxLength} characters each.`);
    return parsed as string[];
  }
  const object = record(parsed);
  if (!object || Object.keys(object).length > schema.maxItems || Object.entries(object).some(([key, value]) => key.length > schema.maxLength || typeof value !== 'string' || value.length > schema.maxLength)) throw new Error(`Use at most ${schema.maxItems} text entries of ${schema.maxLength} characters each.`);
  return object as Record<string, string>;
}
export function configuration(draft: ConfigDraft, source: SourceAdminSourceV1) {
  if (!sameTarget(draft.target, source.target)) throw new Error('The source revision changed. Reconcile the saved draft before applying it.');
  const label = draft.values.label.trim(); if (!label) throw new Error('Enter a source label.');
  const allowedRepos = [...new Set(draft.values.allowed.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  if (allowedRepos.length > 1000 || allowedRepos.some(repo => !validRepo(repo))) throw new Error('Enter allowed galleons as owner/project, one per line.');
  if (Object.keys(draft.values.fields).some(key => !Object.hasOwn(source.settingsFields, key))) throw new Error('The source settings schema changed. Reconcile this draft.');
  const settings: Record<string, PluginJson> = Object.create(null);
  for (const key of Object.keys(draft.values.fields)) {
    const field = source.settingsFields[key]; if (!field) throw new Error('The source settings schema changed. Reconcile this draft.');
    try { settings[key] = setting(field.schema, draft.values.fields[key]); } catch (error) { throw new Error(`${field.label}: ${error instanceof Error ? error.message : 'Invalid value'}`); }
  }
  return { label, desiredEnabled: draft.values.enabled, allowedRepos, settings };
}
export function consumeResult(state: SavedState, entry: SourceAdminPendingV1): SavedState {
  const receipt = entry.receipt; if (!receipt || state.consumed.includes(entry.command.requestId)) return state;
  const result = receipt.result; const input = receipt.input;
  return { ...state, consumed: [...state.consumed, entry.command.requestId],
    configurations: state.configurations.map(draft => input.kind === 'configure' && result?.kind === 'configured' && sameTarget(draft.target, input.target)
      ? { ...draft, target: result.target, baseline: rawValues({ label: input.changes.label, desiredEnabled: input.changes.desiredEnabled, allowedRepos: input.changes.allowedRepos, settings: input.changes.settings }) } : draft),
    schedules: state.schedules.map(draft => input.kind === 'schedule' && result?.kind === 'scheduled' && draft.repo === input.repo && draft.revision === input.expectedRevision
      ? { ...draft, revision: result.schedule.revision, baseline: [...result.schedule.instanceIds] } : draft) };
}
