import { TaskContextValidationError } from '../../src/plugins/task-context';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { TaskContextError, type TaskContextServerService } from './task-context-service';
import type { ApiResult } from './router';

export async function handleTaskContextApi(input: { method: string; path: string; query: URLSearchParams; service?: TaskContextServerService; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (!input.path.startsWith('/api/task-context/')) return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Task context requires GET' } };
  if (!input.service) return { status: 503, json: { error: 'Task context is unavailable' } };
  const match = /^\/api\/task-context\/([a-z\d-]{1,160})\/([^/]{1,1536})$/i.exec(input.path);
  if (!match) return { status: 404, json: { error: 'Task context route not found' } };
  try {
    const sourceId = input.query.get('sourceId') ?? ''; const claim = input.query.get('claim'); const externalId = decodeURIComponent(match[2]!);
    if (claim !== null && claim !== 'active' && claim !== 'settled') throw new TaskContextValidationError('Invalid task context claim');
    return { status: 200, json: await input.service.resolve({ version: 1, selection: { version: 1, instanceId: match[1]!, instanceRevision: Number(input.query.get('revision')), sourceId, repo: input.query.get('repo') ?? '' },
      ref: { sourceId, externalId }, taskRevision: input.query.get('taskRevision') ?? '', claim: claim === 'settled' ? 'settled' : 'active' }, input.signal ?? AbortSignal.timeout(30_000)) };
  } catch (error) {
    if (error instanceof TaskContextError) return { status: error.status, json: { error: error.message } };
    if (error instanceof TaskContextValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceConflictError || error instanceof PersistenceValidationError || error instanceof RangeError) return { status: 409, json: { error: 'Task context changed' } };
    return { status: 503, json: { error: 'Task context is unavailable' } };
  }
}
