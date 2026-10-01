import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseCommunicationClearInputV1, parseCommunicationSettingsValuesV1 } from '../../src/plugins/communication';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseTaskRepo, TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import type { CommunicationReadServerService } from './communication-read-service';
import type { ApiResult } from './router';

export function handleCommunicationApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: CommunicationReadServerService;
}): ApiResult | null {
  if (!input.path.startsWith('/api/communication/')) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service;
    if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    const scope = (value: unknown) => value === null ? null : parseTaskRepo(value);
    for (const key of input.query.keys()) if (!['version', 'repo', 'limit', 'scopeRepo'].includes(key) || input.query.getAll(key).length !== 1)
      throw new ClarificationServiceError(400, 'invalid-response');
    if (input.path === '/api/communication/notifications' && input.method === 'GET') {
      if (input.query.get('version') !== '1' || !/^[1-9]\d{0,2}$/.test(input.query.get('limit') ?? '')) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: service.notifications(input.caller, { version: 1, repo: scope(input.query.get('repo')), limit: Number(input.query.get('limit')) }, scope(input.query.get('scopeRepo'))) };
    }
    if (input.path === '/api/communication/settings' && input.method === 'GET') {
      if ([...input.query.keys()].some(key => key !== 'scopeRepo')) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: service.settings(input.caller, scope(input.query.get('scopeRepo'))) };
    }
    if (input.method !== 'POST') throw new ClarificationServiceError(405, 'invalid-response');
    if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
    const body = clarificationObject(input.body);
    if (input.path === '/api/communication/notifications/clear') {
      clarificationFields(body, ['version', 'repo', 'clearToken', 'scopeRepo']);
      const { scopeRepo, ...request } = body;
      return { status: 200, json: service.clearNotifications(input.caller, parseCommunicationClearInputV1(request), scope(scopeRepo)) };
    }
    if (input.path === '/api/communication/settings') {
      clarificationFields(body, ['expectedRevision', 'values', 'scopeRepo']);
      if (typeof body.expectedRevision !== 'string') throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: service.saveSettings(input.caller, { expectedRevision: body.expectedRevision, values: parseCommunicationSettingsValuesV1(body.values) }, scope(body.scopeRepo)) };
    }
    const match = /^\/api\/communication\/notifications\/([a-z\d_-]{1,128})\/read$/i.exec(input.path);
    if (!match?.[1]) return { status: 404, json: { reason: 'not-found' } };
    clarificationFields(body, ['repo', 'scopeRepo']);
    return { status: 200, json: service.markRead(input.caller, { repo: parseTaskRepo(body.repo), id: match[1] }, scope(body.scopeRepo)) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
