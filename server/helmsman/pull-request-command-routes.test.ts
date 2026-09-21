// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handlePullRequestCommandApi } from './pull-request-command-routes';
import { ClarificationServiceError } from './clarification-service-common';
import { PersistenceConflictError } from './persistence';
import type { PullRequestCommandServerService } from './pull-request-command-service';
const command = { version: 1, requestId: '12345678-1234-4123-8123-123456789abc', repo: 'org/repo', number: 12,
  expectedHeadSha: 'a'.repeat(40), event: 'APPROVE', body: '' };
function fixture() {
  const service = { submit: vi.fn(async () => ({ status: 'pending' })), retry: vi.fn(async () => ({ status: 'recovery-required' })), receipt: vi.fn(() => null) };
  const route = (patch: Partial<Parameters<typeof handlePullRequestCommandApi>[0]> = {}) => handlePullRequestCommandApi({
    method: 'POST', path: '/api/pull-request-command', query: new URLSearchParams(), caller: 'example.pr/panel',
    body: { command, scopeRepo: command.repo }, service: service as unknown as PullRequestCommandServerService, ...patch });
  return { service, route };
}
it('keeps caller and explicit scope on submit and query-only retry', async () => {
  const f = fixture(); expect(await f.route()).toEqual({ status: 200, json: { status: 'pending' } });
  expect(f.service.submit).toHaveBeenCalledWith('example.pr/panel', command, command.repo);
  const query = { repo: command.repo, requestId: command.requestId };
  expect((await f.route({ path: '/api/pull-request-command/retry', body: { query, scopeRepo: null } }))?.status).toBe(200);
  expect(f.service.retry).toHaveBeenCalledWith('example.pr/panel', query, null);
  expect((await f.route({ method: 'GET', path: `/api/pull-request-command/receipts/${command.requestId}`, query: new URLSearchParams({ repo: command.repo }) }))?.json).toBeNull();
});
it('fails missing caller, wrong methods and ambiguous or malformed inputs before service calls', async () => {
  const f = fixture(); expect((await f.route({ caller: undefined }))?.status).toBe(403);
  expect((await f.route({ method: 'GET' }))?.status).toBe(405);
  expect((await f.route({ body: { command } }))?.status).toBe(400);
  expect((await f.route({ query: new URLSearchParams('repo=org/repo&repo=other/repo') }))?.status).toBe(400);
  expect((await f.route({ body: { command: { ...command, actor: 'forged' }, scopeRepo: null } }))?.status).toBe(400);
  expect(f.service.submit).not.toHaveBeenCalled();
});
it('preserves conflict and unknown-retry outcomes without exposing internal details', async () => {
  const f = fixture(); f.service.submit.mockRejectedValue(new PersistenceConflictError('private evidence'));
  expect(await f.route()).toEqual({ status: 409, json: { reason: 'conflict' } });
  f.service.retry.mockRejectedValue(new ClarificationServiceError(404, 'not-found'));
  expect(await f.route({ path: '/api/pull-request-command/retry', body: { query: { repo: command.repo, requestId: command.requestId }, scopeRepo: null } }))
    .toEqual({ status: 404, json: { reason: 'not-found' } });
});
