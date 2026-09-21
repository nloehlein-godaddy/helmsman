import type { PluginJson } from './backend';

export class SourceContractValidationError extends Error {}
export function invalidSourceContract(): never { throw new SourceContractValidationError('Invalid source contract data'); }
export function sourceObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidSourceContract();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalidSourceContract();
  return input as Record<string, unknown>;
}
export function sourceFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalidSourceContract();
}
export function sourceText(input: unknown, maximum = 256): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\x00-\x1f\x7f]/.test(input)) invalidSourceContract();
  return input;
}
export function sourceInteger(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) invalidSourceContract(); return input;
}
export function sourceUuid(input: unknown): string {
  const value = sourceText(input, 36);
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) invalidSourceContract();
  return value.toLowerCase();
}
export function sourceJson(input: unknown, maximum: number = 256 * 1024): PluginJson {
  const visited = new Set<object>(); let nodes = 0;
  function copy(value: unknown, depth: number): PluginJson {
    if (++nodes > 16_384 || depth > 32) invalidSourceContract();
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || visited.has(value)) invalidSourceContract();
    visited.add(value);
    let result: PluginJson;
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) invalidSourceContract();
      result = Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) invalidSourceContract(); return copy(descriptor.value, depth + 1);
      }));
    } else {
      const object = sourceObject(value); const target: Record<string, PluginJson> = Object.create(null);
      for (const key of Object.keys(object).sort()) target[key] = copy(object[key], depth + 1);
      result = Object.freeze(target);
    }
    visited.delete(value); return result;
  }
  const value = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) invalidSourceContract();
  return value;
}


export function isContributionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [namespace, local, extra] = value.split('/');
  if (extra !== undefined || !namespace || namespace.length > 128 || !local || local.length > 64) return false;
  const parts = namespace.split('.');
  const valid = (part: string) => part.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(part);
  return parts.length > 1 && parts.every(valid) && valid(local);
}
