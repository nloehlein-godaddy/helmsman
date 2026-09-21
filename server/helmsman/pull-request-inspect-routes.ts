import { PullRequestInspectValidationError } from '../../src/plugins/pull-request-inspect';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PullRequestInspectError } from './pull-request-inspect-service';
import type { PullRequestInspectServerService } from './pull-request-inspect-service';
import type { ApiResult } from './router';

export async function handlePullRequestInspectApi(input: { method: string; path: string; query: URLSearchParams; service?: PullRequestInspectServerService; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (!['/api/pull-request-inspect/detail', '/api/pull-request-inspect/diff'].includes(input.path)) return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Pull request inspection requires GET' } };
  if (!input.service) return { status: 503, json: { reason: 'service-unavailable' } };
  try {
    const allowed = input.path.endsWith('/detail') ? ['repo', 'number'] : ['repo', 'number', 'headSha', 'baseSha'];
    for (const key of input.query.keys()) if (!allowed.includes(key) || input.query.getAll(key).length !== 1) throw new PullRequestInspectValidationError('Invalid inspection query field');
    const repo = input.query.get('repo') ?? ''; const rawNumber = input.query.get('number') ?? '';
    if (!/^[1-9]\d*$/.test(rawNumber)) throw new PullRequestInspectValidationError('Invalid pull request number');
    const number = Number(rawNumber);
    const value = input.path.endsWith('/detail') ? await input.service.detail({ version: 1, repo, number }, input.signal)
      : await input.service.diff({ version: 1, target: { repo, number, headSha: input.query.get('headSha') ?? '', baseSha: input.query.get('baseSha') ?? '' } }, input.signal);
    return { status: 200, json: value };
  } catch (error) {
    if (error instanceof PullRequestInspectError) return { status: error.status, json: { reason: error.reason } };
    if (error instanceof PullRequestInspectValidationError || error instanceof TaskSourceValidationError) return { status: 400, json: { error: 'Invalid pull request inspection query' } };
    return { status: 503, json: { reason: 'service-unavailable' } };
  }
}
