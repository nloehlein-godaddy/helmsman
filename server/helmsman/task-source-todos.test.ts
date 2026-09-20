import { afterEach, describe, expect, it } from 'vitest';
import { todosProvider } from '../../src/plugins/todos/provider';
import { createSourceTodoApi, SourceTodoRejectedError } from './task-source-todos';
import { createTaskSourceService } from './task-source-service';
import { fixture, binding } from './task-sources/fixtures.test-support';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceRegistry } from './task-sources/registry';
import type { Persistence } from './persistence';
const opened: Persistence[] = [];
function setup(provider = todosProvider) {
  const f = fixture('legacy-todos'); opened.push(f.persistence); const local = openLocalSourceAdapter(f.store);
  const registry = createTaskSourceRegistry({ eligible: () => true }); registry.publish([registry.stage(binding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] }, provider)]);
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
    await expect(f.api.update(task.id, { repo: 'owner/unauthorized' }, 'outside')).rejects.toMatchObject({ requestId: 'outside', commandId: 'update' });
    expect((await f.api.get(task.id))?.repo).toBe('owner/second');
  });
});

it('records a definite rejection and permits a new request after task changes without reusing stale intent', async () => {
  const f = setup(); const task = await f.api.create({ title: 'Initial', repo: 'owner/project' }, 'create');
  const claim = f.store.reserveWork({ ref: { sourceId: f.source.id, externalId: task.id }, admissionId: 'run', runId: 'run', instanceId: f.instance.id, expectedSourceRevision: 1, expectedInstanceRevision: 1 });
  await expect(f.api.update(task.id, { title: 'Wanted' }, 'rejected')).rejects.toMatchObject({ requestId: 'rejected', commandId: 'update' });
  f.store.beginSettlement(claim.id, claim.revision);
  f.store.settleWork({ claimId: claim.id, expectedRevision: 2, disposition: 'released', reason: 'cancelled', localRecordRevision: null, operations: [] });
  await f.api.update(task.id, { description: 'Changed in another tab' }, 'other-tab');
  const reopened = createSourceTodoApi({ ...f, sourceId: f.source.id });
  await expect(reopened.update(task.id, { title: 'Wanted' }, 'rejected')).rejects.toBeInstanceOf(SourceTodoRejectedError);
  await expect(reopened.update(task.id, { title: 'Changed identity' }, 'rejected')).rejects.toThrow('identity changed');
  expect((await reopened.update(task.id, { title: 'Wanted' }, 'new-request'))?.title).toBe('Wanted');
});
it('fences a late concurrent preparation after the same request was durably rejected', async () => {
  let release!: () => void; let started!: () => void; let count = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prepared = new Promise<void>(resolve => { started = resolve; });
  const original = todosProvider.commands!.update!;
  const f = setup({ ...todosProvider, commands: { ...todosProvider.commands, update: { ...original, async prepare(input, context) {
    if (++count === 1) { started(); await held; } else if (count === 2) throw new Error('Provider rejected another simultaneous invocation');
    return original.prepare(input, context);
  } } } });
  const task = await f.api.create({ title: 'Initial', repo: 'owner/project' }, 'create');
  const late = f.api.update(task.id, { title: 'Changed' }, 'same-request'); const lateResult = Promise.resolve(late).catch((error: unknown) => error);
  await prepared;
  await expect(f.api.update(task.id, { title: 'Changed' }, 'same-request')).rejects.toBeInstanceOf(SourceTodoRejectedError);
  release(); expect(await lateResult).toBeInstanceOf(SourceTodoRejectedError);
  expect((await f.api.get(task.id))?.title).toBe('Initial');
  expect(f.persistence.sql.prepare('SELECT id FROM source_commands WHERE id=?').get('same-request')).toBeUndefined();
  expect((await f.api.update(task.id, { title: 'Changed' }, 'fresh-request'))?.title).toBe('Changed');
});
it('never records definite rejection when the host command committed before response loss', async () => {
  const f = setup(); const task = await f.api.create({ title: 'Initial', repo: 'owner/project' }, 'create');
  const flaky = createSourceTodoApi({ ...f, sourceId: f.source.id, service: { ...f.service, async command(...args) { await f.service.command(...args); throw new Error('Response lost after commit'); } } });
  await expect(flaky.update(task.id, { title: 'Saved' }, 'saved-request')).rejects.not.toBeInstanceOf(SourceTodoRejectedError);
  expect(f.persistence.sql.prepare('SELECT result FROM source_todo_commands WHERE id=?').get('saved-request')).toEqual({ result: null });
  expect((await f.api.update(task.id, { title: 'Saved' }, 'saved-request'))?.title).toBe('Saved');
});
