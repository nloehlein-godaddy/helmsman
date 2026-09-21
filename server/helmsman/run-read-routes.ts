import { RunReadValidationError } from '../../src/plugins/run-read';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { RunReadError } from './run-read-service';
import type { RunReadServerService } from './run-read-service';
import type { ApiResult } from './router';

export function handleRunReadApi(input: { method: string; path: string; query: URLSearchParams; service?: RunReadServerService }): ApiResult | null {
  if (input.path !== '/api/run-read' && !input.path.startsWith('/api/run-read/')) return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Run reads require GET' } };
  if (!input.service) return { status: 503, json: { error: 'Run reads unavailable' } };
  try {
    const { query, service } = input;
    const limit = (fallback: number) => {
      const value = query.get('limit') ?? String(fallback);
      if (!/^[1-9]\d*$/.test(value)) throw new RunReadValidationError('Invalid run page limit');
      return Number(value);
    };
    if (input.path === '/api/run-read') return { status: 200, json: service.list({ version: 1, repo: query.get('repo'),
      kind: (query.get('kind') ?? 'all') as 'running' | 'terminal' | 'all', limit: limit(25), cursor: query.get('cursor') }) };
    const match = /^\/api\/run-read\/([a-z\d_-]{1,128})(\/log)?$/i.exec(input.path);
    if (!match) return { status: 404, json: { error: 'Run read route not found' } };
    const request = { version: 1 as const, runId: match[1]!, repo: query.get('repo') as string };
    return { status: 200, json: match[2] ? service.log({ ...request, limit: limit(50), cursor: query.get('cursor') }) : service.load(request) };
  } catch (error) {
    if (error instanceof RunReadError) return { status: error.status, json: { error: error.message } };
    if (error instanceof RunReadValidationError || error instanceof TaskSourceValidationError || error instanceof RangeError) return { status: 400, json: { error: 'Invalid run read request' } };
    return { status: 503, json: { error: 'Run reads unavailable' } };
  }
}
