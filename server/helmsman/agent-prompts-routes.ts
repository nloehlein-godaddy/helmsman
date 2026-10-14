import type { AgentPromptSettingsSnapshotV1 } from '../../src/plugins/agent-prompts';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { ClarificationServiceError } from './clarification-service-common';
import { PersistenceConflictError } from './persistence';
import type { ApiResult } from './router';

export interface AgentPromptSettingsServerService {
  snapshot(caller: string): AgentPromptSettingsSnapshotV1;
  save(caller: string, input: unknown): Promise<AgentPromptSettingsSnapshotV1>;
}
export async function handleAgentPromptSettingsApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: AgentPromptSettingsServerService }): Promise<ApiResult | null> {
  if (input.path !== '/api/agent-prompts') return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  if (input.query.size || !['GET', 'POST'].includes(input.method)) return { status: 400, json: { reason: 'invalid-response' } };
  try {
    if (!input.service) throw new ClarificationServiceError(503, 'service-unavailable');
    return { status: 200, json: input.method === 'GET' ? input.service.snapshot(input.caller) : await input.service.save(input.caller, input.body) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { reason: 'conflict' } };
    return { status: error instanceof SourceContractValidationError ? 400 : 503, json: { reason: error instanceof SourceContractValidationError ? 'invalid-response' : 'service-unavailable' } };
  }
}
