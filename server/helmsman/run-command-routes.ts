import { parseRunCommandReceiptQueryV1, parseRunCommandV1, RunCommandValidationError } from '../../src/plugins/run-command';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { RunCommandError, RunCommandRejection, type RunCommandServerService } from './run-command-coordinator';
import type { ApiResult } from './router';

export async function handleRunCommandApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown;
  caller?: string; service?: RunCommandServerService }): Promise<ApiResult | null> {
  if (input.path !== '/api/run-commands' && !input.path.startsWith('/api/run-commands/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Run commands unavailable' } };
  if (!input.caller) return { status: 403, json: { error: 'Run command caller required' } };
  try {
    if (input.path === '/api/run-commands') {
      if (input.method !== 'POST') return { status: 405, json: { error: 'Run command submission requires POST' } };
      return { status: 200, json: await input.service.submit(input.caller, parseRunCommandV1(input.body)) };
    }
    const match = /^\/api\/run-commands\/([^/]+)$/.exec(input.path);
    if (!match) return { status: 404, json: { error: 'Run command route not found' } };
    if (input.method !== 'GET') return { status: 405, json: { error: 'Run command receipts require GET' } };
    const query = parseRunCommandReceiptQueryV1({ requestId: match[1], repo: input.query.get('repo') });
    return { status: 200, json: input.service.receipt(input.caller, query) };
  } catch (error) {
    if (error instanceof RunCommandError) return { status: error.status, json: { error: error.message } };
    if (error instanceof RunCommandRejection) return { status: 403, json: { error: error.message } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Run command identity or ownership conflict' } };
    if (error instanceof RunCommandValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) {
      return { status: 400, json: { error: 'Invalid run command request' } };
    }
    return { status: 503, json: { error: 'Run commands unavailable' } };
  }
}
