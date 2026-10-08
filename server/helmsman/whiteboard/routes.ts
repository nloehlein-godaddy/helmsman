import { isContributionId } from '../../../src/plugins/manifest';
import { parseWhiteboardTargetV1 } from '../../../src/plugins/whiteboard';
import { protocolRecord } from '../agent-protocol';
import { clarificationScope, ClarificationServiceError } from '../clarification-service-common';
import type { ApiResult } from '../router';
import { WhiteboardError, type WhiteboardServerService } from './service';

export async function handleWhiteboardApi(input: {
  method: string; path: string; query?: URLSearchParams; body?: unknown; caller?: string;
  authorize?: (caller: string) => void; repos?: () => readonly string[]; service?: WhiteboardServerService;
}): Promise<ApiResult | null> {
  if (!['/api/whiteboard', '/api/whiteboard/explain', '/api/whiteboard/open'].includes(input.path)) return null;
  if (!input.caller || !isContributionId(input.caller) || !input.authorize) return { status: 403, json: { error: 'forbidden' } };
  if (!input.service || !input.repos) return { status: 503, json: { error: 'Whiteboard is unavailable.' } };
  try {
    input.authorize(input.caller);
    const reading = input.method === 'GET' && input.path === '/api/whiteboard';
    const writing = input.method === 'POST' && input.path !== '/api/whiteboard';
    if (!reading && !writing) return { status: 405, json: { error: 'Method not allowed.' } };
    let raw: unknown; let scopeRepo: unknown;
    if (reading) {
      const query = input.query ?? new URLSearchParams();
      if ([...query.keys()].some(key => !['target', 'scopeRepo'].includes(key) || query.getAll(key).length !== 1)) throw new WhiteboardError(400, 'invalid-request');
      const encoded = query.get('target');
      if (!encoded || encoded.length > 4096) throw new WhiteboardError(400, 'invalid-request');
      try { raw = JSON.parse(encoded); } catch { throw new WhiteboardError(400, 'invalid-request'); }
      scopeRepo = query.get('scopeRepo');
    } else {
      const body = protocolRecord(input.body);
      if (!body || !Object.hasOwn(body, 'target') || !Object.hasOwn(body, 'scopeRepo') || Object.keys(body).some(key => !['target', 'scopeRepo'].includes(key))) throw new WhiteboardError(400, 'invalid-request');
      raw = body.target; scopeRepo = body.scopeRepo;
    }
    let target;
    try { target = parseWhiteboardTargetV1(raw); } catch { throw new WhiteboardError(400, 'invalid-target'); }
    clarificationScope(input.repos(), scopeRepo, null);
    clarificationScope(input.repos(), null, target.repo);
    const value = reading ? await input.service.read(target) : input.path.endsWith('/open')
      ? await input.service.open(target) : await input.service.explain(target);
    return { status: 200, json: value };
  } catch (error) {
    if (error instanceof WhiteboardError) return { status: error.status, json: { error: error.reason } };
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { error: error.reason } };
    return { status: 503, json: { error: 'Whiteboard request failed.' } };
  }
}
