import { parseSourceCommandReceiptQueryV1, parseSourceCommandV1 } from '../../src/plugins/source-command';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { SourceCommandAccessError, type SourceCommandServerService } from './source-command-coordinator';
import type { ApiResult } from './router';

export async function handleSourceCommandApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown;
  caller?: string; service?: SourceCommandServerService }): Promise<ApiResult | null> {
  if (input.path !== '/api/source-commands' && !input.path.startsWith('/api/source-commands/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Source commands unavailable' } };
  if (!input.caller) return { status: 403, json: { error: 'Source command caller required' } };
  try {
    if (input.path === '/api/source-commands') {
      if (input.method !== 'POST') return { status: 405, json: { error: 'Source command submission requires POST' } };
      return { status: 200, json: await input.service.submit(input.caller, parseSourceCommandV1(input.body)) };
    }
    const match = /^\/api\/source-commands\/([^/]+)$/.exec(input.path);
    if (!match) return { status: 404, json: { error: 'Source command route not found' } };
    if (input.method !== 'GET') return { status: 405, json: { error: 'Source command receipts require GET' } };
    return { status: 200, json: input.service.receipt(input.caller, parseSourceCommandReceiptQueryV1({ requestId: match[1], repo: input.query.get('repo') })) };
  } catch (error) {
    if (error instanceof SourceCommandAccessError) return { status: 403, json: { error: error.message } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Source command identity or ownership conflict' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid source command request' } };
    return { status: 503, json: { error: 'Source commands unavailable' } };
  }
}
