// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openOperationStore } from './operations';
import { openAdmissionStore } from './admission-store';
import { createRecoveryService } from './recovery-service';
import { createFeedbackCommandService, type FeedbackCommandOptions } from './feedback-command-service';
import { createGithubFeedbackTracker } from '../../src/plugins/feedback-github/provider';
import type { FeedbackCommandV1 } from '../../src/plugins/feedback-command';
import type { FeedbackHttpV1, FeedbackTrackerProviderV1 } from '../../src/plugins/feedback-tracker';
const databases: Persistence[] = []; afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const caller = 'example.feedback/page';
async function fixture() {
  const persistence = openPersistence(':memory:'); databases.push(persistence); const executions = openExecutionStore(persistence); const operations = openOperationStore(persistence, executions);
  const settings = { enabled: true, repository: 'org/app', labels: 'feedback' }; const provider = createGithubFeedbackTracker(settings);
  let selected = true; let fail = false; let issue: unknown = null; let posts = 0;
  const request = vi.fn<FeedbackHttpV1['request']>(async input => {
    if (input.path === '/user') return { status: 200, body: { login: 'tester' } };
    if (input.method === 'POST') { posts++; issue = { ...(input.body as object), number: 7, html_url: 'https://github.com/org/app/issues/7', user: { login: 'tester' } }; if (fail) throw new Error('lost response'); return { status: 201, body: issue }; }
    if (input.path === '/search/issues') return { status: 200, body: { incomplete_results: false, total_count: issue ? 1 : 0, items: issue ? [{ number: 7 }] : [] } };
    return { status: 200, body: issue };
  });
  const binding: import('./execution-store').ProviderBinding = { role: 'effect', capability: 'helmsman/feedback-tracker', contractVersion: 1, contributionId: 'example.tracker/issues', pluginId: 'example.tracker', artifactHash: 'a'.repeat(64), connectionId: 'github:test', credentialHandle: 'github:test' };
  const options: FeedbackCommandOptions = { persistence, operations, repos: () => ['org/project'], authorize: value => { if (value !== caller) throw new Error('forbidden'); },
    capture: () => selected ? { binding, artifacts: [{ pluginId: binding.pluginId, artifactHash: binding.artifactHash, packageVersion: '1', requires: [] }], settings, provider, assertCurrent() { if (!selected) throw new Error('changed'); } } : null,
    verifyArtifacts: async () => {}, http: () => ({ request }), retained: async (_operation, retainedSettings) => ({ provider: createGithubFeedbackTracker(retainedSettings), dispose: async () => {} }), authorizeDelivery: async () => ({ allowed: true }) };
  const service = createFeedbackCommandService(options); const expectedDestination = await service.destination(caller); if (!expectedDestination) throw new Error('missing destination');
  const command: FeedbackCommandV1 = { version: 1, draftId: '12345678-1234-4123-8123-123456789abc', requestId: '22345678-1234-4123-8123-123456789abc', title: 'Feedback bug', body: 'Reproduction steps', context: { version: '1', repo: 'org/project', page: 'feedback' }, expectedDestination };
  return { options, service, command, persistence, executions, operations, request, posts: () => posts, fail: () => { fail = true; }, disable: () => { selected = false; }, forgetIssue: () => { issue = null; } };
}
it('creates one issue and returns the same receipt for duplicate submissions', async () => {
  const f = await fixture(); const result = await f.service.submit(caller, f.command, 'org/project');
  expect(result).toMatchObject({ status: 'succeeded', result: { id: '7' } });
  expect(await f.service.submit(caller, f.command, 'org/project')).toEqual(result); expect(f.posts()).toBe(1);
  expect(JSON.stringify(f.request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body)).toContain('helmsman-feedback:');
  await expect(f.service.submit(caller, { ...f.command, body: 'changed' }, 'org/project')).rejects.toThrow();
});
it('reconciles a lost response after service restart and provider disable with original settings', async () => {
  const f = await fixture(); f.fail(); expect(await f.service.submit(caller, f.command, 'org/project')).toMatchObject({ status: 'recovery-required' }); f.disable();
  const restored = createFeedbackCommandService(f.options);
  expect(await restored.destination(caller)).toBeNull(); expect(await restored.retry(caller, f.command, 'org/project')).toMatchObject({ status: 'succeeded' }); expect(f.posts()).toBe(1);
});
it('never creates again when exact-marker reconciliation finds nothing', async () => {
  const f = await fixture(); f.fail(); await f.service.submit(caller, f.command, 'org/project'); f.forgetIssue();
  for (let index = 0; index < 3; index++) expect(await f.service.retry(caller, f.command, 'org/project')).toMatchObject({ status: 'recovery-required' });
  expect(f.posts()).toBe(1);
});
it.each(['org/project', null])('recovers lost feedback in its original %s scope without another creation', async repo => {
  const f = await fixture(); f.fail();
  const command = { ...f.command, context: { ...f.command.context, repo } };
  expect(await f.service.submit(caller, command, repo)).toMatchObject({ status: 'recovery-required' });
  const operation = f.operations.list()[0]!;
  expect(operation.target).toMatchObject({ repo, providerTarget: { destination: { id: f.command.expectedDestination.id } } });
  const resolveOperation = vi.fn((id: string, resolution: Parameters<typeof f.operations.resolve>[1]) => { f.operations.resolve(id, resolution); });
  const recovery = createRecoveryService({ db: { activeRuns: () => [], getRun: () => null }, executions: f.executions,
    admissions: openAdmissionStore(f.persistence, f.executions), operations: f.operations, lifecycle: { list: () => [] },
    callbacks: { reconcileOperation: async id => { await f.service.dispatch(id); }, resolveOperation } });
  expect(recovery.snapshot(repo).operations).toMatchObject([{ id: operation.id, status: 'uncertain', actions: ['reconcile-operation', 'resolve-operation'] }]);
  expect(recovery.snapshot(repo).pins).toMatchObject([{ kind: 'operation', ownerId: operation.id }]);
  expect(recovery.snapshot('org/app').operations).toEqual([]);
  expect(recovery.snapshot('other/project').operations).toEqual([]);
  if (repo === null) expect(recovery.snapshot('org/project').operations).toEqual([]);
  await expect(recovery.act({ action: 'resolve-operation', id: operation.id, outcome: 'acknowledged', actor: 'operator', reason: 'Observed issue', evidence: { note: 'Incomplete receipt' } })).rejects.toMatchObject({ status: 409 });
  expect(resolveOperation).not.toHaveBeenCalled();
  expect(f.service.receipt(caller, { requestId: command.requestId, repo }, repo)?.status).toBe('recovery-required');
  await recovery.act({ action: 'reconcile-operation', id: operation.id });
  expect(f.service.receipt(caller, { requestId: command.requestId, repo }, repo)).toMatchObject({ status: 'succeeded', result: { id: '7', url: 'https://github.com/org/app/issues/7' } });
  expect(f.posts()).toBe(1);
});
it('prevents duplicate mutation from a provider and disallows reconciliation writes', async () => {
  const f = await fixture(); const create = createGithubFeedbackTracker({ enabled: true, repository: 'org/app', labels: 'feedback' });
  const malicious: FeedbackTrackerProviderV1 = { ...create, async invokeSubmission(input, context) { await context.http.request(input.request); await context.http.request(input.request); return { status: 'unknown', reason: 'unconfirmed', evidence: {} }; }, async reconcileSubmission(input, context) { await context.http.request(input.request); return { status: 'unknown', reason: 'unconfirmed', evidence: {} }; } };
  f.options.retained = async () => ({ provider: malicious, dispose: async () => {} });
  const service = createFeedbackCommandService(f.options); expect(await service.submit(caller, f.command, 'org/project')).toMatchObject({ status: 'recovery-required' });
  await service.retry(caller, f.command, 'org/project'); expect(f.posts()).toBe(1);
});
it('rejects destination drift before enqueue and keeps caller/scope boundaries', async () => {
  const f = await fixture(); await expect(f.service.submit(caller, { ...f.command, expectedDestination: { ...f.command.expectedDestination, revision: 'b'.repeat(64) } }, 'org/project')).rejects.toThrow(); expect(f.operations.list()).toHaveLength(0);
  await expect(f.service.submit(caller, f.command, 'other/repo')).rejects.toThrow(); await expect(f.service.submit('example.other/page', f.command, 'org/project')).rejects.toThrow(); expect(f.posts()).toBe(0);
});
it('projects a definite GitHub rejection as terminal and never resends that request', async () => {
  const f = await fixture(); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => input.method === 'POST' ? { status: 422, body: { message: 'Validation Failed' } } : original(input));
  expect(await f.service.submit(caller, f.command, 'org/project')).toMatchObject({ status: 'rejected', reason: 'GitHub rejected issue creation (422).' });
  expect(await f.service.retry(caller, f.command, 'org/project')).toMatchObject({ status: 'rejected' });
  expect(f.request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(1);
});
