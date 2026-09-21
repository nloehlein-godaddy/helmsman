import { clarificationFields, clarificationId, clarificationObject } from '../../src/plugins/clarification-validation';
import { parseCampaignCommandV1, parseCampaignReceiptQueryV1 } from '../../src/plugins/campaigns';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseTaskRepo, TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import type { CampaignPublicService } from './campaigns-public-service';
import type { ApiResult } from './router';

export async function handleCampaignPublicApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: CampaignPublicService }): Promise<ApiResult | null> {
  if (!input.path.startsWith('/api/campaign-service/')) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service; if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    const scope = (value: unknown) => value === null ? null : parseTaskRepo(value);
    const query = (keys: readonly string[]) => { for (const key of input.query.keys()) if (!keys.includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response'); };
    const method = (expected: string) => { if (input.method !== expected) throw new ClarificationServiceError(405, 'invalid-response'); };
    if (input.path === '/api/campaign-service/commands') {
      method('POST'); query([]); const body = clarificationObject(input.body); clarificationFields(body, ['command', 'scopeRepo']);
      return { status: 200, json: service.submit(input.caller, parseCampaignCommandV1(body.command), scope(body.scopeRepo)) };
    }
    method('GET');
    if (input.path === '/api/campaign-service/list' || input.path === '/api/campaign-service/detail') {
      const detail = input.path.endsWith('/detail'); query(detail ? ['version', 'repo', 'scopeRepo', 'campaignId'] : ['version', 'repo', 'scopeRepo']);
      if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
      return { status: 200, json: detail ? service.detail(input.caller, { version: 1, repo: parseTaskRepo(input.query.get('repo')), campaignId: clarificationId(input.query.get('campaignId')) }, scope(input.query.get('scopeRepo')))
        : service.list(input.caller, { version: 1, repo: scope(input.query.get('repo')) }, scope(input.query.get('scopeRepo'))) };
    }
    const match = /^\/api\/campaign-service\/receipts\/([^/]+)$/.exec(input.path); if (!match) return { status: 404, json: { reason: 'not-found' } };
    query(['repo', 'scopeRepo']);
    return { status: 200, json: service.receipt(input.caller, parseCampaignReceiptQueryV1({ repo: input.query.get('repo'), requestId: match[1] }), scope(input.query.get('scopeRepo'))) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError) return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
