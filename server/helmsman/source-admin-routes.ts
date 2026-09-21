import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { TaskSourceValidationError, parseTaskRepo } from '../../src/plugins/tasks';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import { SourceAdminAccessError, type SourceAdminServerService } from './source-admin-service';
import type { ApiResult } from './router';

export async function handleSourceAdminApi(input: { method: string; path: string; query: URLSearchParams; body?: unknown;
  caller?: string; service?: SourceAdminServerService; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (input.path !== '/api/source-admin' && !input.path.startsWith('/api/source-admin/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Source administration unavailable' } };
  if (!input.caller) return { status: 403, json: { error: 'Source administration caller required' } };
  try {
    if (input.path === '/api/source-admin') {
      if (input.method !== 'GET') return { status: 405, json: { error: 'Source administration snapshot requires GET' } };
      const repo = input.query.get('repo'); return { status: 200, json: input.service.snapshot(input.caller, repo === null ? null : parseTaskRepo(repo)) };
    }
    if (input.path === '/api/source-admin/validate' || input.path === '/api/source-admin/commands') {
      if (input.method !== 'POST') return { status: 405, json: { error: 'Source administration action requires POST' } };
      return { status: 200, json: input.path.endsWith('/validate') ? await input.service.validateReplacement(input.caller, input.body, input.signal ?? AbortSignal.timeout(30_000)) : input.service.submit(input.caller, input.body) };
    }
    const match = /^\/api\/source-admin\/commands\/([^/]+)$/.exec(input.path);
    if (!match) return { status: 404, json: { error: 'Source administration route not found' } };
    if (input.method !== 'GET') return { status: 405, json: { error: 'Source administration receipt requires GET' } };
    return { status: 200, json: input.service.receipt(input.caller, { repo: input.query.get('repo'), requestId: match[1] }) };
  } catch (error) {
    if (error instanceof SourceAdminAccessError) return { status: 403, json: { error: error.message } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Source administration authority or identity changed' } };
    if (error instanceof SourceContractValidationError || error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid source administration request' } };
    return { status: 503, json: { error: 'Source administration unavailable' } };
  }
}
