import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parsePullRequestCommandV1, parsePullRequestCommandReceiptQueryV1 } from '../../src/plugins/pull-request-command';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseTaskRepo, TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError } from './persistence';
import { ClarificationServiceError } from './clarification-service-common';
import type { PullRequestCommandServerService } from './pull-request-command-service';
import type { ApiResult } from './router';

export async function handlePullRequestCommandApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: PullRequestCommandServerService;
}): Promise<ApiResult | null> {
  const base = '/api/pull-request-command';
  if (input.path !== base && !input.path.startsWith(`${base}/`)) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service;
    if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    for (const key of input.query.keys()) if (!['repo', 'scopeRepo'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const requireMethod = (method: string) => { if (input.method !== method) throw new ClarificationServiceError(405, 'invalid-response'); };
    if (input.path === base || input.path === `${base}/retry`) {
      requireMethod('POST');
      if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
      const body = clarificationObject(input.body); const retry = input.path.endsWith('/retry');
      clarificationFields(body, [retry ? 'query' : 'command', 'scopeRepo']);
      const scope = body.scopeRepo === null ? null : parseTaskRepo(body.scopeRepo);
      const result = retry ? await service.retry(input.caller, parsePullRequestCommandReceiptQueryV1(body.query), scope)
        : await service.submit(input.caller, parsePullRequestCommandV1(body.command), scope);
      return { status: 200, json: result };
    }
    const match = /^\/api\/pull-request-command\/receipts\/([^/]+)$/.exec(input.path);
    if (!match) return { status: 404, json: { reason: 'not-found' } };
    requireMethod('GET');
    const scope = input.query.has('scopeRepo') ? parseTaskRepo(input.query.get('scopeRepo')) : null;
    return { status: 200, json: service.receipt(input.caller, parsePullRequestCommandReceiptQueryV1({ repo: input.query.get('repo'), requestId: match[1] }), scope) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
