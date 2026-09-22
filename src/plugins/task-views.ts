import { parseTaskRepo, parseWorkRefV1, type WorkRefV1, type TaskSnapshotV1 } from './tasks';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1, type TaskReadResultV1 } from './task-read';

export type TaskViewQualityV1 = 'complete' | 'partial' | 'unavailable';
export type TaskTriageGroupV1 = 'unassigned-backlog' | 'unassigned-todo' | 'mine-open';
export interface TaskTriageQueryV1 {
  readonly repo: string; readonly group: TaskTriageGroupV1; readonly priorities: readonly number[];
  readonly updatedSince: string | null; readonly until: string; readonly cursor: string | null; readonly limit: number;
}
export interface TaskTriageItemV1 {
  readonly ref: WorkRefV1; readonly revision: string; readonly displayKey: string; readonly title: string;
  readonly url: string | null; readonly state: TaskSnapshotV1['state']; readonly priority: number; readonly updatedAt: string;
}
export interface TaskTriagePageV1 {
  readonly version: 1; readonly repo: string; readonly group: TaskTriageGroupV1;
  readonly items: readonly TaskTriageItemV1[]; readonly nextCursor: string | null; readonly quality: TaskViewQualityV1;
}
export interface TaskBugsQueryV1 { readonly repo: string; readonly asOf: string; readonly rowLimit: number; }
export interface TaskBugCountV1 { readonly value: number | null; readonly quality: 'exact' | 'approximate' | 'unavailable'; }
export interface TaskBugRowV1 {
  readonly ref: WorkRefV1; readonly displayKey: string; readonly title: string; readonly url: string | null;
  readonly priority: string | null; readonly severity: string | null; readonly dueAt: string | null; readonly createdAt: string;
  readonly description?: string;
}
export interface TaskBugsReportV1 {
  readonly version: 1; readonly repo: string; readonly asOf: string;
  readonly open: TaskBugCountV1; readonly createdLast7d: TaskBugCountV1; readonly completedLast7d: TaskBugCountV1; readonly pastSla: TaskBugCountV1;
  readonly rows: readonly TaskBugRowV1[]; readonly rowsQuality: TaskViewQualityV1;
  readonly oldest: { readonly ref: WorkRefV1; readonly displayKey: string; readonly url: string | null; readonly createdAt: string } | null;
  readonly oldestQuality: TaskViewQualityV1;
  readonly resolutionP75: { readonly days: number | null; readonly sampleSize: number; readonly population: TaskBugCountV1;
    readonly quality: TaskViewQualityV1; readonly capped: boolean };
}
export type TaskTriageReadQueryV1 = TaskReadSelectionV1 & Omit<TaskTriageQueryV1, 'repo'>;
export interface TaskTriageReadSnapshotV1 {
  readonly selection: TaskReadSelectionV1; readonly query: TaskTriageQueryV1; readonly page: TaskTriagePageV1;
  readonly relatedRuns: readonly { readonly ref: WorkRefV1; readonly repo: string; readonly runId: string }[];
  readonly relatedRunsQuality: TaskViewQualityV1;
}
export interface TaskBugsReadSnapshotV1 { readonly selection: TaskReadSelectionV1; readonly report: TaskBugsReportV1; }
export interface TaskViewsReadServiceV1 {
  readonly version: 1;
  triage(input: TaskTriageReadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskTriageReadSnapshotV1>>;
  bugs(selection: TaskReadSelectionV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskBugsReadSnapshotV1>>;
}
export const TASK_VIEW_LIMITS: Readonly<{ items: number; responseBytes: number; cursorLength: number }> = Object.freeze({ items: 100, responseBytes: 256 * 1024, cursorLength: 8192 });
export class TaskViewValidationError extends Error {}
function invalid(): never { throw new TaskViewValidationError('Invalid task view data'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value;
}
function timestamp(value: unknown): string {
  const date = text(value, 64); const time = Date.parse(date);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== date) invalid(); return date;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const key of Reflect.ownKeys(value)) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index); if (!descriptor || !('value' in descriptor)) invalid(); return descriptor.value as unknown;
  });
}
function url(value: unknown): string | null {
  if (value === null) return null;
  const link = text(value, 2048); let parsed: URL; try { parsed = new URL(link); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(); return link;
}
function reference(value: unknown, sourceId: string): WorkRefV1 {
  const ref = parseWorkRefV1(value); if (ref.sourceId !== sourceId) invalid(); return Object.freeze(ref);
}
function quality(value: unknown): TaskViewQualityV1 {
  if (!['complete', 'partial', 'unavailable'].includes(value as string)) invalid(); return value as TaskViewQualityV1;
}
function group(value: unknown): TaskTriageGroupV1 {
  if (!['unassigned-backlog', 'unassigned-todo', 'mine-open'].includes(value as string)) invalid(); return value as TaskTriageGroupV1;
}
function cursor(value: unknown): string | null { return value === null ? null : text(value, TASK_VIEW_LIMITS.cursorLength); }
function description(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 32 * 1024 || /[\x00\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TASK_VIEW_LIMITS.responseBytes) invalid(); return value;
}
export function parseTaskTriageQueryV1(input: unknown): TaskTriageQueryV1 {
  const value = record(input); const priorities = array(value.priorities, 5).map(item => integer(item, 0, 4));
  const updatedSince = value.updatedSince === null ? null : timestamp(value.updatedSince); const until = timestamp(value.until);
  if (new Set(priorities).size !== priorities.length || updatedSince !== null && updatedSince > until) invalid();
  return Object.freeze({ repo: parseTaskRepo(value.repo), group: group(value.group), priorities: Object.freeze(priorities.sort()), updatedSince, until,
    cursor: cursor(value.cursor), limit: integer(value.limit, 1, TASK_VIEW_LIMITS.items) });
}
export function parseTaskTriagePageV1(input: unknown, query: TaskTriageQueryV1, sourceId: string): TaskTriagePageV1 {
  query = parseTaskTriageQueryV1(query); const value = record(input);
  if (value.version !== 1 || value.repo !== query.repo || value.group !== query.group) invalid();
  const coverage = quality(value.quality); const nextCursor = cursor(value.nextCursor);
  const items = array(value.items, query.limit).map(raw => {
    const item = record(raw); const updatedAt = timestamp(item.updatedAt); const priority = integer(item.priority, 0, 4);
    if (!['ready', 'in_progress', 'review', 'done', 'blocked'].includes(item.state as string) || !query.priorities.includes(priority)
      || updatedAt > query.until || query.updatedSince !== null && updatedAt < query.updatedSince) invalid();
    return Object.freeze({ ref: reference(item.ref, sourceId), revision: text(item.revision, 512), displayKey: text(item.displayKey, 512), title: text(item.title, 2048),
      url: url(item.url), state: item.state as TaskSnapshotV1['state'], priority, updatedAt });
  });
  if (new Set(items.map(item => item.ref.externalId)).size !== items.length || nextCursor !== null && nextCursor === query.cursor
    || coverage === 'unavailable' && (items.length > 0 || nextCursor !== null)) invalid();
  return bounded(Object.freeze({ version: 1, repo: query.repo, group: query.group, items: Object.freeze(items), nextCursor, quality: coverage }));
}
export function parseTaskBugsQueryV1(input: unknown): TaskBugsQueryV1 {
  const value = record(input); return Object.freeze({ repo: parseTaskRepo(value.repo), asOf: timestamp(value.asOf), rowLimit: integer(value.rowLimit, 1, TASK_VIEW_LIMITS.items) });
}
export function parseTaskBugCountV1(input: unknown): TaskBugCountV1 {
  const value = record(input);
  if (!['exact', 'approximate', 'unavailable'].includes(value.quality as string) || (value.quality === 'unavailable') !== (value.value === null)) invalid();
  return Object.freeze({ value: value.value === null ? null : integer(value.value, 0, Number.MAX_SAFE_INTEGER), quality: value.quality as TaskBugCountV1['quality'] });
}
export function parseTaskBugsReportV1(input: unknown, query: TaskBugsQueryV1, sourceId: string): TaskBugsReportV1 {
  query = parseTaskBugsQueryV1(query); const value = record(input);
  if (value.version !== 1 || value.repo !== query.repo || value.asOf !== query.asOf) invalid();
  const rowsQuality = quality(value.rowsQuality); const oldestQuality = quality(value.oldestQuality);
  const rows = array(value.rows, query.rowLimit).map(raw => {
    const item = record(raw); const createdAt = timestamp(item.createdAt); const dueAt = item.dueAt === null ? null : text(item.dueAt, 10);
    if (createdAt > query.asOf || dueAt !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString().slice(0, 10) !== dueAt)) invalid();
    const row = { ref: reference(item.ref, sourceId), displayKey: text(item.displayKey, 512), title: text(item.title, 2048), url: url(item.url),
      priority: item.priority === null ? null : text(item.priority, 128), severity: item.severity === null ? null : text(item.severity, 240), dueAt, createdAt,
      ...(item.description === undefined ? {} : { description: description(item.description) }) };
    return Object.freeze(row);
  });
  if (new Set(rows.map(item => item.ref.externalId)).size !== rows.length || rowsQuality === 'unavailable' && rows.length > 0) invalid();
  let oldest: TaskBugsReportV1['oldest'] = null;
  if (value.oldest !== null) {
    const item = record(value.oldest); const createdAt = timestamp(item.createdAt);
    if (createdAt > query.asOf || oldestQuality === 'unavailable') invalid();
    oldest = Object.freeze({ ref: reference(item.ref, sourceId), displayKey: text(item.displayKey, 512), url: url(item.url), createdAt });
  }
  const sample = record(value.resolutionP75); const sampleQuality = quality(sample.quality); const sampleSize = integer(sample.sampleSize, 0, 100);
  if (typeof sample.capped !== 'boolean' || sample.days !== null && (typeof sample.days !== 'number' || !Number.isFinite(sample.days) || sample.days < 0)
    || (sampleSize === 0) !== (sample.days === null) || sampleQuality === 'unavailable' && sampleSize !== 0 || sampleQuality === 'complete' && sample.capped) invalid();
  return bounded(Object.freeze({ version: 1, repo: query.repo, asOf: query.asOf, open: parseTaskBugCountV1(value.open), createdLast7d: parseTaskBugCountV1(value.createdLast7d),
    completedLast7d: parseTaskBugCountV1(value.completedLast7d), pastSla: parseTaskBugCountV1(value.pastSla), rows: Object.freeze(rows), rowsQuality, oldest, oldestQuality,
    resolutionP75: Object.freeze({ days: sample.days as number | null, sampleSize, population: parseTaskBugCountV1(sample.population), quality: sampleQuality, capped: sample.capped }) }));
}
export function parseTaskTriageReadQueryV1(input: unknown): TaskTriageReadQueryV1 {
  return Object.freeze({ ...parseTaskReadSelectionV1(input), ...parseTaskTriageQueryV1(input) });
}
export function parseTaskTriageReadSnapshotV1(input: unknown, expected: TaskTriageReadQueryV1): TaskTriageReadSnapshotV1 {
  expected = parseTaskTriageReadQueryV1(expected); const value = record(input);
  const selection = parseTaskReadSelectionV1(value.selection); const query = parseTaskTriageQueryV1(value.query);
  if (JSON.stringify(selection) !== JSON.stringify(parseTaskReadSelectionV1(expected)) || JSON.stringify(query) !== JSON.stringify(parseTaskTriageQueryV1(expected))) invalid();
  const page = parseTaskTriagePageV1(value.page, query, selection.sourceId); const seen = new Set<string>();
  const relatedRuns = array(value.relatedRuns ?? [], page.items.length).map(raw => {
    const related = record(raw); const ref = reference(related.ref, selection.sourceId); const repo = parseTaskRepo(related.repo); const runId = text(related.runId, 128);
    if (repo !== selection.repo || !/^[a-z\d_-]+$/i.test(runId) || seen.has(ref.externalId) || !page.items.some(item => item.ref.externalId === ref.externalId)) invalid();
    seen.add(ref.externalId); return Object.freeze({ ref, repo, runId });
  });
  const relatedRunsQuality = quality(value.relatedRunsQuality ?? 'unavailable');
  if (relatedRunsQuality === 'unavailable' && relatedRuns.length) invalid();
  return Object.freeze({ selection, query, page, relatedRuns: Object.freeze(relatedRuns), relatedRunsQuality });
}
export function parseTaskBugsReadSnapshotV1(input: unknown, expected: TaskReadSelectionV1): TaskBugsReadSnapshotV1 {
  expected = parseTaskReadSelectionV1(expected); const value = record(input); const selection = parseTaskReadSelectionV1(value.selection);
  if (JSON.stringify(selection) !== JSON.stringify(expected)) invalid();
  const report = record(value.report); const query = parseTaskBugsQueryV1({ repo: selection.repo, asOf: report.asOf, rowLimit: TASK_VIEW_LIMITS.items });
  return Object.freeze({ selection, report: parseTaskBugsReportV1(report, query, selection.sourceId) });
}
