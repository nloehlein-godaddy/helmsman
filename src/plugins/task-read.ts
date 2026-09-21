import { parseTaskPageV1, parseTaskRepo, parseTaskSnapshotV1, parseWorkRefV1, TASK_SOURCE_LIMITS } from './tasks';
import type { TaskSnapshotV1, WorkRefV1 } from './tasks';

export type TaskReadUnavailableReasonV1 = 'forbidden' | 'selection-changed' | 'disabled' | 'source-unavailable' | 'view-unavailable' | 'not-found' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type TaskReadResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: TaskReadUnavailableReasonV1 };

export interface TaskReadSelectionV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly instanceId: string;
  readonly instanceRevision: number;
  readonly repo: string;
}

export interface TaskReadSourceV1 extends TaskReadSelectionV1 {
  readonly readViews?: readonly ('underway' | 'history')[];
  readonly label: string;
  readonly availability: 'available' | 'disabled' | 'unavailable';
}

export type TaskReadTaskV1 = Omit<TaskSnapshotV1, 'providerData'>;
export interface TaskReadDiscoveryV1 {
  readonly version: 1;
  readonly repo: string | null;
  readonly galleons: readonly {
    readonly repo: string;
    readonly sources: TaskReadResultV1<readonly TaskReadSourceV1[]>;
  }[];
}

export interface TaskReadListQueryV1 extends TaskReadSelectionV1 {
  readonly state: TaskReadTaskV1['state'] | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TaskReadLoadQueryV1 extends TaskReadSelectionV1 {
  readonly ref: WorkRefV1;
}

export interface TaskReadLookupQueryV1 extends TaskReadSelectionV1 { readonly displayKey: string; }

export interface TaskReadUnderwayQueryV1 extends TaskReadSelectionV1 { readonly cursor: string | null; readonly limit: number; }

export interface TaskReadPageV1 {
  readonly selection: TaskReadSelectionV1;
  readonly items: readonly TaskReadTaskV1[];
  readonly nextCursor: string | null;
}

export interface TaskReadItemV1 {
  readonly selection: TaskReadSelectionV1;
  readonly ref: WorkRefV1;
  readonly task: TaskReadTaskV1 | null;
}

export interface TaskReadServiceV1 {
  readonly version: 1;
  discover(signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadDiscoveryV1>>;
  list(input: TaskReadListQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadPageV1>>;
  load(input: TaskReadLoadQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadItemV1>>;
  lookup?(input: TaskReadLookupQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadItemV1 | null>>;
  underway?(input: TaskReadUnderwayQueryV1, signal?: AbortSignal): Promise<TaskReadResultV1<TaskReadPageV1>>;
}

export const TASK_READ_LIMITS: Readonly<{ galleons: number; instances: number; discoveryConcurrency: number; responseBytes: number }> = Object.freeze({ galleons: 1000, instances: 1000, discoveryConcurrency: 4, responseBytes: TASK_SOURCE_LIMITS.pageBytes });
export class TaskReadValidationError extends Error {}
function invalid(): never { throw new TaskReadValidationError('Invalid task read data'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalid();
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, length: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > length || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const key of Reflect.ownKeys(value)) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) invalid();
    return descriptor.value as unknown;
  });
}

export function parseTaskReadSelectionV1(input: unknown): TaskReadSelectionV1 {
  const value = record(input);
  const instanceId = boundedText(value.instanceId, 160);
  if (value.version !== 1 || !/^[a-z\d-]+$/i.test(instanceId) || typeof value.instanceRevision !== 'number'
    || !Number.isSafeInteger(value.instanceRevision) || value.instanceRevision < 1) invalid();
  const sourceId = parseWorkRefV1({ sourceId: value.sourceId, externalId: instanceId }).sourceId;
  return Object.freeze({ version: 1, sourceId, instanceId, instanceRevision: value.instanceRevision, repo: parseTaskRepo(value.repo) });
}

export function parseTaskReadListQueryV1(input: unknown): TaskReadListQueryV1 {
  const value = record(input);
  const selection = parseTaskReadSelectionV1(value);
  if (value.state !== null && (typeof value.state !== 'string' || !['ready', 'in_progress', 'review', 'done', 'blocked'].includes(value.state))
    || value.cursor !== null && (typeof value.cursor !== 'string' || !value.cursor.trim() || value.cursor.length > TASK_SOURCE_LIMITS.cursorLength)
    || typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > TASK_SOURCE_LIMITS.pageItems) invalid();
  return Object.freeze({ ...selection, state: value.state as TaskReadTaskV1['state'] | null, cursor: value.cursor as string | null, limit: value.limit });
}

export function parseTaskReadLoadQueryV1(input: unknown): TaskReadLoadQueryV1 {
  const value = record(input);
  const selection = parseTaskReadSelectionV1(value);
  const ref = parseWorkRefV1(value.ref);
  if (ref.sourceId !== selection.sourceId) invalid();
  return Object.freeze({ ...selection, ref });
}

export function parseTaskReadLookupQueryV1(input: unknown): TaskReadLookupQueryV1 {
  const value = record(input);
  return Object.freeze({ ...parseTaskReadSelectionV1(value), displayKey: boundedText(value.displayKey, 512) });
}

export function parseTaskReadLookupRef(input: unknown, query: TaskReadLookupQueryV1): WorkRefV1 | null {
  query = parseTaskReadLookupQueryV1(query);
  const value = record(input);
  if (value.ref === null) return null;
  const ref = parseWorkRefV1(value.ref);
  if (ref.sourceId !== query.sourceId) invalid();
  return Object.freeze(ref);
}

export function parseTaskReadUnderwayQueryV1(input: unknown): TaskReadUnderwayQueryV1 {
  const value = record(input);
  const { state: _state, ...query } = parseTaskReadListQueryV1({ ...value, state: null });
  if (value.state !== undefined && value.state !== null) invalid();
  return Object.freeze(query);
}

export function parseTaskReadGalleons(input: unknown): readonly string[] {
  const repos = array(record(input).repos, TASK_READ_LIMITS.galleons).map(parseTaskRepo);
  if (new Set(repos.map(repo => repo.toLowerCase())).size !== repos.length) invalid();
  return Object.freeze(repos);
}

export function parseTaskReadSources(input: unknown, repo: string): readonly TaskReadSourceV1[] {
  parseTaskRepo(repo);
  const sources = array(record(input).instances, TASK_READ_LIMITS.instances).map(raw => {
    const value = record(raw);
    const selection = parseTaskReadSelectionV1({ version: 1, sourceId: value.sourceId, instanceId: value.id, instanceRevision: value.revision, repo });
    const allowedRepos = array(value.allowedRepos, TASK_READ_LIMITS.galleons).map(parseTaskRepo);
    if (!allowedRepos.includes(repo) || new Set(allowedRepos).size !== allowedRepos.length || typeof value.available !== 'boolean'
      || typeof value.desiredEnabled !== 'boolean' || value.available && !value.desiredEnabled) invalid();
    const availability: TaskReadSourceV1['availability'] = !value.desiredEnabled ? 'disabled' : value.available ? 'available' : 'unavailable';
    const readViews = value.readViews === undefined ? undefined : array(value.readViews, 2);
    if (readViews?.some(view => view !== 'underway' && view !== 'history') || readViews && new Set(readViews).size !== readViews.length) invalid();
    return Object.freeze({ ...selection, label: boundedText(value.label, 240), availability,
      ...(readViews ? { readViews: Object.freeze(readViews as ('underway' | 'history')[]) } : {}) });
  });
  if (new Set(sources.map(source => source.instanceId)).size !== sources.length) invalid();
  return Object.freeze(sources);
}

function presentation(task: TaskSnapshotV1): TaskReadTaskV1 {
  const { providerData: _providerData, ...value } = task;
  return Object.freeze(value);
}

export function parseTaskReadPage(input: unknown, query: TaskReadListQueryV1): TaskReadPageV1 {
  query = parseTaskReadListQueryV1(query);
  const selection = parseTaskReadSelectionV1(query);
  const page = parseTaskPageV1(input, selection);
  if (page.items.length > query.limit || page.nextCursor !== null && page.nextCursor === query.cursor
    || page.items.some(task => query.state !== null && task.state !== query.state)) invalid();
  return Object.freeze({ selection, items: Object.freeze(page.items.map(presentation)), nextCursor: page.nextCursor });
}

export function parseTaskReadItem(input: unknown, query: TaskReadLoadQueryV1): TaskReadItemV1 {
  query = parseTaskReadLoadQueryV1(query);
  const selection = parseTaskReadSelectionV1(query);
  const task = parseTaskSnapshotV1(record(input).task, selection);
  if (task.ref.externalId !== query.ref.externalId) invalid();
  return Object.freeze({ selection, ref: query.ref, task: presentation(task) });
}
