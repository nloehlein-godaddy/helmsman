import { clarificationFields, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseTerminalControlCommandV1, parseTerminalLines, parseTerminalReceiptQueryV1, parseTerminalRepo, parseTerminalTargetV1 } from '../../src/plugins/terminal';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import type { TerminalServerService } from './terminal-service';
import type { ApiResult } from './router';

export async function handleTerminalApi(input: {
  method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: TerminalServerService;
}): Promise<ApiResult | null> {
  if (!input.path.startsWith('/api/terminal/')) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service;
    if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    for (const key of input.query.keys()) if (!['repo', 'scopeRepo', 'version'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    const method = (expected: string) => { if (input.method !== expected) throw new ClarificationServiceError(405, 'invalid-response'); };
    if (input.path === '/api/terminal/tabs') {
      method('GET');
      if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: await service.list(input.caller, { version: 1, repo: parseTerminalRepo(input.query.get('repo')) }, parseTerminalRepo(input.query.get('scopeRepo'))) };
    }
    const match = /^\/api\/terminal\/receipts\/([^/]+)$/.exec(input.path);
    if (match) {
      method('GET');
      if (input.query.has('version')) throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: service.receipt(input.caller, parseTerminalReceiptQueryV1({ repo: input.query.get('repo'), requestId: match[1] }), parseTerminalRepo(input.query.get('scopeRepo'))) };
    }
    if (input.path !== '/api/terminal/screen' && input.path !== '/api/terminal/control' && input.path !== '/api/terminal/inspect') return { status: 404, json: { reason: 'not-found' } };
    method('POST');
    if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
    const body = clarificationObject(input.body);
    if (input.path === '/api/terminal/screen') {
      clarificationFields(body, ['target', 'lines', 'scopeRepo']);
      return { status: 200, json: await service.screen(input.caller, { target: parseTerminalTargetV1(body.target), lines: parseTerminalLines(body.lines) }, parseTerminalRepo(body.scopeRepo)) };
    }
    clarificationFields(body, ['command', 'scopeRepo']);
    const command = parseTerminalControlCommandV1(body.command); const scopeRepo = parseTerminalRepo(body.scopeRepo);
    return { status: 200, json: input.path === '/api/terminal/inspect' ? service.inspect(input.caller, command, scopeRepo) : await service.control(input.caller, command, scopeRepo) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError)
      return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
