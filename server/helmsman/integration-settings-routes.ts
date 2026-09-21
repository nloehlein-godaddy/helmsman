import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { ClarificationServiceError } from './clarification-service-common';
import type { IntegrationSettingsServerService } from './integration-settings-service';
import type { ApiResult } from './router';

export function handleIntegrationSettingsApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown; caller?: string; service?: IntegrationSettingsServerService }): ApiResult | null {
  if (!['/api/github-settings', '/api/jira-settings', '/api/jira-settings/token'].includes(input.path)) return null;
  if (!input.caller) return { status: 403, json: { reason: 'forbidden' } };
  try {
    const service = input.service; if (!service) throw new ClarificationServiceError(503, 'service-unavailable');
    if (input.method === 'GET' && input.path !== '/api/jira-settings/token') {
      if (input.query.get('version') !== '1') throw new ClarificationServiceError(400, 'invalid-response');
      for (const key of input.query.keys()) if (!['version', 'scope'].includes(key) || input.query.getAll(key).length !== 1) throw new ClarificationServiceError(400, 'invalid-response');
      const value = { version: 1, scope: input.query.get('scope') };
      return { status: 200, json: input.path === '/api/github-settings' ? service.githubSnapshot(input.caller, value) : service.jiraSnapshot(input.caller, value) };
    }
    if (input.method !== 'POST' || input.path === '/api/jira-settings') throw new ClarificationServiceError(405, 'invalid-response');
    if (input.query.size) throw new ClarificationServiceError(400, 'invalid-response');
    return { status: 200, json: input.path === '/api/github-settings' ? service.saveGithub(input.caller, input.body) : service.rotateJiraToken(input.caller, input.body) };
  } catch (error) {
    if (error instanceof ClarificationServiceError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof SyntaxError || error instanceof RangeError) return { status: 400, json: { reason: 'invalid-response' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
