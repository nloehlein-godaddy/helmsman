import { parseTaskRepo } from '../../src/plugins/tasks';
import { clarificationBoolean, clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseLocalGitControlCommandV1, parseLocalGitReceiptQueryV1, parseLocalGitTargetV1 } from '../../src/plugins/local-git';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import type { LocalGitServerService } from './local-git-service';
import type { ApiResult } from './router';

export async function handleLocalGitApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: LocalGitServerService;
}): Promise<ApiResult | null> {
  if (!input.path.startsWith('/api/local-git/')) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  const scope = (value: unknown) => value === null ? null : parseTaskRepo(value);
  try {
    const service = input.service;
    if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    for (const key of input.query.keys()) if (!['repo', 'scopeRepo', 'version'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const method = (expected: string) => { if (input.method !== expected) throw new ClarificationServiceError(405, 'invalid-response'); };
    if (input.path === '/api/local-git/snapshot') {
      method('GET');
      if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: await service.snapshot(input.caller, { version: 1, repo: parseTaskRepo(input.query.get('repo')) }, scope(input.query.get('scopeRepo'))) };
    }
    const match = /^\/api\/local-git\/receipts\/([^/]+)$/.exec(input.path);
    if (match) {
      method('GET');
      if (input.query.has('version')) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: service.receipt(input.caller, parseLocalGitReceiptQueryV1({ repo: input.query.get('repo'), requestId: match[1] }), scope(input.query.get('scopeRepo'))) };
    }
    if (input.path !== '/api/local-git/preview' && input.path !== '/api/local-git/control' && input.path !== '/api/local-git/inspect') return { status: 404, json: { reason: 'not-found' } };
    method('POST');
    if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
    const body = clarificationObject(input.body);
    if (input.path === '/api/local-git/preview') {
      clarificationFields(body, ['target', 'force', 'scopeRepo']);
      return { status: 200, json: await service.preview(input.caller, { target: parseLocalGitTargetV1(body.target), force: clarificationBoolean(body.force) }, scope(body.scopeRepo)) };
    }
    clarificationFields(body, ['command', 'scopeRepo']);
    const command = parseLocalGitControlCommandV1(body.command); const scopeRepo = scope(body.scopeRepo);
    return { status: 200, json: input.path === '/api/local-git/inspect' ? service.inspect(input.caller, command, scopeRepo) : await service.control(input.caller, command, scopeRepo) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
