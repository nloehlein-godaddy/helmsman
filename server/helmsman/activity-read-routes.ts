import { ActivityReadValidationError } from '../../src/plugins/activity-read';
import { TaskReadValidationError, parseTaskReadSelectionV1 } from '../../src/plugins/task-read';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { TaskSourceViewUnavailableError } from './task-source-service';
import type { ActivityReadService } from './activity-read-service';

export async function handleActivityReadApi(input: { method: string; path: string; query: URLSearchParams; service?: ActivityReadService; signal?: AbortSignal }) {
  if (!input.path.startsWith('/api/activity-read/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Activity reads unavailable' } };
  const match = /^\/api\/activity-read\/([a-z\d-]{1,160})$/i.exec(input.path);
  if (input.method !== 'GET' || !match) return { status: 404, json: { error: 'Activity route unavailable' } };
  try {
    if ([...input.query.keys()].some(key => !['repo', 'revision', 'sourceId'].includes(key))
      || ['repo', 'revision', 'sourceId'].some(key => input.query.getAll(key).length !== 1)
      || !/^[1-9]\d*$/.test(input.query.get('revision') ?? '')) throw new TaskReadValidationError('Invalid activity query');
    const selection = parseTaskReadSelectionV1({ version: 1, repo: input.query.get('repo'), sourceId: input.query.get('sourceId'), instanceId: match[1], instanceRevision: Number(input.query.get('revision')) });
    return { status: 200, json: await input.service.query(selection, input.signal ?? AbortSignal.timeout(30_000)) };
  } catch (error) {
    if (error instanceof TaskSourceViewUnavailableError) return { status: 501, json: { error: 'Source history unavailable' } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Source selection changed' } };
    if (error instanceof TaskReadValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid activity query' } };
    if (error instanceof ActivityReadValidationError) return { status: 502, json: { error: 'Invalid source history' } };
    return { status: 503, json: { error: 'Activity reads unavailable' } };
  }
}
