import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import type { ExecutionPolicyServerService } from './execution-policy-service';
import type { ApiResult } from './router';

export function handleExecutionPolicyApi(input: {
  method: string; path: string; query: URLSearchParams; body: unknown; caller?: string; service?: ExecutionPolicyServerService;
}): ApiResult | null {
  if (input.path !== '/api/execution-policy') return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    if (!input.service) throw new ClarificationServiceError(503, 'service-unavailable');
    if (input.method === 'GET') {
      if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
      for (const key of input.query.keys()) if (!['version', 'repo', 'scopeRepo'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: input.service.read(input.caller, { version: 1, repo: input.query.get('repo') }, input.query.get('scopeRepo')) };
    }
    if (input.method !== 'POST') throw new ClarificationServiceError(405, 'invalid-response');
    if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
    const body = clarificationObject(input.body); clarificationFields(body, ['command', 'scopeRepo']);
    const scope = body.scopeRepo === null ? null : parseTaskRepo(body.scopeRepo);
    return { status: 200, json: input.service.set(input.caller, body.command, scope) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
