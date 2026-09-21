export function invalidClarification(): never { throw new Error('Invalid saved clarification data'); }
export function clarificationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidClarification();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalidClarification();
  return value as Record<string, unknown>;
}
export function clarificationFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) invalidClarification();
}
export function clarificationBoolean(value: unknown): boolean { if (typeof value !== 'boolean') invalidClarification(); return value; }
export function clarificationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value)) invalidClarification(); return value;
}
export function clarificationUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value)) invalidClarification(); return value;
}
export function parseRepo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) || ['.', '..'].includes(value.split('/')[1] ?? '')) invalidClarification(); return value;
}
export function contributionIdentity(value: unknown): string {
  const parts = typeof value === 'string' ? value.split('/') : [];
  const namespace = parts[0]?.split('.') ?? [];
  const local = (part: string) => part.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(part);
  if (typeof value !== 'string' || parts.length !== 2 || (parts[0]?.length ?? 0) > 128 || namespace.length < 2 || !namespace.every(local) || !local(parts[1] ?? '')) throw new Error('Clarification recovery requires its contribution identity.');
  return value;
}
