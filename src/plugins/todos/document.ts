import type { LocalTaskDocumentV1, LocalTaskInputV1 } from '@helmsman/plugin-sdk';

export const LOCAL_TASK_SCHEMA = 'helmsman.local-task/v1';
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export const STATES = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
const fields = ['title', 'repo', 'description', 'acceptanceCriteria', 'priority', 'state'] as const;
export type TodoValues = Pick<LocalTaskDocumentV1, 'title' | 'description' | 'acceptanceCriteria' | 'priority' | 'state'> & { repo: string };

export class TodoSourceError extends Error {}

export function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new TodoSourceError('Expected a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || allowed && !allowed.includes(key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) throw new TodoSourceError('Unexpected object fields');
  return value as Record<string, unknown>;
}

export function repo(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value)) throw new TodoSourceError('Galleon must use owner/name format');
  return value;
}

export function sequence(value: unknown): number {
  if (typeof value !== 'string' || !/^TODO-[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value.slice(5)))) throw new TodoSourceError('Invalid local task ID');
  return Number(value.slice(5));
}

export function input(value: unknown, partial: boolean): Partial<TodoValues> {
  const source = object(value, fields);
  const result: Record<string, string> = {};
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    const raw = source[field];
    if (typeof raw !== 'string' || raw.includes('\0')) throw new TodoSourceError(`${field} must be a string`);
    result[field] = raw.trim();
  }
  for (const field of ['title', 'repo']) if ((!partial || Object.hasOwn(result, field)) && !result[field]) throw new TodoSourceError(`${field === 'repo' ? 'Galleon' : 'Title'} is required`);
  if ((result.title?.length ?? 0) > 240) throw new TodoSourceError('Title must be 240 characters or fewer');
  if (result.repo !== undefined) repo(result.repo);
  for (const field of ['description', 'acceptanceCriteria']) if ((result[field]?.length ?? 0) > 20_000) throw new TodoSourceError(`${field} must be 20000 characters or fewer`);
  if (result.priority !== undefined && !PRIORITIES.some(priority => priority === result.priority)) throw new TodoSourceError('Priority must be P0 through P4');
  if (result.state !== undefined && !STATES.some(state => state === result.state)) throw new TodoSourceError('Invalid todo state');
  if (result.state === 'in_progress') throw new TodoSourceError('Start a voyage to move a todo into progress');
  return result as Partial<TodoValues>;
}

export function document(value: unknown): LocalTaskDocumentV1 {
  const raw = object(value, ['version', 'title', 'description', 'acceptanceCriteria', 'priority', 'state', 'createdAt', 'updatedAt', 'completedAt']);
  if (raw.version !== 1 || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 240
    || typeof raw.description !== 'string' || raw.description.length > 20_000 || typeof raw.acceptanceCriteria !== 'string' || raw.acceptanceCriteria.length > 20_000
    || !PRIORITIES.some(priority => priority === raw.priority) || !STATES.some(state => state === raw.state)) throw new TodoSourceError('Invalid local task document');
  for (const field of ['createdAt', 'updatedAt', 'completedAt']) {
    const value = raw[field];
    if (field === 'completedAt' && value === null) continue;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TodoSourceError('Invalid local task timestamp');
  }
  return raw as unknown as LocalTaskDocumentV1;
}

export function taskInput(value: unknown): LocalTaskInputV1 {
  const current = document(value);
  return { version: 1, title: current.title, description: current.description, acceptanceCriteria: current.acceptanceCriteria,
    priority: current.priority, state: current.state };
}
