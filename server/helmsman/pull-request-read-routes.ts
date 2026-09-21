import { PullRequestReadValidationError, type PullRequestReadKindV1 } from '../../src/plugins/pull-request-read';
import { TaskSourceValidationError } from '../../src/plugins/tasks';
import { PullRequestReadError, type PullRequestReadServerService } from './pull-request-read-service';
import type { ApiResult } from './router';

export async function handlePullRequestReadApi(input: { method: string; path: string; query: URLSearchParams; service?: PullRequestReadServerService; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (input.path !== '/api/pull-request-read') return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Pull request reads require GET' } };
  if (!input.service) return { status: 503, json: { error: 'Pull request reads unavailable' } };
  try {
    const limit = input.query.get('limit') ?? '25'; if (!/^[1-9]\d*$/.test(limit)) throw new PullRequestReadValidationError('Invalid page limit');
    return { status: 200, json: await input.service.list({ version: 1, repo: input.query.get('repo'), kind: (input.query.get('kind') ?? 'repo-open') as PullRequestReadKindV1, limit: Number(limit) }, input.signal) };
  } catch (error) {
    if (error instanceof PullRequestReadError) return { status: error.status, json: { error: error.message } };
    if (error instanceof PullRequestReadValidationError || error instanceof TaskSourceValidationError) return { status: 400, json: { error: 'Invalid pull request read request' } };
    return { status: 503, json: { error: 'Pull request reads unavailable' } };
  }
}
