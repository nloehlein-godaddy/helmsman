import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError, parseTaskRepo } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import type { TaskEditServerService } from './task-edit-service';
import type { ApiResult } from './router';

export async function handleTaskEditApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown;
  service?: TaskEditServerService; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (input.path !== '/api/task-edit' && !input.path.startsWith('/api/task-edit/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Task editors unavailable' } };
  try {
    if (input.path === '/api/task-edit') {
      if (input.method !== 'GET') return { status: 405, json: { error: 'Task editor discovery requires GET' } };
      const repo = input.query.get('repo');
      return { status: 200, json: input.service.discover(repo === null ? null : parseTaskRepo(repo)) };
    }
    const method = input.path === '/api/task-edit/create' ? 'create' : input.path === '/api/task-edit/load' ? 'load' : input.path === '/api/task-edit/list' ? 'list' : null;
    if (!method) return { status: 404, json: { error: 'Task editor route not found' } };
    if (input.method !== 'POST') return { status: 405, json: { error: 'Task editor read requires POST' } };
    return { status: 200, json: await input.service[method](input.body, input.signal ?? AbortSignal.timeout(30_000)) };
  } catch (error) {
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Task editor selection or task revision changed' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid task editor request' } };
    return { status: 503, json: { error: 'Task editors unavailable' } };
  }
}
