import { sourceFields, sourceObject, SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseSourceRemoteActionCommandV1, parseSourceRemoteActionReceiptQueryV1 } from '../../src/plugins/task-actions';
import { parseTaskReadSelectionV1 } from '../../src/plugins/task-read';
import { parseTaskRepo, TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError } from './persistence';
import { ClarificationServiceError } from './clarification-service-common';
import type { TaskActionServerService } from './task-action-service';
import type { ApiResult } from './router';

export async function handleTaskActionApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: TaskActionServerService;
}): Promise<ApiResult | null> {
  const base = '/api/task-action';
  if (input.path !== base && !input.path.startsWith(`${base}/`)) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service;
    if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    for (const key of input.query.keys()) if (!['repo', 'scopeRepo'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const requireMethod = (method: string) => { if (input.method !== method) throw new ClarificationServiceError(405, 'invalid-response'); };
    if ([base, `${base}/retry`, `${base}/discover`].includes(input.path)) {
      requireMethod('POST');
      if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
      const body = sourceObject(input.body); const field = input.path.endsWith('/discover') ? 'selection' : input.path.endsWith('/retry') ? 'query' : 'command';
      sourceFields(body, [field, 'scopeRepo']);
      const scope = body.scopeRepo === null ? null : parseTaskRepo(body.scopeRepo);
      if (field === 'selection') {
        sourceFields(sourceObject(body.selection), ['version', 'sourceId', 'instanceId', 'instanceRevision', 'repo']);
        return { status: 200, json: service.discover(input.caller, parseTaskReadSelectionV1(body.selection), scope) };
      }
      return { status: 200, json: field === 'query' ? await service.retry(input.caller, parseSourceRemoteActionReceiptQueryV1(body.query), scope)
        : await service.submit(input.caller, parseSourceRemoteActionCommandV1(body.command), scope) };
    }
    const match = /^\/api\/task-action\/receipts\/([^/]+)$/.exec(input.path);
    if (!match) return { status: 404, json: { reason: 'not-found' } };
    requireMethod('GET');
    const scope = input.query.has('scopeRepo') ? parseTaskRepo(input.query.get('scopeRepo')) : null;
    return { status: 200, json: service.receipt(input.caller, parseSourceRemoteActionReceiptQueryV1({ repo: input.query.get('repo'), requestId: match[1] }), scope) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
