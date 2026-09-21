import { RunReadValidationError } from '../../src/plugins/run-read';
import { RunInspectValidationError } from '../../src/plugins/run-inspect';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { RunInspectError } from './run-inspect-service';
import type { RunInspectServerService } from './run-inspect-service';
import type { ApiResult } from './router';

export function runInspectFailure(error: unknown): ApiResult {
  if (error instanceof RunInspectError) return { status: error.status, json: { error: error.reason } };
  if (error instanceof RunInspectValidationError || error instanceof RunReadValidationError || error instanceof TaskSourceValidationError || error instanceof RangeError) return { status: 400, json: { error: 'invalid-response' } };
  return { status: 503, json: { error: 'service-unavailable' } };
}
export function runInspectTarget(runId: string, query: URLSearchParams) {
  const attempt = query.get('expectedAttempt');
  if (!attempt || !/^[1-9]\d*$/.test(attempt)) throw new RunInspectValidationError('Invalid attempt');
  return { repo: query.get('repo') as string, runId, expectedAttempt: Number(attempt) };
}
export function handleRunInspectApi(input: { method: string; path: string; query: URLSearchParams; service?: RunInspectServerService }): ApiResult | null {
  if (input.path !== '/api/run-inspect' && !input.path.startsWith('/api/run-inspect/')) return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Run inspection requires GET' } };
  if (!input.service) return { status: 503, json: { error: 'service-unavailable' } };
  try {
    const { service, query } = input;
    const limit = (fallback: number) => { const value = query.get('limit') ?? String(fallback); if (!/^[1-9]\d*$/.test(value)) throw new RunInspectValidationError('Invalid limit'); return Number(value); };
    if (input.path === '/api/run-inspect/resolve') return { status: 200, json: service.resolve({ version: 1, repo: query.get('repo'), runId: query.get('runId') as string }) };
    if (input.path === '/api/run-inspect/history') return { status: 200, json: service.history({ version: 1, repo: query.get('repo'),
      kind: (query.get('kind') ?? 'all') as 'all' | 'running' | 'terminal', cursor: query.get('cursor'), limit: limit(25) }) };
    const match = /^\/api\/run-inspect\/([a-z\d_-]{1,128})\/log$/i.exec(input.path);
    if (!match) return { status: 404, json: { error: 'not-found' } };
    return { status: 200, json: service.log({ version: 1, target: runInspectTarget(match[1]!, query), scopeRepo: query.get('scopeRepo'),
      direction: query.get('direction') as 'backward' | 'forward', cursor: query.get('cursor'), limit: limit(50) }) };
  } catch (error) { return runInspectFailure(error); }
}
