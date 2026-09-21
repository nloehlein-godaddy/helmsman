import { TaskViewValidationError, parseTaskTriageReadQueryV1 } from '../../src/plugins/task-views';
import { TaskReadValidationError, parseTaskReadSelectionV1 } from '../../src/plugins/task-read';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { TaskSourceViewUnavailableError } from './task-source-views';
import type { TaskViewsReadService } from './task-views-read-service';

export async function handleTaskViewsReadApi(input: { method: string; path: string; query: URLSearchParams; service?: TaskViewsReadService; signal?: AbortSignal }) {
  if (!input.path.startsWith('/api/task-views-read/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Task views unavailable' } };
  const match = /^\/api\/task-views-read\/([a-z\d-]{1,160})\/(triage|bugs)$/i.exec(input.path);
  if (input.method !== 'GET' || !match) return { status: 404, json: { error: 'Task view route unavailable' } };
  let providerStarted = false;
  try {
    const fields = ['repo', 'revision', 'sourceId', ...(match[2] === 'triage' ? ['group', 'priorities', 'updatedSince', 'until', 'cursor', 'limit'] : [])];
    if ([...input.query.keys()].some(key => !fields.includes(key)) || fields.some(key => input.query.getAll(key).length !== 1)
      || !/^[1-9]\d*$/.test(input.query.get('revision') ?? '')) throw new TaskReadValidationError('Invalid task view query');
    const selection = parseTaskReadSelectionV1({ version: 1, repo: input.query.get('repo'), sourceId: input.query.get('sourceId'), instanceId: match[1], instanceRevision: Number(input.query.get('revision')) });
    const signal = input.signal ?? AbortSignal.timeout(30_000);
    if (match[2] === 'bugs') { providerStarted = true; return { status: 200, json: await input.service.bugs(selection, signal) }; }
    const priorities = input.query.get('priorities')!;
    if (priorities !== '' && !/^[0-4](?:,[0-4]){0,4}$/.test(priorities) || !/^[1-9]\d{0,2}$/.test(input.query.get('limit') ?? '')) throw new TaskReadValidationError('Invalid task view filters');
    const query = parseTaskTriageReadQueryV1({ ...selection, group: input.query.get('group'), priorities: priorities === '' ? [] : priorities.split(',').map(Number),
      updatedSince: input.query.get('updatedSince') || null, until: input.query.get('until'), cursor: input.query.get('cursor') || null, limit: Number(input.query.get('limit')) });
    providerStarted = true; return { status: 200, json: await input.service.triage(query, signal) };
  } catch (error) {
    if (error instanceof TaskSourceViewUnavailableError) return { status: 501, json: { error: 'Source view unavailable' } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Source selection changed' } };
    if (error instanceof TaskViewValidationError) return { status: providerStarted ? 502 : 400, json: { error: providerStarted ? 'Invalid source view' : 'Invalid task view query' } };
    if (error instanceof TaskReadValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid task view query' } };
    return { status: 503, json: { error: 'Task views unavailable' } };
  }
}
