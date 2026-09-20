// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { todosProvider } from '../src/plugins/todos/provider';
import { createTaskSourceService } from './helmsman/task-source-service';
import { createTaskSourceRegistry } from './helmsman/task-sources/registry';
import { fixture, binding } from './helmsman/task-sources/fixtures.test-support';
import { openLocalSourceAdapter } from './helmsman/task-sources/local-records';
import { writeTaskSource } from './helmsman/task-sources/store';
import { buildDashboardResponse } from './dashboard-endpoint';
import type { Persistence } from './helmsman/persistence';

const opened: Persistence[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
it('discovers coexisting sources through public providers with canonical launch identity and no legacy Jira calls', async () => {
  const f = fixture(); opened.push(f.persistence);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] }, todosProvider)]);
  const second = f.store.provision({ ...f.input, provisioningKey: 'second', identityEvidence: { ...f.input.identityEvidence,
    authority: { ...f.input.identityEvidence.authority, authorityId: '00000000-0000-4000-8000-000000000003' } }, collectionId: '00000000-0000-4000-8000-000000000003' });
  f.persistence.transaction(() => writeTaskSource(f.store, { ...second.source, conversionReady: true }));
  const service = createTaskSourceService({ store: f.store, registry, local: openLocalSourceAdapter(f.store), http: () => { throw new Error('HTTP unavailable'); } });
  for (const instance of [f.instance, second.instance]) await service.command({ instanceId: instance.id, instanceRevision: 1, repo: 'owner/project', commandId: 'create', requestId: instance.id, input: { title: instance.id, description: 'Implement', repo: 'owner/project' } }, AbortSignal.timeout(1000));
  const forbidden = vi.fn().mockRejectedValue(new Error('Legacy task query'));
  const deps = { fetchQueueIssues: forbidden, fetchActiveIssues: forbidden, fetchMineOpenIssues: forbidden, fetchAuthoredPrs: async () => [], fetchOpenAuthoredPrs: async () => [], loadMock: forbidden };
  const read = (repo: string) => buildDashboardResponse({}, new Date(), deps, repo, [], { service, jiraEnabled: true });
  const response = await read('owner/project');
  expect(response.snapshot.queue).toHaveLength(2);
  expect(new Set(response.snapshot.queue.map(task => task.source?.ref.sourceId)).size).toBe(2);
  expect(response.snapshot.queue.map(task => task.id)).toEqual(['TODO-1', 'TODO-1']);
  expect(response.snapshot.queue.map(task => task.source?.url)).toEqual([null, null]);
  expect(response.jiraEnabled).toBe(true);
  expect(forbidden).not.toHaveBeenCalled();
  expect((await read('other/project')).snapshot.queue).toEqual([]);
  service.configure({ instanceId: f.instance.id, instanceRevision: 1, desiredEnabled: false });
  const disabled = await read('owner/project');
  expect(disabled.snapshot.queue).toHaveLength(1);
  expect(disabled.snapshot.queue[0]?.source?.ref.sourceId).toBe(second.source.id);
});
