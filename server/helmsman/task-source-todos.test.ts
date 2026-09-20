import { afterEach, describe, expect, it } from 'vitest';
import { todosProvider } from '../../src/plugins/todos/provider';
import { createSourceTodoApi } from './task-source-todos';
import { createTaskSourceService } from './task-source-service';
import { fixture, binding } from './task-sources/fixtures.test-support';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceRegistry } from './task-sources/registry';
import type { Persistence } from './persistence';
const opened: Persistence[] = [];
function setup() {
  const f = fixture('legacy-todos'); opened.push(f.persistence); const local = openLocalSourceAdapter(f.store);
  const registry = createTaskSourceRegistry({ eligible: () => true }); registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] }, todosProvider)]);
  const service = createTaskSourceService({ ...f, local, registry, http: () => { throw new Error('Unused HTTP'); } });
  return { ...f, local, service, api: createSourceTodoApi({ ...f, sourceId: f.source.id, service }) };
}
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
describe('Todo compatibility source facade', () => {
  it('replays creation, update and deletion after response loss with stable identities', async () => {
    const f = setup(); const data = { title: 'Task', repo: 'owner/project', description: 'Do work' };
    const task = await f.api.create(data, 'create'); expect((await f.api.create(data, 'create')).id).toBe(task.id);
    let loseResponse = true;
    const flaky = createSourceTodoApi({ ...f, sourceId: f.source.id, service: { ...f.service, async command(...args) { const result = await f.service.command(...args); if (loseResponse) { loseResponse = false; throw new Error('response lost'); } return result; } } });
    await expect(flaky.update(task.id, { title: 'Changed' }, 'update')).rejects.toThrow('response lost');
    expect((await f.api.update(task.id, { title: 'Changed' }, 'update'))?.title).toBe('Changed');
    loseResponse = true; await expect(flaky.remove(task.id, 'delete')).rejects.toThrow('response lost');
    expect(await f.api.remove(task.id, 'delete')).toBe(true); expect(await f.api.remove('TODO-999', 'missing')).toBe(false); expect(await f.api.list()).toHaveLength(0);
  });
  it('shows quarantined historical work without blocking unrelated Todos and preserves run links', async () => {
    const f = setup(); const task = await f.api.create({ title: 'Task', repo: 'owner/project', description: 'Do work' }, 'create');
    f.persistence.sql.prepare('UPDATE todos SET runId=? WHERE sequence=?').run('historical-run', Number(task.id.slice(5)));
    f.store.quarantine({ sourceId: f.source.id, externalId: task.id, displayKey: task.id, reason: 'retained old run', evidence: {} });
    expect((await f.api.list())[0]?.runId).toBe('historical-run');
    await expect(f.api.update(task.id, { title: 'Unsafe' }, 'edit')).rejects.toThrow(/quarantined/);
  });
  it('supports an explicitly authorized move and rejects request payload changes', async () => {
    const f = setup(); f.service.configure({ instanceId: f.instance.id, instanceRevision: 1, allowedRepos: ['owner/project', 'owner/second'] });
    const task = await f.api.create({ title: 'Task', repo: 'owner/project' }, 'create');
    expect((await f.api.update(task.id, { repo: 'owner/second' }, 'move'))?.repo).toBe('owner/second');
    await expect(f.api.update(task.id, { title: 'other' }, 'move')).rejects.toThrow(/identity changed/);
    await expect(f.api.update(task.id, { repo: 'owner/unauthorized' }, 'outside')).rejects.toThrow(/scope|authorized/);
  });
});
