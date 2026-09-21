import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1, type TaskReadResultV1 } from './task-read';

export type ActivityReadQualityV1 = 'complete' | 'partial' | 'unavailable';
export interface TaskHistoryQueryV1 { readonly repo: string; readonly from: string; readonly until: string; readonly eventLimit: number; }
export interface TaskHistoryEventV1 {
  readonly id: string; readonly ref: WorkRefV1; readonly displayKey: string; readonly title: string;
  readonly url: string | null; readonly at: string; readonly kind: 'created' | 'updated' | 'completed' | 'status-changed'; readonly status: string | null;
}
export interface TaskHistoryV1 {
  readonly version: 1; readonly repo: string; readonly from: string; readonly until: string;
  readonly events: readonly TaskHistoryEventV1[]; readonly historyQuality: ActivityReadQualityV1;
  /** Current Done tasks grouped by their retained completion date; reopened/deleted tasks are excluded. */
  readonly days: readonly { readonly date: string; readonly completed: number | null }[]; readonly throughputQuality: ActivityReadQualityV1;
}
export interface ActivityReadSnapshotV1 { readonly selection: TaskReadSelectionV1; readonly history: TaskHistoryV1; }
export interface ActivityReadServiceV1 {
  readonly version: 1;
  query(selection: TaskReadSelectionV1, signal?: AbortSignal): Promise<TaskReadResultV1<ActivityReadSnapshotV1>>;
}
export const ACTIVITY_READ_LIMITS: Readonly<{ events: number; responseBytes: number }> = Object.freeze({ events: 50, responseBytes: 256 * 1024 });
export class ActivityReadValidationError extends Error {}
const dayMs = 86_400_000;
function invalid(): never { throw new ActivityReadValidationError('Invalid activity read data'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value;
}
function date(value: unknown): string {
  const input = text(value, 64); const stamp = Date.parse(input);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== input) invalid(); return input;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const key of Reflect.ownKeys(value)) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
  return Array.from({ length: value.length }, (_, index) => { const descriptor = Object.getOwnPropertyDescriptor(value, index); if (!descriptor || !('value' in descriptor)) invalid(); return descriptor.value as unknown; });
}
function url(value: unknown): string | null {
  if (value === null) return null;
  const input = text(value, 2048); let parsed: URL; try { parsed = new URL(input); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(); return input;
}
function quality(value: unknown): ActivityReadQualityV1 { if (!['complete', 'partial', 'unavailable'].includes(value as string)) invalid(); return value as ActivityReadQualityV1; }
export function activityReadWindow(now: Date): { readonly from: string; readonly until: string } {
  const until = date(now.toISOString());
  return Object.freeze({ from: new Date(Date.parse(`${until.slice(0, 10)}T00:00:00.000Z`) - 6 * dayMs).toISOString(), until });
}
export function parseTaskHistoryQueryV1(input: unknown): TaskHistoryQueryV1 {
  const value = record(input); const from = date(value.from); const until = date(value.until);
  if (from !== activityReadWindow(new Date(until)).from || typeof value.eventLimit !== 'number' || !Number.isSafeInteger(value.eventLimit)
    || value.eventLimit < 1 || value.eventLimit > ACTIVITY_READ_LIMITS.events) invalid();
  return Object.freeze({ repo: parseTaskRepo(value.repo), from, until, eventLimit: value.eventLimit });
}
export function parseTaskHistoryV1(input: unknown, query: TaskHistoryQueryV1, sourceId: string): TaskHistoryV1 {
  query = parseTaskHistoryQueryV1(query); const value = record(input);
  if (value.version !== 1 || value.repo !== query.repo || value.from !== query.from || value.until !== query.until) invalid();
  const historyQuality = quality(value.historyQuality); const throughputQuality = quality(value.throughputQuality);
  const events = array(value.events, query.eventLimit).map(raw => {
    const event = record(raw); const ref = parseWorkRefV1(event.ref); const at = date(event.at);
    if (ref.sourceId !== sourceId || at < query.from || at > query.until || !['created', 'updated', 'completed', 'status-changed'].includes(event.kind as string)
      || event.kind === 'status-changed' && event.status === null || event.kind !== 'status-changed' && event.status !== null) invalid();
    return Object.freeze({ id: text(event.id, 256), ref: Object.freeze(ref), displayKey: text(event.displayKey, 512), title: text(event.title, 2048), url: url(event.url), at,
      kind: event.kind as TaskHistoryEventV1['kind'], status: event.status === null ? null : text(event.status, 240) });
  });
  if (new Set(events.map(event => JSON.stringify([event.ref.externalId, event.id]))).size !== events.length
    || events.some((event, index) => index > 0 && event.at > events[index - 1]!.at) || historyQuality === 'unavailable' && events.length > 0) invalid();
  const days = array(value.days, 7).map((raw, index) => {
    const day = record(raw); const expected = new Date(Date.parse(query.from) + index * dayMs).toISOString().slice(0, 10);
    if (day.date !== expected || throughputQuality === 'complete' && (typeof day.completed !== 'number' || !Number.isSafeInteger(day.completed) || day.completed < 0)
      || throughputQuality !== 'complete' && day.completed !== null) invalid();
    return Object.freeze({ date: expected, completed: day.completed as number | null });
  });
  if (days.length !== 7) invalid();
  return Object.freeze({ version: 1, repo: query.repo, from: query.from, until: query.until, events: Object.freeze(events), historyQuality, days: Object.freeze(days), throughputQuality });
}
export function parseActivityReadSnapshotV1(input: unknown, selection: TaskReadSelectionV1): ActivityReadSnapshotV1 {
  selection = parseTaskReadSelectionV1(selection); const value = record(input); const actual = parseTaskReadSelectionV1(value.selection);
  if (JSON.stringify(actual) !== JSON.stringify(selection)) invalid();
  const history = record(value.history); const query = parseTaskHistoryQueryV1({ repo: selection.repo, from: history.from, until: history.until, eventLimit: ACTIVITY_READ_LIMITS.events });
  return Object.freeze({ selection, history: parseTaskHistoryV1(history, query, selection.sourceId) });
}
