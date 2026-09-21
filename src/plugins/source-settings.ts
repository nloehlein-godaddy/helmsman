import type { PluginJson, PluginSetting } from './backend';
import { invalidSourceContract, sourceFields, sourceInteger, sourceJson, sourceObject, sourceText } from './source-contract-validation';

export type SourceSettingSchemaV1 = PluginSetting
  | { readonly type: 'string-list'; readonly default: readonly string[]; readonly maxItems: number; readonly maxLength: number }
  | { readonly type: 'string-map'; readonly default: Readonly<Record<string, string>>; readonly maxItems: number; readonly maxLength: number };
export interface SourceSettingFieldV1 { readonly label: string; readonly schema: SourceSettingSchemaV1; }
export type SourceSettingFieldsV1 = Readonly<Record<string, SourceSettingFieldV1>>;

export function validateSourceSettingV1(schema: SourceSettingSchemaV1, input: unknown): PluginJson {
  const value = sourceJson(input, 64 * 1024);
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') invalidSourceContract(); }
  else if (schema.type === 'number') { if (typeof value !== 'number' || value < schema.minimum || value > schema.maximum) invalidSourceContract(); }
  else if (schema.type === 'string') { if (typeof value !== 'string' || value.length > schema.maxLength) invalidSourceContract(); }
  else {
    const items = schema.type === 'string-list' ? value : Object.entries(sourceObject(value)).flat();
    if (!Array.isArray(items) || items.length > schema.maxItems * (schema.type === 'string-map' ? 2 : 1)
      || items.some(item => typeof item !== 'string' || item.length > schema.maxLength)) invalidSourceContract();
  }
  return value;
}
export function parseSourceSettingFieldsV1(input: unknown): SourceSettingFieldsV1 {
  const fields = sourceObject(sourceJson(input)); const result: Record<string, SourceSettingFieldV1> = Object.create(null);
  if (Object.keys(fields).length > 64) invalidSourceContract();
  for (const [key, raw] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) invalidSourceContract();
    const field = sourceObject(raw); sourceFields(field, ['label', 'schema']); const schema = sourceObject(field.schema);
    if (typeof schema.type !== 'string' || !['number', 'boolean', 'string', 'string-list', 'string-map'].includes(schema.type)) invalidSourceContract();
    sourceFields(schema, ['type', 'default', ...(schema.type === 'number' ? ['minimum', 'maximum'] : schema.type === 'boolean' ? [] : schema.type === 'string' ? ['maxLength'] : ['maxLength', 'maxItems'])]);
    if (schema.type === 'number' && (typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number' || schema.minimum > schema.maximum)) invalidSourceContract();
    if (schema.type !== 'number' && schema.type !== 'boolean' && sourceInteger(schema.maxLength) > 16_384) invalidSourceContract();
    if ((schema.type === 'string-list' || schema.type === 'string-map') && sourceInteger(schema.maxItems) > 1000) invalidSourceContract();
    const parsed = schema as unknown as SourceSettingSchemaV1; validateSourceSettingV1(parsed, parsed.default);
    result[key] = Object.freeze({ label: sourceText(field.label, 120), schema: parsed });
  }
  return Object.freeze(result);
}
