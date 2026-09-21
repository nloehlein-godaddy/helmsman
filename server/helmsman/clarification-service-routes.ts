import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseClarificationReadListQueryV1, parseClarificationReadLoadQueryV1 } from '../../src/plugins/clarification-read';
import { parseClarificationCommandV1, parseClarificationCommandReceiptQueryV1 } from '../../src/plugins/clarification-command';
import { parseSuggestedContactAdminCommandV1, parseSuggestedContactAdminListQueryV1, parseSuggestedContactAdminLoadQueryV1, parseSuggestedContactAdminReceiptQueryV1 } from '../../src/plugins/suggested-contact-admin';
import { parseTaskRepo, TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { ClarificationServiceError } from './clarification-service-common';
import type { ClarificationReadServerService } from './clarification-read-service';
import type { ClarificationCommandServerService } from './clarification-command-service';
import type { SuggestedContactAdminServerService } from './suggested-contact-admin-service';
import type { ApiResult } from './router';

export function handleClarificationServiceApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string;
  reads?: ClarificationReadServerService; commands?: ClarificationCommandServerService; contacts?: SuggestedContactAdminServerService;
}): ApiResult | null {
  const { path, query, method } = input;
  if (!['/api/clarification-read', '/api/clarification-command', '/api/suggested-contact-admin'].some(base => path === base || path.startsWith(`${base}/`))) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    for (const key of query.keys()) if (query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const caller = input.caller;
    const scope = () => query.get('scopeRepo') === null ? null : parseTaskRepo(query.get('scopeRepo'));
    const limit = () => { const value = query.get('limit') ?? '25'; if (!/^[1-9]\d*$/.test(value)) throw new ClarificationServiceError(400, 'invalid-response'); return Number(value); };
    const requireMethod = (expected: string) => { if (method !== expected) throw new ClarificationServiceError(405, 'invalid-response'); };
    const available = <T>(service: T | undefined): T => { if (!service) throw new ClarificationServiceError(503, 'service-unavailable'); return service; };
    let result: unknown;
    if (path === '/api/clarification-read') {
      requireMethod('GET');
      result = available(input.reads).list(caller, parseClarificationReadListQueryV1({ version: 1, repo: query.get('repo'), runId: query.get('runId'),
        states: JSON.parse(query.get('states') ?? '[]') as unknown, limit: limit(), cursor: query.get('cursor') }), scope());
    } else if (path.startsWith('/api/clarification-read/')) {
      requireMethod('GET');
      result = available(input.reads).load(caller, parseClarificationReadLoadQueryV1({ version: 1, repo: query.get('repo'), runId: query.get('runId'), questionId: path.slice('/api/clarification-read/'.length) }), scope());
    } else if (path === '/api/clarification-command') {
      requireMethod('POST'); const body = clarificationObject(input.body); clarificationFields(body, ['command', 'scopeRepo']);
      result = available(input.commands).submit(caller, parseClarificationCommandV1(body.command), body.scopeRepo === null ? null : parseTaskRepo(body.scopeRepo));
    } else if (path.startsWith('/api/clarification-command/receipts/')) {
      requireMethod('GET');
      result = available(input.commands).receipt(caller, parseClarificationCommandReceiptQueryV1({ repo: query.get('repo'), requestId: path.slice('/api/clarification-command/receipts/'.length) }), scope());
    } else if (path === '/api/suggested-contact-admin') {
      requireMethod('GET');
      result = available(input.contacts).list(caller, parseSuggestedContactAdminListQueryV1({ version: 1, scope: query.get('scope'), limit: limit(), cursor: query.get('cursor') }));
    } else if (path === '/api/suggested-contact-admin/commands') {
      requireMethod('POST'); result = available(input.contacts).submit(caller, parseSuggestedContactAdminCommandV1(input.body));
    } else if (path.startsWith('/api/suggested-contact-admin/receipts/')) {
      requireMethod('GET'); result = available(input.contacts).receipt(caller,
        parseSuggestedContactAdminReceiptQueryV1({ scope: query.get('scope'), requestId: path.slice('/api/suggested-contact-admin/receipts/'.length) }));
    } else if (path.startsWith('/api/suggested-contact-admin/')) {
      requireMethod('GET'); result = available(input.contacts).load(caller,
        parseSuggestedContactAdminLoadQueryV1({ version: 1, scope: query.get('scope'), id: path.slice('/api/suggested-contact-admin/'.length) }));
    } else return { status: 404, json: { reason: 'not-found' } };
    return { status: 200, json: result };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    if (error instanceof PersistenceValidationError) return { status: 503, json: { reason: 'service-unavailable' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
