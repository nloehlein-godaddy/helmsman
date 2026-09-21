import { invalidSourceContract, sourceInteger, sourceObject, sourceText } from './source-contract-validation';

export { sourceFields as clarificationFields, sourceObject as clarificationObject, sourceJson as clarificationJson } from './source-contract-validation';
export function invalidClarification(): never { return invalidSourceContract(); }
export function clarificationId(value: unknown): string {
  const id = sourceText(value, 128); if (!/^[a-z\d_-]{1,128}$/i.test(id)) invalidClarification(); return id;
}
export function clarificationUuid(value: unknown): string {
  const id = sourceText(value, 36); if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(id)) invalidClarification(); return id;
}
export function clarificationInteger(value: unknown, maximum: number = Number.MAX_SAFE_INTEGER): number {
  const number = sourceInteger(value); if (number > maximum) invalidClarification(); return number;
}
export function clarificationText(value: unknown, maximum: number, canonical = false): string {
  if (typeof value !== 'string') invalidClarification();
  const text = canonical ? value.trim() : value;
  if (!text.trim() || text.length > maximum) invalidClarification(); return text;
}
export function clarificationTime(value: unknown): string {
  const time = sourceText(value, 64); if (!Number.isFinite(Date.parse(time))) invalidClarification(); return time;
}
export function clarificationBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidClarification(); return value;
}
export function clarificationCursor(value: unknown): string | null { return value === null ? null : sourceText(value, 4096); }
export function clarificationArray<T>(value: unknown, parse: (value: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) invalidClarification(); return Object.freeze(Array.from(value, parse));
}
export function clarificationVersion(value: unknown): Record<string, unknown> {
  const record = sourceObject(value); if (record.version !== 1) invalidClarification(); return record;
}
