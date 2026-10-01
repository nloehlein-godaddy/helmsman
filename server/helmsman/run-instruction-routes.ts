import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseRunInstructionCommandV1, parseRunInstructionQueryV1, parseRunInstructionReceiptQueryV1 } from '../../src/plugins/run-instructions';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import { PersistenceConflictError } from './persistence';
import type { createRunInstructionService } from './run-instruction-service';
import type { ApiResult } from './router';

export async function handleRunInstructionApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: ReturnType<typeof createRunInstructionService>;
}): Promise<ApiResult | null> {
  if (input.path !== '/api/run-instructions' && !input.path.startsWith('/api/run-instructions/')) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  if (!input.service) return { status: 503, json: { reason: 'service-unavailable' } };
  try {
    const { path, method, query, caller, service } = input;
    for (const key of query.keys()) if (query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const scope = () => query.has('scopeRepo') ? parseTaskRepo(query.get('scopeRepo')) : null;
    if (path === '/api/run-instructions' && method === 'GET') {
      const attempt = query.get('expectedAttempt');
      if (!attempt || !/^[1-9]\d*$/.test(attempt)) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: await service.read(caller, parseRunInstructionQueryV1({ version: 1, repo: query.get('repo'), runId: query.get('runId'), expectedAttempt: Number(attempt) }), scope()) };
    }
    if (path === '/api/run-instructions' && method === 'POST') {
      const body = clarificationObject(input.body); clarificationFields(body, ['command', 'scopeRepo']);
      return { status: 200, json: await service.submit(caller, parseRunInstructionCommandV1(body.command), body.scopeRepo === null ? null : parseTaskRepo(body.scopeRepo)) };
    }
    if (path.startsWith('/api/run-instructions/receipts/') && method === 'GET') return { status: 200, json: await service.receipt(caller,
      parseRunInstructionReceiptQueryV1({ repo: query.get('repo'), requestId: path.slice('/api/run-instructions/receipts/'.length) }), scope()) };
    return { status: 405, json: { reason: 'invalid-response' } };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError) return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
