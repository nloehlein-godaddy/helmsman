import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { ClarificationServiceError } from './clarification-service-common';
import type { ProfileServerService } from './profile-service';
import type { ApiResult } from './router';

export async function handleProfileApi(input: {
  method: string; path: string; query: URLSearchParams; caller?: string; service?: ProfileServerService; signal?: AbortSignal;
}): Promise<ApiResult | null> {
  if (input.path !== '/api/profile') return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    if (input.method !== 'GET') throw new ClarificationServiceError(405, 'invalid-response');
    if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
    for (const key of input.query.keys()) if (!['version', 'scope'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
    if (!input.service) throw new ClarificationServiceError(503, 'service-unavailable');
    return { status: 200, json: await input.service.snapshot(input.caller, { version: 1, scope: input.query.get('scope') }, input.signal) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError) return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
